import test from "node:test";
import assert from "node:assert/strict";
import { config } from "./helpers.mjs";
import { Store } from "../src/store.mjs";
import { createServer } from "../src/server.mjs";
import { Engine } from "../src/engine.mjs";
import { Settings } from "../src/settings.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const headers = {
  Authorization:
    "Basic " + Buffer.from("admin:local-test-password").toString("base64"),
};
async function fixture() {
  const c = config(),
    store = new Store(":memory:", c);
  const server = createServer({
    config: c,
    store,
    engine: { snapshot: () => ({ mode: "observe", bots: [] }) },
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    c,
    store,
    server,
    url: `http://127.0.0.1:${server.address().port}/beebots/`,
    close: async () => {
      server.closeStreams();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      store.close();
    },
  };
}
// Fixture with a dashboard-managed model selector and a probe double.
async function settingsFixture() {
  const c = config(),
    store = new Store(":memory:", c),
    dir = mkdtempSync(join(tmpdir(), "beebots-srv-"));
  const settings = new Settings({ dataDir: dir, fallback: c.model });
  const probes = [],
    listings = [];
  const server = createServer({
    config: c,
    store,
    settings,
    // Stubbed so the suite never contacts a real provider.
    listModelsFn: async (args) => {
      listings.push(args);
      return {
        models: [{ id: "glm-4.7-flash", label: "glm-4.7-flash" }],
        source: "provider",
      };
    },
    engine: {
      snapshot: () => ({ mode: "observe", bots: [] }),
      modelInfo: () => ({
        provider: "zai",
        model: "glm-4.7-flash",
        free: true,
      }),
      model: {
        probe: async () => {
          probes.push(1);
          return { ok: true, model: "glm-4.7-flash" };
        },
      },
    },
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    c,
    store,
    server,
    probes,
    listings,
    url: `http://127.0.0.1:${server.address().port}/beebots/`,
    close: async () => {
      server.closeStreams();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const controlHeaders = (origin, extra = {}) => ({
  ...headers,
  "Content-Type": "application/json",
  "X-Beebots-Control": "1",
  Origin: origin,
  ...extra,
});

test("model settings require authentication and an exact control origin", async () => {
  const f = await settingsFixture();
  const body = JSON.stringify({
    provider: "zai",
    model: "glm-4.7-flash",
    apiKey: "server-test-key-9999",
  });
  try {
    // Unauthenticated.
    assert.equal(
      (
        await fetch(f.url + "api/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        })
      ).status,
      401,
    );
    // Cross-origin, and correct origin but no opt-in header.
    assert.equal(
      (
        await fetch(f.url + "api/settings", {
          method: "POST",
          headers: controlHeaders("https://evil.example"),
          body,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(f.url + "api/settings", {
          method: "POST",
          headers: {
            ...headers,
            "Content-Type": "application/json",
            Origin: f.c.publicOrigin,
          },
          body,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(f.url + "api/settings/test", {
          method: "POST",
          headers: controlHeaders("https://evil.example"),
          body: "{}",
        })
      ).status,
      403,
    );
    assert.equal(
      f.probes.length,
      0,
      "a rejected probe must not reach the provider",
    );
  } finally {
    await f.close();
  }
});

test("the settings API accepts a catalogue selection and never returns a key", async () => {
  const f = await settingsFixture();
  try {
    const get = await fetch(f.url + "api/settings", { headers });
    assert.equal(get.status, 200);
    const listed = await get.json();
    assert.ok(listed.providers.some((p) => p.id === "zai"));
    assert.ok(listed.providers.some((p) => p.id === "deepseek"));
    // A free-text base URL has nowhere to go in the response either.
    assert.ok(!("baseUrl" in listed.current));

    const r = await fetch(f.url + "api/settings", {
      method: "POST",
      headers: controlHeaders(f.c.publicOrigin),
      body: JSON.stringify({
        provider: "zai",
        model: "glm-4.7-flash",
        apiKey: "server-test-key-9999",
      }),
    });
    assert.equal(r.status, 200);
    const saved = await r.json();
    assert.equal(saved.current.provider, "zai");
    assert.equal(saved.current.hasKey, true);
    assert.equal(saved.current.keyHint, "…9999");
    const text = JSON.stringify(saved);
    assert.ok(
      !text.includes("server-test-key-9999"),
      "no plaintext key in any response",
    );

    // The audit record names the model, never the key.
    const events = f.store.recent(50).filter((e) => e.kind === "control");
    const change = events.at(-1);
    assert.equal(change.provider, "zai");
    assert.equal(change.model, "glm-4.7-flash");
    assert.ok(!JSON.stringify(change).includes("server-test-key-9999"));
  } finally {
    await f.close();
  }
});

test("the settings API rejects unknown providers, models and base URLs", async () => {
  const f = await settingsFixture();
  try {
    const post = async (payload) =>
      (
        await fetch(f.url + "api/settings", {
          method: "POST",
          headers: controlHeaders(f.c.publicOrigin),
          body: JSON.stringify(payload),
        })
      ).status;
    assert.equal(
      await post({ provider: "evil", model: "m", apiKey: "x".repeat(8) }),
      400,
    );
    assert.equal(
      await post({
        provider: "deepseek",
        model: "glm-4.7-flash",
        apiKey: "x".repeat(8),
      }),
      400,
    );
    // Retired aliases are not selectable.
    assert.equal(
      await post({
        provider: "deepseek",
        model: "deepseek-v4-flash",
        apiKey: "x".repeat(8),
      }),
      400,
    );
    // A base URL field is ignored rather than honoured.
    const r = await fetch(f.url + "api/settings", {
      method: "POST",
      headers: controlHeaders(f.c.publicOrigin),
      body: JSON.stringify({
        provider: "zai",
        model: "glm-4.7-flash",
        apiKey: "x".repeat(8),
        baseUrl: "https://attacker.example/v1",
      }),
    });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).current.provider, "zai");
  } finally {
    await f.close();
  }
});

test("the connection test runs only for an authorised control request", async () => {
  const f = await settingsFixture();
  try {
    const r = await fetch(f.url + "api/settings/test", {
      method: "POST",
      headers: controlHeaders(f.c.publicOrigin),
      body: "{}",
    });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).ok, true);
    assert.equal(f.probes.length, 1);
  } finally {
    await f.close();
  }
});

test("an oversized settings body is refused", async () => {
  const f = await settingsFixture();
  try {
    const r = await fetch(f.url + "api/settings", {
      method: "POST",
      headers: controlHeaders(f.c.publicOrigin),
      body: JSON.stringify({ provider: "zai", model: "g".repeat(2000) }),
    });
    assert.equal(r.status, 413);
  } finally {
    await f.close();
  }
});
test("the page and read-only feeds are public; settings need auth", async () => {
  const f = await fixture();
  try {
    // Public: served to anyone, with no browser auth challenge.
    for (const path of ["", "app.js", "style.css", "theme.js", "api/state"]) {
      const r = await fetch(f.url + path);
      assert.equal(r.status, 200, `${path} must be public`);
      assert.equal(
        r.headers.get("www-authenticate"),
        null,
        `${path} must not prompt for auth`,
      );
    }
    // SSE is public too (EventSource cannot send credentials); cancel at once.
    const ac = new AbortController();
    const sse = await fetch(f.url + "api/events", { signal: ac.signal });
    assert.equal(sse.status, 200);
    ac.abort();
    // Protected: settings require the owner login.
    const denied = await fetch(f.url + "api/settings");
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get("www-authenticate"), null);
    assert.equal(
      (await fetch(f.url + "api/settings", { headers })).status,
      200,
    );
  } finally {
    await f.close();
  }
});
test("control rejects cross-origin request and cannot enable live in observe", async () => {
  const f = await fixture();
  try {
    const opts = {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
        "X-Beebots-Control": "1",
        Origin: "https://evil.example",
      },
      body: '{"paused":false}',
    };
    assert.equal((await fetch(f.url + "api/entries", opts)).status, 403);
    opts.headers.Origin = f.c.publicOrigin;
    assert.equal((await fetch(f.url + "api/entries", opts)).status, 409);
  } finally {
    await f.close();
  }
});
test("SSE reconnect replays persisted events and sends subsequent decisions", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    f.store.event("decision", { bot: "trend", action: "HOLD" });
    const r = await fetch(f.url + "api/events", {
      headers,
      signal: controller.signal,
    });
    assert.equal(r.status, 200);
    const reader = r.body.getReader();
    let text = "";
    while (!text.includes("HOLD"))
      text += new TextDecoder().decode((await reader.read()).value);
    assert.match(text, /HOLD/);
    f.store.event("decision", { bot: "trend", action: "SELL" });
    while (!text.includes("SELL"))
      text += new TextDecoder().decode((await reader.read()).value);
    assert.match(text, /SELL/);
    await reader.cancel();
  } finally {
    clearTimeout(timeout);
    controller.abort();
    await f.close();
  }
});

test("large market replay does not disconnect the decision stream", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    for (let i = 0; i < 60; i++)
      f.store.event("market", { rows: "x".repeat(100000) });
    f.store.event("decision", { bot: "trend", action: "HOLD" });
    const r = await fetch(f.url + "api/events", {
      headers,
      signal: controller.signal,
    });
    const reader = r.body.getReader();
    let text = "";
    while (!text.includes("HOLD")) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      text += new TextDecoder().decode(chunk.value);
    }
    assert.ok(text.length < 20000);
    assert.match(text, /Market data refreshed/);
    await reader.cancel();
  } finally {
    clearTimeout(timeout);
    controller.abort();
    await f.close();
  }
});

test("the model list is served server-side and only for an authorised control request", async () => {
  const f = await settingsFixture();
  try {
    assert.equal(
      (
        await fetch(f.url + "api/settings/models", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: '{"provider":"zai"}',
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(f.url + "api/settings/models", {
          method: "POST",
          headers: controlHeaders("https://evil.example"),
          body: '{"provider":"zai"}',
        })
      ).status,
      403,
    );
    assert.equal(
      f.listings.length,
      0,
      "a rejected listing must not reach a provider",
    );
    const r = await fetch(f.url + "api/settings/models", {
      method: "POST",
      headers: controlHeaders(f.c.publicOrigin),
      body: '{"provider":"zai"}',
    });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).source, "provider");
    assert.equal(f.listings.length, 1);
  } finally {
    await f.close();
  }
});

test("listing rejects an unknown provider and a bad endpoint", async () => {
  const f = await settingsFixture();
  const post = async (payload) =>
    (
      await fetch(f.url + "api/settings/models", {
        method: "POST",
        headers: controlHeaders(f.c.publicOrigin),
        body: JSON.stringify(payload),
      })
    ).status;
  try {
    assert.equal(await post({ provider: "evil" }), 400);
    assert.equal(await post({}), 400);
    assert.equal(
      await post({
        provider: "ollama",
        endpoint: "http://user:pw@host/v1",
      }),
      400,
    );
    assert.equal(
      await post({ provider: "ollama", endpoint: "ftp://host/v1" }),
      400,
    );
    // A fixed-URL provider cannot be re-pointed by a typed endpoint.
    assert.equal(
      await post({ provider: "zai", endpoint: "http://attacker.example/v1" }),
      400,
    );
  } finally {
    await f.close();
  }
});

test("an owner-supplied endpoint never receives the stored provider key", async () => {
  const f = await settingsFixture();
  try {
    await fetch(f.url + "api/settings", {
      method: "POST",
      headers: controlHeaders(f.c.publicOrigin),
      body: JSON.stringify({
        provider: "zai",
        model: "glm-4.7-flash",
        apiKey: "server-test-key-7777",
      }),
    });
    await fetch(f.url + "api/settings/models", {
      method: "POST",
      headers: controlHeaders(f.c.publicOrigin),
      body: JSON.stringify({
        provider: "ollama",
        endpoint: "http://192.0.2.1:11434/v1",
      }),
    });
    const call = f.listings.at(-1);
    // The key belongs to Zai. Listing models for a local provider must not carry
    // it to the typed host.
    assert.equal(call.provider, "ollama");
    assert.equal(call.apiKey, null);
  } finally {
    await f.close();
  }
});

test("an Ollama selection saves with its endpoint and no key", async () => {
  const f = await settingsFixture();
  try {
    const r = await fetch(f.url + "api/settings", {
      method: "POST",
      headers: controlHeaders(f.c.publicOrigin),
      body: JSON.stringify({
        provider: "ollama",
        model: "deepscaler:latest",
        endpoint: "http://127.0.0.1:11434/v1",
      }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.current.provider, "ollama");
    assert.equal(body.current.hasKey, false);
    assert.equal(body.current.endpoint, "http://127.0.0.1:11434/v1");
    assert.ok(body.providers.find((p) => p.id === "ollama").endpoint === true);
    // The audit record must not contain the typed endpoint.
    const change = f.store
      .recent(50)
      .filter((e) => e.kind === "control")
      .at(-1);
    assert.equal(change.local, true);
    assert.equal(change.endpoint, undefined);
  } finally {
    await f.close();
  }
});

test("api/state carries a build id so the dashboard can detect a stale backend", () => {
  // public/ is re-read per request while src/ is cached at import, so a
  // frontend-only deploy leaves the browser on a newer version than the API.
  // That presented as "connection failed" for every provider because the
  // settings routes 404'd. The build id makes that mismatch explicit.
  const c = config(),
    store = new Store(":memory:", c);
  const e = new Engine({
    config: c,
    store,
    exchange: {},
    market: { prices: () => ({}), snapshot: () => [], coverage: () => null },
    laya: {},
    model: {
      resolve: () => ({
        provider: "deepseek",
        model: "deepseek-flash",
        baseUrl: "https://api.deepseek.com",
        key: "k",
        allowNoKey: false,
        apiKeyEnv: "BEEBOTS_MODEL_KEY",
        local: false,
      }),
    },
  });
  try {
    const snap = e.snapshot();
    assert.equal(typeof snap.build, "string");
    assert.match(snap.build, /^\d+\.\d+\.\d+$/);
  } finally {
    store.close();
  }
});

test("the review endpoint is authenticated, control-gated and fire-and-forget", async () => {
  const c = config(),
    store = new Store(":memory:", c);
  let runs = 0;
  const engine = {
    reviewing: false,
    review: async () => {
      runs++;
      engine.reviewing = true;
      await new Promise((r) => setImmediate(r));
      engine.reviewing = false;
    },
    snapshot: () => ({
      mode: "observe",
      bots: [],
      reviewing: engine.reviewing,
    }),
  };
  const server = createServer({ config: c, store, engine });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/beebots/`;
  try {
    assert.equal(
      (await fetch(url + "api/review/run", { method: "POST" })).status,
      401,
    );
    assert.equal(
      (
        await fetch(url + "api/review/run", {
          method: "POST",
          headers: { ...headers },
        })
      ).status,
      403,
    );
    const ok = await fetch(url + "api/review/run", {
      method: "POST",
      headers: controlHeaders(c.publicOrigin),
    });
    assert.equal(ok.status, 202);
    assert.equal((await ok.json()).started, true);
    assert.equal(runs, 1);
  } finally {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    store.close();
  }
});

test("the review endpoint reports started:false while a review is running", async () => {
  const c = config(),
    store = new Store(":memory:", c);
  const engine = {
    reviewing: true,
    review: async () => {},
    snapshot: () => ({ mode: "observe", bots: [] }),
  };
  const server = createServer({ config: c, store, engine });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/beebots/`;
  try {
    const r = await fetch(url + "api/review/run", {
      method: "POST",
      headers: controlHeaders(c.publicOrigin),
    });
    assert.equal(r.status, 202);
    assert.equal((await r.json()).started, false);
  } finally {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    store.close();
  }
});
