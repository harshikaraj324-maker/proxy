/**
   * MR ROBOT — Cloudflare Pages Function
   *
   * OUR routes (handled locally):
   *   GET  /                    → static cyberpunk dashboard
   *   GET  /assets/*            → static dashboard assets
   *   GET  /api/relay-state     → proxy on/off status
   *   POST /api/relay-toggle    → toggle proxy
   *   GET  /api/relay-log       → traffic log
   *   GET  /api/relay-stream    → SSE live stream
   *   *    /api/relay/*         → proxy relay to backend /api/*
   *   GET  /healthz /debug      → health check
   *
   * EVERYTHING ELSE → forwarded to backend transparently (HTML rewritten)
   */

  const BACKEND = "https://mr-robot-5s3.pages.dev";

  // Routes we handle ourselves — everything else goes to backend
  const OWN_PATHS = new Set(["/healthz", "/debug", "/api/relay-state", "/api/relay-toggle", "/api/relay-log", "/api/relay-stream"]);

  let proxyEnabled = true;
  const trafficLog = [];
  let seq = 0;

  function addEntry(e) {
    const entry = { id: ++seq, ...e };
    trafficLog.unshift(entry);
    if (trafficLog.length > 200) trafficLog.length = 200;
    return entry;
  }

  function cors() {
    return {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "*",
    };
  }

  function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
      status, headers: { "Content-Type": "application/json", ...cors() },
    });
  }

  // Rewrite HTML so backend-relative URLs go through our proxy
  function rewriteHtml(html, backendPath) {
    // Spoof path so React Router sees the original backend path
    const pathFix = `<script>
  (function(){
    // Fix React Router path
    history.replaceState(null,'','${backendPath}'+window.location.search);
    // Intercept WebSocket — redirect proxy WS URLs to backend directly
    var _WS = window.WebSocket;
    window.WebSocket = function(url, proto) {
      url = String(url)
        .replace('wss://proxy-6tq.pages.dev', 'wss://mr-robot-5s3.pages.dev')
        .replace('ws://proxy-6tq.pages.dev', 'ws://mr-robot-5s3.pages.dev');
      return proto ? new _WS(url, proto) : new _WS(url);
    };
    Object.assign(window.WebSocket, _WS);
  })();
  <\/script>`;

    return html
      .replace('<head>', '<head>' + pathFix)
      // relative asset URLs → backend pass-through
      .replace(/src="\/(?!\/)(?!api\/)/g,  'src="/api/pass/')
      .replace(/href="\/(?!\/)(?!api\/)/g, 'href="/api/pass/')
      .replace(/action="\/(?!\/)(?!api\/)/g, 'action="/api/pass/')
      // absolute backend URLs
      .replaceAll(BACKEND, "");
  }

  async function passthrough(request, backendPath, url) {
    const targetUrl = `${BACKEND}${backendPath}${url.search}`;
    const fwd = new Headers(request.headers);
    fwd.delete("host");

    // WebSocket upgrade — forward directly to backend
    if (request.headers.get("Upgrade") === "websocket") {
      const wsUrl = targetUrl.replace(/^https?:\/\//, "wss://");
      return fetch(wsUrl, { headers: fwd });
    }

    let body = null;
    if (request.method !== "GET" && request.method !== "HEAD") body = await request.arrayBuffer();
    const up = await fetch(targetUrl, { method: request.method, headers: fwd, body: body || undefined, redirect: "follow" });
    const ct = up.headers.get("content-type") || "";
    const raw = await up.text();
    const out = ct.includes("text/html") ? rewriteHtml(raw, backendPath) : raw;
    return new Response(out, {
      status: up.status,
      headers: { "Content-Type": ct || "text/plain", "Cache-Control": "no-store", ...cors() },
    });
  }

  export async function onRequest(context) {
    const { request, env } = context;
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;

    if (method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });

    /* ── 1. Static frontend assets (our own dashboard) ─────────────── */
    if (path === "/" || path.startsWith("/assets/")) {
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return json({ msg: "ASSETS binding not available" });
    }

    /* ── 2. Our own utility routes ──────────────────────────────────── */
    if (path === "/healthz" || path === "/api/healthz")
      return json({ status: "ok", proxy: proxyEnabled, ts: new Date().toISOString() });

    if (path === "/debug")
      return json({ path, method, url: request.url, proxy: proxyEnabled });

    if (path === "/api/relay-state") return json({ enabled: proxyEnabled });

    if (path === "/api/relay-toggle" && method === "POST") {
      proxyEnabled = !proxyEnabled;
      return json({ enabled: proxyEnabled });
    }

    if (path === "/api/relay-log") return json(trafficLog);

    if (path === "/api/relay-stream") {
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      writer.write(new TextEncoder().encode(
        `data: ${JSON.stringify({ type: "init", log: trafficLog, enabled: proxyEnabled })}\n\n`
      ));
      writer.close();
      return new Response(readable, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...cors() },
      });
    }

    /* ── 3. Relay proxy (/api/relay/* → backend /api/*) ─────────────── */
    if (path.startsWith("/api/relay/") || path === "/api/relay") {
      const PROXY_TARGET = (env && env.PROXY_TARGET) || `${BACKEND}/api`;
      const suffix       = path.replace(/^\/api\/relay/, "") || "/";
      const targetUrl    = `${PROXY_TARGET}${suffix}${url.search}`;
      const start        = Date.now();
      const ip           = request.headers.get("CF-Connecting-IP") || "unknown";

      if (!proxyEnabled) {
        addEntry({ ts: new Date().toISOString(), method, path: suffix, ip, body: null, status: 503, responseSnippet: "Proxy disabled", ms: 0 });
        return json({ error: "Proxy disabled" }, 503);
      }

      const fwd = new Headers(request.headers);
      fwd.delete("host");
      let body = null;
      if (method !== "GET" && method !== "HEAD") body = await request.arrayBuffer();

      try {
        const up = await fetch(targetUrl, { method, headers: fwd, body: body || undefined, redirect: "follow" });
        const ct  = up.headers.get("content-type") || "";
        const raw = await up.text();
        const ms  = Date.now() - start;
        let bodyObj = null;
        if (body) { try { bodyObj = JSON.parse(new TextDecoder().decode(body)); } catch {} }
        addEntry({ ts: new Date().toISOString(), method, path: suffix, ip, body: bodyObj, status: up.status, responseSnippet: raw.slice(0, 300), ms });
        return new Response(raw, { status: up.status, headers: { "Content-Type": ct || "text/plain", ...cors() } });
      } catch (err) {
        const ms = Date.now() - start;
        addEntry({ ts: new Date().toISOString(), method, path: suffix, ip, body: null, status: 502, responseSnippet: String(err), ms });
        return json({ error: "Upstream error", detail: String(err) }, 502);
      }
    }

    /* ── 4. Pass-through: /api/pass/* → backend (assets fetched by browser) */
    if (path.startsWith("/api/pass/")) {
      const backendPath = path.replace(/^\/api\/pass/, "");
      try {
        const up = await fetch(`${BACKEND}${backendPath}${url.search}`, { redirect: "follow" });
        const ct = up.headers.get("content-type") || "application/octet-stream";
        const raw = await up.text();
        return new Response(raw, {
          status: up.status,
          headers: { "Content-Type": ct, "Cache-Control": "public, max-age=86400", ...cors() },
        });
      } catch (err) {
        return json({ error: "Pass-through error", detail: String(err) }, 502);
      }
    }

    /* ── 5. EVERYTHING ELSE → forward to backend transparently ─────── */
    try {
      return await passthrough(request, path, url);
    } catch (err) {
      return json({ error: "Backend error", detail: String(err) }, 502);
    }
  }
  