#!/usr/bin/env node
import http from "node:http";

const HOST = "127.0.0.1";
const PORT = 3456;
const DEBUG_BASE = "http://127.0.0.1:9222";

async function debugJson(path, options = {}) {
  const response = await fetch(`${DEBUG_BASE}${path}`, options);
  if (!response.ok) throw new Error(`Chrome debug HTTP ${response.status}`);
  return response.json();
}

async function targetInfo(targetId) {
  const targets = await debugJson("/json/list");
  return targets.find(target => target.id === targetId);
}

async function withCdp(targetId, action) {
  const target = await targetInfo(targetId);
  if (!target?.webSocketDebuggerUrl) throw new Error("Chrome target not found");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let sequence = 0;
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result || {});
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  try {
    return await action(send);
  } finally {
    socket.close();
  }
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function writeJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

async function evaluate(targetId, expression) {
  return withCdp(targetId, async send => {
    await send("Runtime.enable");
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "evaluate failed");
    return result.result?.value;
  });
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${HOST}:${PORT}`);
    const targetId = url.searchParams.get("target") || "";
    if (request.method === "GET" && url.pathname === "/targets") {
      const targets = await debugJson("/json/list");
      writeJson(response, 200, targets.map(target => ({
        targetId: target.id,
        url: target.url,
        title: target.title,
        type: target.type,
      })));
      return;
    }
    if (request.method === "POST" && url.pathname === "/new") {
      const destination = await readBody(request);
      const target = await debugJson(`/json/new?${encodeURIComponent(destination)}`, { method: "PUT" });
      writeJson(response, 200, { targetId: target.id, url: target.url, title: target.title });
      return;
    }
    if (request.method === "GET" && url.pathname === "/close") {
      await debugJson(`/json/close/${encodeURIComponent(targetId)}`);
      writeJson(response, 200, { ok: true });
      return;
    }
    if (request.method === "POST" && url.pathname === "/navigate") {
      const destination = await readBody(request);
      await withCdp(targetId, send => send("Page.navigate", { url: destination }));
      writeJson(response, 200, { ok: true });
      return;
    }
    if (request.method === "POST" && url.pathname === "/eval") {
      const expression = await readBody(request);
      writeJson(response, 200, { value: await evaluate(targetId, expression) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/click") {
      const selector = await readBody(request);
      const value = await evaluate(targetId, `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return false;el.click();return true;})()`);
      writeJson(response, 200, { value });
      return;
    }
    if (request.method === "GET" && url.pathname === "/scroll") {
      const direction = url.searchParams.get("direction") || "bottom";
      const expression = direction === "top"
        ? "window.scrollTo({top:0,behavior:'instant'});true"
        : "window.scrollTo({top:document.documentElement.scrollHeight,behavior:'instant'});true";
      writeJson(response, 200, { value: await evaluate(targetId, expression) });
      return;
    }
    if (request.method === "GET" && url.pathname === "/info") {
      const value = await evaluate(targetId, "({url:location.href,title:document.title,ready:document.readyState})");
      writeJson(response, 200, { targetId, ...value });
      return;
    }
    writeJson(response, 404, { error: "not found" });
  } catch (error) {
    writeJson(response, 500, { error: String(error?.message || error) });
  }
});

server.listen(PORT, HOST);
