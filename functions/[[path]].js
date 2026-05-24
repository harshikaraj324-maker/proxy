/**
   * MR ROBOT — Cloudflare Pages Function
   * API routes handled here; all other paths served from static dist/ files.
   */

  let proxyEnabled = true;
  const trafficLog = [];
  let seq = 0;

  function addEntry(entry) {
    const e = { id: ++seq, ...entry };
    trafficLog.unshift(e);
    if (trafficLog.length > 200) trafficLog.length = 200;
    return e;
  }

  function corsHeaders() {
    return {
      "Access-Control-Allow-Origin":  "*",
      "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "*",
    };
  }

  function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
  }

  export async function onRequest(context) {
    const { request, env } = context;
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;

    if (method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });

    /* ── Static assets & frontend (everything not under /api) ─────── */
    if (!path.startsWith("/api/") && path !== "/healthz" && path !== "/debug") {
      /* Let Cloudflare Pages serve the static dist files */
      if (env.ASSETS) return env.ASSETS.fetch(request);
      /* fallback: 200 with a redirect note */
      return json({ msg: "ASSETS binding not available — check Cloudflare Pages settings" }, 200);
    }

    /* ── debug ── */
    if (path === "/debug") return json({ path, method, url: request.url, proxy: proxyEnabled });

    /* ── health ── */
    if (path === "/healthz" || path === "/api/healthz") {
      return json({ status: "ok", proxy: proxyEnabled, ts: new Date().toISOString() });
    }

    /* ── relay state ── */
    if (path === "/api/relay-state") return json({ enabled: proxyEnabled });

    /* ── relay toggle ── */
    if (path === "/api/relay-toggle" && method === "POST") {
      proxyEnabled = !proxyEnabled;
      return json({ enabled: proxyEnabled });
    }

    /* ── relay log ── */
    if (path === "/api/relay-log") return json(trafficLog);

    /* ── relay SSE ── */
    if (path === "/api/relay-stream") {
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const enc    = new TextEncoder();
      writer.write(enc.encode(
        `data: ${JSON.stringify({ type: "init", log: trafficLog, enabled: proxyEnabled })}\n\n`
      ));
      writer.close();
      return new Response(readable, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...corsHeaders() },
      });
    }

    /* ── proxy relay ── */
    if (path.startsWith("/api/relay/") || path === "/api/relay") {
      const PROXY_TARGET = (env && env.PROXY_TARGET) || "https://mr-robot-5s3.pages.dev/api";
      const suffix       = path.replace(/^\/api\/relay/, "") || "/";
      const targetUrl    = `${PROXY_TARGET}${suffix}${url.search}`;
      const start        = Date.now();
      const ip           = request.headers.get("CF-Connecting-IP") || "unknown";

      if (!proxyEnabled) {
        addEntry({ ts: new Date().toISOString(), method, path: suffix, ip, body: null, status: 503, responseSnippet: "Proxy disabled", ms: 0 });
        return json({ error: "Proxy disabled" }, 503);
      }

      const fwdHeaders = new Headers(request.headers);
      fwdHeaders.delete("host");
      let body = null;
      if (method !== "GET" && method !== "HEAD") body = await request.arrayBuffer();

      try {
        const upstream = await fetch(targetUrl, { method, headers: fwdHeaders, body: body || undefined, redirect: "follow" });
        const ct  = upstream.headers.get("content-type") || "";
        const raw = await upstream.text();
        const ms  = Date.now() - start;
        let bodyObj = null;
        if (body) { try { bodyObj = JSON.parse(new TextDecoder().decode(body)); } catch {} }
        addEntry({ ts: new Date().toISOString(), method, path: suffix, ip, body: bodyObj, status: upstream.status, responseSnippet: raw.slice(0, 300), ms });
        return new Response(raw, { status: upstream.status, headers: { "Content-Type": ct || "text/plain", ...corsHeaders() } });
      } catch (err) {
        const ms = Date.now() - start;
        addEntry({ ts: new Date().toISOString(), method, path: suffix, ip, body: null, status: 502, responseSnippet: String(err), ms });
        return json({ error: "Upstream error", detail: String(err) }, 502);
      }
    }

    return json({ error: "Not found", path }, 404);
  }
  