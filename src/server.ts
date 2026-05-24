import express from "express";
  import cors from "cors";

  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // ─── Config ───────────────────────────────────────────────────────
  const PORT        = Number(process.env.PORT ?? 3000);
  const APP_SECRET  = process.env.APP_SECRET  ?? "";
  const PROXY_TARGET = (process.env.PROXY_TARGET ?? "").replace(/\/$/, "");

  if (!PROXY_TARGET) {
    console.error("❌  PROXY_TARGET env var is required");
    process.exit(1);
  }

  // ─── Secret Guard ─────────────────────────────────────────────────
  function requireSecret(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ): void {
    if (!APP_SECRET) { next(); return; }          // dev mode — no secret set
    const header = req.headers["x-app-secret"];
    if (!header || header !== APP_SECRET) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    next();
  }

  // ─── Health (no secret needed) ────────────────────────────────────
  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok", proxy: "mr-robot-proxy" });
  });

  // ─── Proxy — ALL methods on ALL paths ─────────────────────────────
  app.all("*", requireSecret, async (req, res) => {
    const path = req.path;                         // e.g. /register
    const qs   = req.url.includes("?")
      ? req.url.slice(req.url.indexOf("?"))
      : "";
    const targetUrl = `${PROXY_TARGET}${path}${qs}`;

    const method  = req.method.toUpperCase();
    const hasBody = ["POST", "PUT", "PATCH"].includes(method);

    try {
      const upstream = await fetch(targetUrl, {
        method,
        headers: { "content-type": "application/json" },
        ...(hasBody ? { body: JSON.stringify(req.body) } : {}),
      });

      const contentType = upstream.headers.get("content-type") ?? "application/json";
      const text        = await upstream.text();
      res.status(upstream.status).setHeader("content-type", contentType).send(text);
    } catch (err) {
      res.status(502).json({ error: "Proxy upstream error", detail: String(err) });
    }
  });

  // ─── Start ────────────────────────────────────────────────────────
  app.listen(PORT, () => {
    console.log(`🚀  MR ROBOT Proxy running on port ${PORT}`);
    console.log(`🎯  Forwarding to → ${PROXY_TARGET}`);
    console.log(`🔒  Secret guard  → ${APP_SECRET ? "ENABLED" : "DISABLED (set APP_SECRET)"}`);
  });
  