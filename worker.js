/**
 * MR ROBOT — Cloudflare Worker
 * Pure Worker API — no Express dependency.
 * Routes:
 *   GET  /healthz           → health check
 *   GET  /api/relay-state   → proxy on/off state
 *   POST /api/relay-toggle  → toggle proxy
 *   GET  /api/relay-log     → last 200 entries (Durable Object)
 *   GET  /api/relay-stream  → SSE live feed (Durable Object)
 *   *    /api/relay/*       → forward to PROXY_TARGET
 */

/* ── In-memory state (per isolate — resets on new deployment/restart) ── */
let proxyEnabled = true;
const trafficLog = [];
let seq = 0;
const sseClients = new Set();

function addEntry(entry) {
  const e = { id: ++seq, ...entry };
  trafficLog.unshift(e);
  if (trafficLog.length > 200) trafficLog.length = 200;
  sseClients.forEach(ctrl => {
    try {
      ctrl.enqueue(`data: ${JSON.stringify({ type: "entry", entry: e })}\n\n`);
    } catch {}
  });
  return e;
}

function cors(res) {
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "*");
  return res;
}

function json(data, status = 200) {
  return cors(Response.json(data, { status }));
}

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;

    /* ── preflight ── */
    if (method === "OPTIONS") return cors(new Response(null, { status: 204 }));

    /* ── health ── */
    if (path === "/healthz" || path === "/api/healthz") {
      return json({ status: "ok", proxy: proxyEnabled, ts: new Date().toISOString() });
    }

    /* ── relay state ── */
    if (path === "/api/relay-state" && method === "GET") {
      return json({ enabled: proxyEnabled });
    }

    /* ── relay toggle ── */
    if (path === "/api/relay-toggle" && method === "POST") {
      proxyEnabled = !proxyEnabled;
      return json({ enabled: proxyEnabled });
    }

    /* ── relay log ── */
    if (path === "/api/relay-log" && method === "GET") {
      return json(trafficLog);
    }

    /* ── relay SSE stream ── */
    if (path === "/api/relay-stream" && method === "GET") {
      let ctrl;
      const stream = new ReadableStream({
        start(c) {
          ctrl = c;
          sseClients.add(ctrl);
          ctrl.enqueue(
            `data: ${JSON.stringify({ type: "init", log: trafficLog, enabled: proxyEnabled })}\n\n`
          );
          /* keep-alive ping every 20 s */
          const ping = setInterval(() => {
            try { ctrl.enqueue(": ping\n\n"); } catch { clearInterval(ping); }
          }, 20_000);
        },
        cancel() {
          sseClients.delete(ctrl);
        },
      });

      return cors(new Response(stream, {
        headers: {
          "Content-Type":      "text/event-stream",
          "Cache-Control":     "no-cache",
          "X-Accel-Buffering": "no",
          "Connection":        "keep-alive",
        },
      }));
    }

    /* ── proxy relay ── */
    if (path.startsWith("/api/relay/")) {
      const start     = Date.now();
      const ip        = request.headers.get("CF-Connecting-IP") || "unknown";
      const targetBase = env.PROXY_TARGET || "https://mr-robot-5s3.pages.dev/api";
      const suffix    = path.replace("/api/relay", "");         // e.g. /heartbeat
      const targetUrl = `${targetBase}${suffix}${url.search}`;

      if (!proxyEnabled) {
        addEntry({
          ts: new Date().toISOString(), method, path: suffix, ip,
          body: null, status: 503, responseSnippet: "Proxy disabled", ms: 0,
        });
        return json({ error: "Proxy disabled" }, 503);
      }

      /* forward */
      const fwdHeaders = new Headers(request.headers);
      fwdHeaders.delete("host");

      let body = null;
      if (method !== "GET" && method !== "HEAD") {
        body = await request.arrayBuffer();
      }

      let upstream, respSnippet = "", status = 502, bodyObj = null;
      try {
        upstream = await fetch(targetUrl, {
          method,
          headers: fwdHeaders,
          body:    body || undefined,
          redirect: "follow",
        });
        status = upstream.status;

        const ct   = upstream.headers.get("content-type") || "";
        const raw  = await upstream.text();
        respSnippet = raw.slice(0, 300);

        if (ct.includes("application/json")) {
          try { bodyObj = body ? JSON.parse(new TextDecoder().decode(body)) : null; } catch {}
        }

        const ms = Date.now() - start;
        addEntry({ ts: new Date().toISOString(), method, path: suffix, ip, body: bodyObj, status, responseSnippet: respSnippet, ms });

        return cors(new Response(raw, {
          status,
          headers: { "Content-Type": ct || "text/plain" },
        }));

      } catch (err) {
        const ms = Date.now() - start;
        addEntry({ ts: new Date().toISOString(), method, path: suffix, ip, body: null, status: 502, responseSnippet: String(err), ms });
        return json({ error: "Upstream error", detail: String(err) }, 502);
      }
    }

    return json({ error: "Not found" }, 404);
  },
};
