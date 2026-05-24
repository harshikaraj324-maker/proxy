/**
   * MR ROBOT — Cloudflare Pages Function
   * /api/relay/*      → https://mr-robot-5s3.pages.dev/api/*
   * /api/dashboard/*  → https://mr-robot-5s3.pages.dev/preview/dashboard/*
   * /                 → static dist/index.html
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

    /* ── Static assets & frontend ─────────────────────────────────────── */
    if (!path.startsWith("/api/") && path !== "/healthz" && path !== "/debug") {
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return json({ msg: "ASSETS binding not available" }, 200);
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

    /* ── dashboard proxy (/api/dashboard/* → backend /preview/dashboard/*) ─ */
    if (path.startsWith("/api/dashboard/") || path === "/api/dashboard") {
      const BACKEND = "https://mr-robot-5s3.pages.dev";
      const suffix  = path.replace(/^\/api\/dashboard/, "/preview/dashboard");
      const targetUrl = `${BACKEND}${suffix}${url.search}`;
      const fwdHeaders = new Headers(request.headers);
      fwdHeaders.delete("host");
      let body = null;
      if (method !== "GET" && method !== "HEAD") body = await request.arrayBuffer();
      try {
        const upstream = await fetch(targetUrl, { method, headers: fwdHeaders, body: body || undefined, redirect: "follow" });
        const ct  = upstream.headers.get("content-type") || "text/html";
        const raw = await upstream.text();
        // Rewrite absolute backend URLs in HTML so relative links still work
        const rewritten = raw.replaceAll("https://mr-robot-5s3.pages.dev", "https://proxy-6tq.pages.dev/api/dashboard-asset");
        return new Response(rewritten, { status: upstream.status, headers: { "Content-Type": ct, ...corsHeaders() } });
      } catch (err) {
        return json({ error: "Dashboard upstream error", detail: String(err) }, 502);
      }
    }

    /* ── dashboard asset proxy (/api/dashboard-asset/*) ─────────────────── */
    if (path.startsWith("/api/dashboard-asset/")) {
      const BACKEND = "https://mr-robot-5s3.pages.dev";
      const suffix  = path.replace(/^\/api\/dashboard-asset/, "");
      const targetUrl = `${BACKEND}${suffix}${url.search}`;
      try {
        const upstream = await fetch(targetUrl, { method, headers: new Headers(request.headers), redirect: "follow" });
        const ct = upstream.headers.get("content-type") || "application/octet-stream";
        return new Response(upstream.body, { status: upstream.status, headers: { "Content-Type": ct, ...corsHeaders() } });
      } catch (err) {
        return json({ error: "Asset error", detail: String(err) }, 502);
      }
    }

    /* ── relay proxy (/api/relay/* → backend /api/*) ─────────────────────── */
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
  