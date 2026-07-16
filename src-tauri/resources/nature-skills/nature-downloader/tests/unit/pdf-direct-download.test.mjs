import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  fetchDirectToFile,
  uniqueFilePath,
  validatePublicDownloadUrl,
} from "../../scripts/lib/pdf-utils.mjs";

describe("direct PDF download", () => {
  let server;
  let baseUrl;
  let tempDir;
  let retryRequests;
  const allowTestUrl = async () => ({ ok: true });

  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cento-pdf-test-"));
    retryRequests = 0;
    server = http.createServer((request, response) => {
      if (request.url === "/retry.pdf" && retryRequests++ === 0) {
        response.writeHead(503, { "retry-after": "0" });
        response.end("busy");
      } else if (request.url === "/paper.pdf" || request.url === "/retry.pdf") {
        const body = Buffer.from("%PDF-1.7\nvalid test body\n%%EOF");
        response.writeHead(200, { "content-type": "application/pdf", "content-length": body.length });
        response.end(body);
      } else {
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<!doctype html><title>Login</title>");
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("streams and verifies a real PDF", async () => {
    const out = path.join(tempDir, "paper.pdf");
    const result = await fetchDirectToFile(`${baseUrl}/paper.pdf`, out, { validateUrlImpl: allowTestUrl });
    assert.equal(result.ok, true);
    assert.equal(fs.readFileSync(out).subarray(0, 5).toString("ascii"), "%PDF-");
  });

  test("rejects HTML without leaving a PDF or partial file", async () => {
    const out = path.join(tempDir, "login.pdf");
    const result = await fetchDirectToFile(`${baseUrl}/login`, out, { validateUrlImpl: allowTestUrl });
    assert.equal(result.ok, false);
    assert.match(result.err, /head mismatch/);
    assert.equal(fs.existsSync(out), false);
    assert.deepEqual(fs.readdirSync(tempDir).filter((name) => name.includes(".part-")), []);
  });

  test("retries transient HTTP failures and respects Retry-After", async () => {
    const out = path.join(tempDir, "retry.pdf");
    const sleeps = [];
    const result = await fetchDirectToFile(`${baseUrl}/retry.pdf`, out, {
      maxRetries: 1,
      sleepImpl: async (ms) => sleeps.push(ms),
      validateUrlImpl: allowTestUrl,
    });
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 2);
    assert.deepEqual(sleeps, [0]);
  });

  test("allocates a unique name instead of overwriting an existing PDF", () => {
    const original = path.join(tempDir, "paper-name.pdf");
    fs.writeFileSync(original, "%PDF-old");
    fs.writeFileSync(path.join(tempDir, "paper-name-(1).pdf"), "%PDF-old-duplicate");
    assert.equal(uniqueFilePath(original), path.join(tempDir, "paper-name-(2).pdf"));
  });

  test("blocks private addresses and nonstandard ports", async () => {
    assert.deepEqual(await validatePublicDownloadUrl("http://127.0.0.1/paper.pdf"), {
      ok: false,
      reason: "private_ip",
    });
    assert.deepEqual(await validatePublicDownloadUrl("https://repo.test:8443/paper.pdf"), {
      ok: false,
      reason: "port_not_allowed",
    });
    assert.deepEqual(await validatePublicDownloadUrl("https://repo.test/paper.pdf", {
      lookupImpl: async () => [{ address: "10.0.0.8" }],
    }), { ok: false, reason: "private_ip" });
    assert.deepEqual(await validatePublicDownloadUrl("https://repo.test/paper.pdf", {
      lookupImpl: async () => [{ address: "93.184.216.34" }],
    }), { ok: true });
    assert.deepEqual(await validatePublicDownloadUrl("https://203.0.10.8/paper.pdf"), { ok: true });
    assert.deepEqual(await validatePublicDownloadUrl("https://203.0.113.8/paper.pdf"), {
      ok: false,
      reason: "private_ip",
    });
  });

  test("rechecks SSRF policy on redirect targets", async () => {
    let fetchCount = 0;
    const result = await fetchDirectToFile("https://repo.test/start", path.join(tempDir, "redirect.pdf"), {
      maxRetries: 0,
      validateUrlImpl: async (url) => url.includes("127.0.0.1")
        ? { ok: false, reason: "private_ip" }
        : { ok: true },
      fetchImpl: async () => {
        fetchCount++;
        return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private.pdf" } });
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.err, "unsafe_url:private_ip");
    assert.equal(fetchCount, 1);
  });
});
