// PDF fetch + disk-streaming helpers for the SJTU literature downloader.
//
// All functions take proxy + target explicitly so they work regardless of
// which script calls them. Bytes are fetched inside the page's authenticated
// context via fetch(), then transferred to Node in base64 chunks and written
// to disk. This is the same approach as the original code but:
//  - deduplicated (fetchToFile / fetchAnyToFile share fetchToBuffer + streamToDisk)
//  - window variable is randomized + deleted after use (avoids multi-tab collisions)
//  - maxBytes guard prevents OOM on huge files
//  - requirePdf flag controls %PDF head validation

import fs from "node:fs";
import dns from "node:dns/promises";
import net from "node:net";
import path from "node:path";
import { evalJs } from "./cdp-utils.mjs";
import { STATUS } from "./status-codes.mjs";

const DEFAULT_MAX_BYTES = 200 * 1024 * 1024; // 200 MB guard
const DEFAULT_CHUNK = 1048576; // 1 MB per base64 round-trip
const BLOCKED_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata",
  "metadata.aws.internal",
  "metadata.google.internal",
]);

function isUnsafeIpv4(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && [0, 2].includes(c))
    || (a === 192 && b === 168)
    || (a === 198 && [18, 19].includes(b))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

function isUnsafeAddress(address) {
  const value = String(address || "").toLowerCase().replace(/^\[|\]$/g, "");
  const version = net.isIP(value);
  if (version === 4) return isUnsafeIpv4(value);
  if (version !== 6) return true;
  if (value.startsWith("::ffff:")) return true;
  return value === "::"
    || value === "::1"
    || value.startsWith("fc")
    || value.startsWith("fd")
    || /^fe[89ab]/.test(value)
    || value.startsWith("2001:db8")
    || value.startsWith("ff");
}

export async function validatePublicDownloadUrl(
  value,
  { lookupImpl = dns.lookup } = {}
) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: "malformed_url" };
  }
  if (!["http:", "https:"].includes(url.protocol)) return { ok: false, reason: "scheme_not_allowed" };
  if (url.port && !["80", "443"].includes(url.port)) return { ok: false, reason: "port_not_allowed" };
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return { ok: false, reason: "empty_host" };
  if (BLOCKED_HOSTS.has(host)) return { ok: false, reason: "blocked_host" };
  if (net.isIP(host)) {
    return isUnsafeAddress(host) ? { ok: false, reason: "private_ip" } : { ok: true };
  }
  try {
    const resolved = await lookupImpl(host, { all: true, verbatim: true });
    const addresses = Array.isArray(resolved) ? resolved : [resolved];
    if (!addresses.length || addresses.some((item) => isUnsafeAddress(item?.address || item))) {
      return { ok: false, reason: "private_ip" };
    }
  } catch {
    return { ok: false, reason: "dns_error" };
  }
  return { ok: true };
}

/**
 * Check if a byte array starts with the %PDF signature.
 */
export function isPdfHead(bytes) {
  if (!bytes || bytes.length < 5) return false;
  const head = String.fromCharCode(...bytes.slice(0, 5));
  return head === "%PDF-";
}

export function isHtmlResponse({ contentType = "", head = [] } = {}) {
  if (/\b(?:text\/html|application\/xhtml\+xml)\b/i.test(contentType)) return true;
  const prefix = Buffer.from(head || []).toString("utf8").trimStart().toLowerCase();
  return prefix.startsWith("<!doctype html") || prefix.startsWith("<html") || prefix.startsWith("<head");
}

export function shouldRejectHtmlResponse(meta, rejectHtml = false) {
  return Boolean(rejectHtml && isHtmlResponse(meta));
}

/**
 * Fetch a URL inside the target tab's authenticated context.
 * Returns { ok, status, size, head, contentType, url } or { ok:false, err }.
 *
 * The bytes are stored in a randomized window variable to avoid collisions
 * when multiple tabs download concurrently.
 */
export async function fetchToBuffer(
  proxy,
  target,
  url,
  { requirePdf = true, maxBytes = DEFAULT_MAX_BYTES } = {}
) {
  // Random window var name so concurrent tabs don't clobber each other.
  const varName = `__sjtuPdf_${Math.random().toString(36).slice(2, 10)}`;
  const js = `(async()=>{try{
    const r=await fetch(${JSON.stringify(url)},{credentials:'include'});
    const ab=await r.arrayBuffer();
    const b=new Uint8Array(ab);
    if(b.length>${maxBytes}){return JSON.stringify({ok:false,err:'pdf_too_large',size:b.length});}
    window['${varName}']=b;
    return JSON.stringify({ok:r.ok,status:r.status,size:b.length,head:Array.from(b.slice(0,64)),contentType:r.headers.get('content-type')||'',contentDisposition:r.headers.get('content-disposition')||'',url:r.url||location.href});
  }catch(e){return JSON.stringify({ok:false,err:String(e).slice(0,200)})}})()`;
  const raw = await evalJs(proxy, target, js, 120000);
  const meta = JSON.parse(raw || "{}");

  if (!meta.ok || !meta.size) {
    return { ok: false, err: meta.err || "empty response", varName };
  }
  if (meta.err === "pdf_too_large") {
    return { ok: false, err: STATUS.PDF_TOO_LARGE, size: meta.size, varName };
  }
  if (requirePdf) {
    const headBytes = meta.head || [];
    if (!isPdfHead(headBytes)) {
      // Clean up the window var before returning.
      await evalJs(proxy, target, `delete window['${varName}']`).catch(() => {});
      return { ok: false, err: "not a PDF (head mismatch)", head: meta.head, varName };
    }
  }
  return {
    ok: true,
    status: meta.status,
    size: meta.size,
    head: meta.head,
    contentType: meta.contentType,
    contentDisposition: meta.contentDisposition,
    url: meta.url,
    varName,
  };
}

/**
 * Stream bytes from a window variable to disk in base64 chunks.
 * Deletes the window variable when done (or on error).
 */
export async function streamToDisk(
  proxy,
  target,
  varName,
  size,
  outPath,
  chunkSize = DEFAULT_CHUNK,
  onProgress
) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const ws = fs.createWriteStream(outPath);
  try {
    for (let s = 0; s < size; s += chunkSize) {
      const e = Math.min(s + chunkSize, size);
      const b64 = await evalJs(
        proxy,
        target,
        `(()=>{const b=window['${varName}'].slice(${s},${e});let x='';for(let i=0;i<b.length;i+=0x8000){x+=String.fromCharCode.apply(null,b.subarray(i,i+0x8000));}return btoa(x);})()`,
        60000
      );
      ws.write(Buffer.from(b64, "base64"));
      if (onProgress) onProgress(e, size);
    }
    await new Promise((r) => ws.end(r));
  } finally {
    // Always clean up the window var, even on error.
    await evalJs(proxy, target, `delete window['${varName}']`).catch(() => {});
  }
  return { file: outPath, bytes: size };
}

/**
 * Fetch a URL (requiring %PDF) and stream to disk.
 * Returns { ok:true, file, bytes } or { ok:false, err }.
 */
export async function fetchToFile(proxy, target, url, outPath, { onProgress, maxBytes } = {}) {
  const meta = await fetchToBuffer(proxy, target, url, { requirePdf: true, maxBytes });
  if (!meta.ok) return { ok: false, err: meta.err };
  const res = await streamToDisk(
    proxy,
    target,
    meta.varName,
    meta.size,
    outPath,
    DEFAULT_CHUNK,
    onProgress
  );
  return { ok: true, ...res };
}

/**
 * Stream a public PDF directly from Node. This avoids PDF Viewer page CORS
 * restrictions while preserving the same signature and size checks.
 */
export function uniqueFilePath(filePath, existsImpl = fs.existsSync) {
  if (!existsImpl(filePath)) return filePath;
  const parsed = path.parse(filePath);
  for (let counter = 1; counter < 10000; counter++) {
    const candidate = path.join(parsed.dir, `${parsed.name}-(${counter})${parsed.ext}`);
    if (!existsImpl(candidate)) return candidate;
  }
  throw new Error("unable to allocate a unique output filename");
}

function retryDelayMs(response, attempt, retryBaseMs) {
  const raw = String(response?.headers?.get("retry-after") || "").trim();
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Math.min(30000, Number(raw) * 1000);
  if (raw) {
    const target = Date.parse(raw);
    if (Number.isFinite(target)) return Math.min(30000, Math.max(0, target - Date.now()));
  }
  return Math.min(10000, retryBaseMs * (2 ** attempt));
}

async function fetchDirectOnce(
  url,
  outPath,
  { maxBytes, fetchImpl, validateUrlImpl, attempt, retryBaseMs }
) {
  let response;
  let currentUrl = url;
  try {
    for (let redirectCount = 0; redirectCount <= 5; redirectCount++) {
      const safety = await validateUrlImpl(currentUrl);
      if (!safety.ok) {
        return { ok: false, err: `unsafe_url:${safety.reason}`, retryable: false };
      }
      response = await fetchImpl(currentUrl, {
        redirect: "manual",
        headers: {
          Accept: "application/pdf,application/octet-stream;q=0.9,*/*;q=0.1",
          "User-Agent": "Mozilla/5.0 Cento/1.0 academic PDF downloader",
        },
        signal: AbortSignal.timeout(120000),
      });
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        if (redirectCount >= 5) {
          return { ok: false, err: "too_many_redirects", retryable: false };
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      break;
    }
  } catch (error) {
    return { ok: false, err: `network: ${String(error?.message || error)}`, retryable: true };
  }
  if (!response.ok || !response.body) {
    const retryable = [403, 429, 500, 502, 503, 504].includes(response.status);
    return {
      ok: false,
      err: `HTTP ${response.status}`,
      status: response.status,
      retryable,
      retryAfterMs: retryable ? retryDelayMs(response, attempt, retryBaseMs) : 0,
    };
  }
  const declaredSize = Number(response.headers.get("content-length") || 0);
  if (declaredSize > maxBytes) {
    return { ok: false, err: STATUS.PDF_TOO_LARGE, size: declaredSize, retryable: false };
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const tempPath = `${outPath}.part-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const stream = fs.createWriteStream(tempPath, { flags: "wx" });
  let bytes = 0;
  let head = Buffer.alloc(0);
  try {
    for await (const rawChunk of response.body) {
      const chunk = Buffer.from(rawChunk);
      bytes += chunk.length;
      if (bytes > maxBytes) throw new Error(STATUS.PDF_TOO_LARGE);
      if (head.length < 8) head = Buffer.concat([head, chunk]).subarray(0, 8);
      if (!stream.write(chunk)) await new Promise((resolve) => stream.once("drain", resolve));
    }
    await new Promise((resolve, reject) => {
      stream.end(resolve);
      stream.once("error", reject);
    });
    if (!isPdfHead(head)) throw new Error("not a PDF (head mismatch)");
    fs.renameSync(tempPath, outPath);
    return {
      ok: true,
      file: outPath,
      bytes,
      contentType: response.headers.get("content-type") || "",
      finalUrl: response.url || currentUrl,
      retryable: false,
    };
  } catch (error) {
    stream.destroy();
    fs.rmSync(tempPath, { force: true });
    const message = String(error?.message || error);
    return {
      ok: false,
      err: message,
      retryable: message !== "not a PDF (head mismatch)" && message !== STATUS.PDF_TOO_LARGE,
    };
  }
}

export async function fetchDirectToFile(
  url,
  outPath,
  {
    maxBytes = DEFAULT_MAX_BYTES,
    fetchImpl = fetch,
    validateUrlImpl = validatePublicDownloadUrl,
    maxRetries = 1,
    retryBaseMs = 500,
    sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {}
) {
  let lastResult = { ok: false, err: "download not attempted", retryable: false };
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    lastResult = await fetchDirectOnce(url, outPath, {
      maxBytes,
      fetchImpl,
      validateUrlImpl,
      attempt,
      retryBaseMs,
    });
    if (lastResult.ok) return { ...lastResult, attempts: attempt + 1 };
    if (!lastResult.retryable || attempt >= maxRetries) {
      return { ...lastResult, attempts: attempt + 1 };
    }
    await sleepImpl(lastResult.retryAfterMs ?? Math.min(10000, retryBaseMs * (2 ** attempt)));
  }
  return lastResult;
}

/**
 * Like fetchToFile but accepts any binary (SI can be jpg/xlsx/docx — not PDF).
 * Returns { ok:true, bytes } or { ok:false, err }.
 */
export async function fetchAnyToFile(proxy, target, url, outPath, { onProgress, maxBytes, rejectHtml = false } = {}) {
  const meta = await fetchToBuffer(proxy, target, url, { requirePdf: false, maxBytes });
  if (!meta.ok) return { ok: false, err: meta.err };
  if (shouldRejectHtmlResponse(meta, rejectHtml)) {
    await evalJs(proxy, target, `delete window['${meta.varName}']`).catch(() => {});
    return { ok: false, err: "HTML response rejected" };
  }
  const resolvedOutPath = typeof outPath === "function" ? outPath(meta) : outPath;
  const res = await streamToDisk(
    proxy,
    target,
    meta.varName,
    meta.size,
    resolvedOutPath,
    DEFAULT_CHUNK,
    onProgress
  );
  return {
    ok: true,
    file: res.file,
    bytes: res.bytes,
    contentType: meta.contentType,
    contentDisposition: meta.contentDisposition,
    finalUrl: meta.url,
  };
}
