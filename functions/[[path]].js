/**
 * MR ROBOT — Cloudflare Pages Function (catch-all)
 * Handles all routes: /api/relay/*, /api/relay-log, /api/relay-state, etc.
 */

let proxyEnabled = true;
const trafficLog  = [];
let seq = 0;

function addEntry(entry) {
  const e = { id: ++seq, ...entry };
  trafficLog.unshift(e);
  if (trafficLog.length > 200) trafficLog.length = 200;
  return e;
}

function cors(res) {
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin",  "*");
  h.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  h.set("Access-Control-Allow-Headers", "*");
  return new Response(res.body, { status: res.status, headers: h });
}

function json(data, status = 200) {
  return cors(new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  }));
}

export async function onRequest(context) {
  const { request, env } = context;
  const url    = new URL(request.url);
  const path   = url.pathname;
  const method = request.method;

  if (method === "OPTIONS") {
    return cors(new Response(null, { status: 204 }));
  }

  /* health */
  if (path === "/healthz" || path === "/api/healthz") {
    return json({ status: "ok", proxy: proxyEnabled, ts: new Date().toISOString() });
  }

  /* relay state */
  if (path === "/api/relay-state" && method === "GET") {
    return json({ enabled: proxyEnabled });
  }

  /* relay toggle */
  if (path === "/api/relay-toggle" && method === "POST") {
    proxyEnabled = !proxyEnabled;
    return json({ enabled: proxyEnabled });
  }

  /* relay log */
  if (path === "/api/relay-log" && method === "GET") {
    return json(trafficLog);
  }

  /* relay SSE stream */
  if (path === "/api/relay-stream" && method === "GET") {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const enc    = new TextEncoder();

    writer.write(enc.encode(
      `data: ${JSON.stringify({ type: "init", log: trafficLog, enabled: proxyEnabled })}\n\n`
    ));

    /* Cloudflare Pages Functions don't support long-lived SSE well,
       so we flush log + close immediately — dashboard will reconnect */
    writer.close();

    return cors(new Response(readable, {
      headers: {
        "Content-Type":      "text/event-stream",
        "Cache-Control":     "no-cache",
        "X-Accel-Buffering": "no",
      },
    }));
  }

  /* proxy relay */
  if (path.startsWith("/api/relay/")) {
    const start      = Date.now();
    const ip         = request.headers.get("CF-Connecting-IP") || "unknown";
    const target     = env.PROXY_TARGET || "https://mr-robot-5s3.pages.dev/api";
    const suffix     = path.replace("/api/relay", "");
    const targetUrl  = `${target}${suffix}${url.search}`;

    if (!proxyEnabled) {
      addEntry({ ts: new Date().toISOString(), method, path: suffix, ip, body: null, status: 503, responseSnippet: "Proxy disabled", ms: 0 });
      return json({ error: "Proxy disabled" }, 503);
    }

    const fwdHeaders = new Headers(request.headers);
    fwdHeaders.delete("host");

    let body = null;
    if (method !== "GET" && method !== "HEAD") {
      body = await request.arrayBuffer();
    }

    try {
      const upstream = await fetch(targetUrl, {
        method,
        headers: fwdHeaders,
        body: body || undefined,
        redirect: "follow",
      });

      const ct  = upstream.headers.get("content-type") || "";
      const raw = await upstream.text();
      const ms  = Date.now() - start;

      let bodyObj = null;
      if (body) {
        try { bodyObj = JSON.parse(new TextDecoder().decode(body)); } catch {}
      }

      addEntry({ ts: new Date().toISOString(), method, path: suffix, ip, body: bodyObj, status: upstream.status, responseSnippet: raw.slice(0, 300), ms });

      return cors(new Response(raw, {
        status: upstream.status,
        headers: { "Content-Type": ct || "text/plain" },
      }));

    } catch (err) {
      const ms = Date.now() - start;
      addEntry({ ts: new Date().toISOString(), method, path: suffix, ip, body: null, status: 502, responseSnippet: String(err), ms });
      return json({ error: "Upstream error", detail: String(err) }, 502);
    }
  }

  return json({ error: "Not found" }, 404);
}
