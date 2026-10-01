import http from "node:http";
import { readFile } from "node:fs/promises";
import { scrypt, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";
import {
  catalogue,
  listModels,
  isProvider,
  needsEndpoint,
} from "./providers.mjs";
import { Settings } from "./settings.mjs";
import { engineCatalog, isEngine } from "./engines.mjs";
const derive = promisify(scrypt);
export function createServer({
  config,
  engine,
  store,
  settings = null,
  listModelsFn = listModels,
}) {
  const attempts = new Map(),
    cache = new Map(),
    streams = new Set();
  async function authorised(req) {
    const header = req.headers.authorization ?? "";
    if (header.length > 2048 || !header.startsWith("Basic ")) return false;
    const fingerprint = createHash("sha256").update(header).digest("hex");
    if ((cache.get(fingerprint) ?? 0) > Date.now()) return true;
    const ip = req.socket.remoteAddress;
    const a = attempts.get(ip) ?? { count: 0, until: Date.now() + 60000 };
    if (a.until < Date.now()) {
      a.count = 0;
      a.until = Date.now() + 60000;
    }
    attempts.set(ip, a);
    if (a.count++ > 20) return false;
    const raw = Buffer.from(header.slice(6), "base64").toString("utf8"),
      colon = raw.indexOf(":");
    if (colon < 0 || raw.slice(0, colon) !== config.auth.username) return false;
    const [salt, hash] = config.auth.passwordHash.split(":");
    const actual = await derive(raw.slice(colon + 1), salt, 64);
    if (!timingSafeEqual(actual, Buffer.from(hash, "hex"))) return false;
    cache.clear();
    cache.set(fingerprint, Date.now() + 300000);
    a.count = 0;
    return true;
  }
  // Control endpoints require the authenticated session plus an exact origin match
  // and an explicit opt-in header. The dashboard never sends credentials cross-site,
  // and a same-origin page cannot be driven from another site without both.
  async function control(req) {
    return (
      req.headers.origin === config.publicOrigin &&
      req.headers["x-beebots-control"] === "1"
    );
  }
  // Body cap matches the entries route. A key is far shorter than 1 KiB.
  async function jsonBody(req) {
    let text = "";
    for await (const chunk of req) {
      text += chunk;
      if (text.length > 1024) return { error: "Too large", status: 413 };
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return { error: "Invalid JSON" };
    }
    if (!data || typeof data !== "object" || Array.isArray(data))
      return { error: "Invalid payload" };
    return { data };
  }
  // Provider catalogue and the masked current selection. No credential material.
  function offer() {
    return {
      providers: catalogue(),
      engines: engineCatalog(),
      current: settings ? settings.redacted() : null,
    };
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    const json = (status, data) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };
    try {
      const path = new URL(req.url, "http://localhost").pathname;
      // The dashboard is public: the page, its assets and the read-only feeds
      // need no credentials, so anyone can watch. Only the settings and the
      // control actions require the owner login. A 401 is returned as JSON with
      // no WWW-Authenticate header, so the browser never shows its native
      // prompt; the page's own login dialog handles it.
      const isPublic =
        req.method === "GET" &&
        ["", "app.js", "style.css", "theme.js", "api/state", "api/events"]
          .map((p) => config.basePath + p)
          .includes(path);
      if (!isPublic && !(await authorised(req)))
        return json(401, { error: "Authentication required" });
      if (path === config.basePath + "api/state" && req.method === "GET")
        return json(200, engine.snapshot());
      if (path === config.basePath + "api/events" && req.method === "GET") {
        if (streams.size >= 20)
          return json(503, { error: "Stream capacity reached" });
        const last = Number(req.headers["last-event-id"] ?? 0);
        if (!Number.isSafeInteger(last) || last < 0)
          return json(400, { error: "Invalid cursor" });
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.flushHeaders();
        streams.add(res);
        const send = (e) => {
          // Full market snapshots belong in api/state, not the event replay.
          if (e.kind === "market")
            e = {
              id: e.id,
              ts: e.ts,
              kind: e.kind,
              message: "Market data refreshed",
            };
          if (res.writableLength > 1024 * 1024) {
            res.destroy();
            return;
          }
          res.write(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`);
        };
        for (const e of last ? store.events(last, 500) : store.recent(100))
          send(e);
        res.write("event: sync\ndata: {}\n\n"); // Client refreshes authoritative state even if replay was truncated.
        store.on("event", send);
        const heartbeat = setInterval(
          () => res.write(": heartbeat\n\n"),
          15000,
        );
        req.on("close", () => {
          clearInterval(heartbeat);
          streams.delete(res);
          store.off("event", send);
        });
        return;
      }
      if (path === config.basePath + "api/entries" && req.method === "POST") {
        if (!(await control(req)))
          return json(403, { error: "Invalid control origin" });
        const body = await jsonBody(req);
        if (body.error) return json(body.status ?? 400, { error: body.error });
        const data = body.data;
        if (typeof data.paused !== "boolean")
          return json(400, { error: "paused must be boolean" });
        if (!data.paused && (config.mode !== "live" || store.read().halt))
          return json(409, { error: "Cannot enable entries in this state" });
        store.change(
          (s) => {
            s.paused = data.paused;
          },
          "control",
          {
            paused: data.paused,
            message: data.paused
              ? "New entries paused; exits remain active"
              : "New entries resumed",
          },
        );
        return json(200, { paused: data.paused });
      }
      if (path === config.basePath + "api/settings" && req.method === "GET") {
        // Read-only. Returns the catalogue and a masked key hint, never a key.
        return json(200, { ...offer(), engine: engine.modelInfo?.() ?? null });
      }
      if (path === config.basePath + "api/settings" && req.method === "POST") {
        if (!settings)
          return json(409, { error: "Settings are not managed here" });
        if (!(await control(req)))
          return json(403, { error: "Invalid control origin" });
        const body = await jsonBody(req);
        if (body.error) return json(body.status ?? 400, { error: body.error });
        const {
          provider,
          model,
          apiKey,
          clearKey,
          endpoint,
          engine,
          jevApiKey,
          clearJevKey,
          jevModel,
        } = body.data;
        if (
          apiKey !== undefined &&
          apiKey !== null &&
          typeof apiKey !== "string"
        )
          return json(400, { error: "Invalid API key" });
        if (clearKey !== undefined && typeof clearKey !== "boolean")
          return json(400, { error: "Invalid clearKey" });
        if (
          endpoint !== undefined &&
          endpoint !== null &&
          typeof endpoint !== "string"
        )
          return json(400, { error: "Invalid endpoint" });
        if (engine !== undefined && engine !== null && !isEngine(engine))
          return json(400, { error: "Unknown decision engine" });
        if (
          jevApiKey !== undefined &&
          jevApiKey !== null &&
          typeof jevApiKey !== "string"
        )
          return json(400, { error: "Invalid Jev API key" });
        if (clearJevKey !== undefined && typeof clearJevKey !== "boolean")
          return json(400, { error: "Invalid clearJevKey" });
        if (
          jevModel !== undefined &&
          jevModel !== null &&
          typeof jevModel !== "string"
        )
          return json(400, { error: "Invalid Jev model" });
        let saved;
        try {
          saved = settings.save({
            provider,
            model,
            apiKey,
            clearKey,
            endpoint,
            engine,
            jevApiKey,
            clearJevKey,
            jevModel,
          });
        } catch (e) {
          return json(400, { error: e.message });
        }
        // The audit record names the provider, model and engine only. An API
        // key or a typed endpoint must never reach the event log, which is
        // replayed to every connected view.
        store.change(() => {}, "control", {
          message: "Decision-engine selection changed",
          provider: saved.provider,
          model: saved.model,
          engine: saved.engine,
          keyUpdated: apiKey ? true : !!clearKey,
          jevKeyUpdated: jevApiKey ? true : !!clearJevKey,
          local: needsEndpoint(saved.provider) === true,
        });
        return json(200, offer());
      }
      if (
        path === config.basePath + "api/settings/models" &&
        req.method === "POST"
      ) {
        if (!settings)
          return json(409, { error: "Settings are not managed here" });
        if (!(await control(req)))
          return json(403, { error: "Invalid control origin" });
        const body = await jsonBody(req);
        if (body.error) return json(body.status ?? 400, { error: body.error });
        const { provider, apiKey, endpoint } = body.data;
        if (!isProvider(provider))
          return json(400, { error: "Unknown decision-model provider" });
        // A blank key field means "use the stored one", so models can be listed
        // before a new key is committed.
        const key =
          typeof apiKey === "string" && apiKey
            ? apiKey
            : settings.redacted().provider === provider
              ? settings.key(provider)
              : null;
        let url = endpoint;
        if (url !== undefined && url !== null && url !== "") {
          if (!needsEndpoint(provider))
            return json(400, {
              error: "This provider does not accept a custom endpoint",
            });
          try {
            url = Settings.endpoint(url);
          } catch (e) {
            return json(400, { error: e.message });
          }
        }
        const listed = await listModelsFn({
          provider,
          endpoint: url,
          apiKey: key,
        });
        return json(200, listed);
      }
      if (
        path === config.basePath + "api/settings/test" &&
        req.method === "POST"
      ) {
        if (!(await control(req)))
          return json(403, { error: "Invalid control origin" });
        // Best-effort body: older callers send nothing, in which case the LLM
        // probe runs as before. A Jev or Laya engine is probed directly.
        let target;
        try {
          let text = "";
          for await (const chunk of req) {
            text += chunk;
            if (text.length > 1024) break;
          }
          target = text ? JSON.parse(text)?.engine : undefined;
        } catch {
          target = undefined;
        }
        try {
          if (target === "jev") return json(200, await engine.jev.probe());
          if (target === "laya") return json(200, await engine.laya.ping());
          return json(200, await engine.model.probe());
        } catch (e) {
          // Message only; the probe discards provider response bodies.
          return json(502, { error: e.message });
        }
      }
      const names = new Map([
        [config.basePath, "index.html"],
        [config.basePath + "app.js", "app.js"],
        [config.basePath + "style.css", "style.css"],
        [config.basePath + "theme.js", "theme.js"],
      ]);
      if (req.method !== "GET" || !names.has(path))
        return json(404, { error: "Not found" });
      const name = names.get(path);
      const content = await readFile(
        new URL("../public/" + name, import.meta.url),
      );
      res.writeHead(200, {
        "Content-Type": name.endsWith(".html")
          ? "text/html; charset=utf-8"
          : name.endsWith(".css")
            ? "text/css"
            : "text/javascript",
      });
      res.end(content);
    } catch {
      if (!res.headersSent) json(500, { error: "Request failed" });
      else res.end();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.closeStreams = () => {
    for (const s of streams) s.end();
  };
  return server;
}
