/**
   * MR ROBOT — Cloudflare Pages Function
   * /api/relay/*          → https://mr-robot-5s3.pages.dev/api/*
   * /api/dashboard/*      → backend /preview/dashboard/* (HTML rewritten)
   * /api/dashboard-asset/*→ backend static assets pass-through
   * /                     → static dist/index.html
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

  const BACKEND = "https://mr-robot-5s3.pages.dev";

  // Rewrite HTML: fix asset URLs + inject path spoof so React Router matches
  function rewriteHtml(html, originalPath) {
    // The backend serves this SPA at /preview/dashboard/* so React Router
    // expects that path. We inject a script to replaceState before React boots.
    const pathFix = `<script>
    (function(){
      var search = window.location.search;
      history.replaceState(null,'','${originalPath}'+search);
    })();
  </script>`;

    return html
      // inject path fix right after <head>
      .replace('<head>', '<head>' + pathFix)
      // src="/  → src="/api/dashboard-asset/
      .replace(/src="\/(?!\/)(?!api\/)/g, 'src="/api/dashboard-asset/')
      // href="/ → href="/api/dashboard-asset/  (skip https:// and //external)
      .replace(/href="\/(?!\/)(?!api\/)/g, 'href="/api/dashboard-asset/')
      // action="/
      .replace(/action="\/(?!\/)(?!api\/)/g, 'action="/api/dashboard-asset/')
      // absolute backend URLs in assets
      .replaceAll(BACKEND + "/assets/", "/api/dashboard-asset/assets/")
      .replaceAll(BACKEND, "");
  }

  export async function onRequest(context) {
    const { request, env } = context;
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;

    if (method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });

    /* ── Static frontend ──────────────────────────────────────────────── */
    if (!path.startsWith("/api/") && path !== "/healthz" && path !== "/debug") {
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return json({ msg: "ASSETS binding not available" });
    }

    /* ── debug ── */
    if (path === "/debug") return json({ path, method, url: request.url, proxy: proxyEnabled });

    /* ── health ── */
    if (path === "/healthz" || path === "/api/healthz")
      return json({ status: "ok", proxy: proxyEnabled, ts: new Date().toISOString() });

    /* ── relay state/toggle/log/stream ─────────────────────────────────── */
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
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...corsHeaders() },
      });
    }

    /* ── Dashboard HTML proxy ──────────────────────────────────────────── */
    if (path.startsWith("/api/dashboard/") || path === "/api/dashboard") {
      const suffix     = path.replace(/^\/api\/dashboard/, "/preview/dashboard");
      const targetUrl  = `${BACKEND}${suffix}${url.search}`;
      const fwdHeaders = new Headers(request.headers);
      fwdHeaders.delete("host");
      let body = null;
      if (method !== "GET" && method !== "HEAD") body = await request.arrayBuffer();
      try {
        const upstream = await fetch(targetUrl, { method, headers: fwdHeaders, body: body || undefined, redirect: "follow" });
        const ct       = upstream.headers.get("content-type") || "text/html";
        const raw      = await upstream.text();
        const rewritten = ct.includes("text/html") ? rewriteHtml(raw, suffix) : raw;
        return new Response(rewritten, {
          status: upstream.status,
          headers: { "Content-Type": ct, "Cache-Control": "no-store", ...corsHeaders() },
        });
      } catch (err) {
        return json({ error: "Dashboard error", detail: String(err) }, 502);
      }
    }

    /* ── Dashboard asset pass-through ─────────────────────────────────── */
    if (path.startsWith("/api/dashboard-asset/")) {
      const suffix    = path.replace(/^\/api\/dashboard-asset/, "");
      const targetUrl = `${BACKEND}${suffix}${url.search}`;
      const fwdHeaders = new Headers(request.headers);
      fwdHeaders.delete("host");
      try {
        const upstream = await fetch(targetUrl, { method: "GET", headers: fwdHeaders, redirect: "follow" });
        const ct = upstream.headers.get("content-type") || "application/octet-stream";
        const raw = await upstream.text();
        // Rewrite any JS/CSS that reference backend URLs
        const rewritten = raw.replaceAll(BACKEND, "");
        return new Response(rewritten, {
          status: upstream.status,
          headers: { "Content-Type": ct, "Cache-Control": "public, max-age=86400", ...corsHeaders() },
        });
      } catch (err) {
        return json({ error: "Asset error", detail: String(err) }, 502);
      }
    }

    /* ── Relay proxy (/api/relay/* → backend /api/*) ─────────────────── */
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
  