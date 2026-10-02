import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { DecisionModel } from "../src/model.mjs";
import { Engine } from "../src/engine.mjs";
// Captures the request body so per-model parameters can be asserted.
let lastRequest = null;
async function answer(d, fn, usage) {
  const server = http.createServer((req, res) => {
    let text = "";
    req.on("data", (c) => (text += c));
    req.on("end", () => {
      lastRequest = text ? JSON.parse(text) : null;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(d) } }],
          ...(usage ? { usage } : {}),
        }),
      );
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn(
      new DecisionModel({
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        name: "test",
        allowNoKey: true,
      }),
    );
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

// A resolver drives provider/model selection without touching the filesystem.
// The endpoint stays the local fixture so no request leaves the test.
function resolver(provider, model, baseUrl) {
  return {
    effective: () => ({
      provider,
      model,
      baseUrl,
      key: "test-key",
      allowNoKey: true,
      apiKeyEnv: "BEEBOTS_MODEL_KEY",
    }),
  };
}

// answer() with a provider/model selection in play. The endpoint remains the
// local fixture server so nothing leaves the test.
async function withProvider(provider, model, usage, fn) {
  const server = http.createServer((req, res) => {
    let text = "";
    req.on("data", (c) => (text += c));
    req.on("end", () => {
      lastRequest = text ? JSON.parse(text) : null;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: "SKIP",
                  product: null,
                  reason: "No setup",
                }),
              },
            },
          ],
          ...(usage ? { usage } : {}),
        }),
      );
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(
      new DecisionModel(
        { baseUrl, name: "fallback", allowNoKey: true },
        45000,
        resolver(provider, model, baseUrl),
      ),
    );
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

test("thinking is disabled only for models that permit it", async () => {
  // GLM-4.7-Flash reasons compulsively unless told not to; Zai returns code
  // 1210 if thinking:disabled is sent to a model that always reasons.
  await withProvider("zai", "glm-4.7-flash", null, async (m) => {
    await m.decide({ strategy: "x", bot: { position: null }, candidates: [] });
  });
  assert.equal(lastRequest.model, "glm-4.7-flash");
  assert.deepEqual(lastRequest.thinking, { type: "disabled" });
  assert.deepEqual(lastRequest.response_format, { type: "json_object" });
  assert.ok(lastRequest.max_tokens > 0);

  // GLM-5.3-Flash always reasons, so no thinking field may be sent at all.
  await withProvider("zai", "glm-5.3-flash", null, async (m) => {
    await m.decide({ strategy: "x", bot: { position: null }, candidates: [] });
  });
  assert.equal(lastRequest.model, "glm-5.3-flash");
  assert.equal(lastRequest.thinking, undefined);
});

test("a transient overload is retried once; an auth error is not", async () => {
  test("a free-tier rate limit waits longer than an overloaded backend", async () => {
    // Zai reports overload as in-body 1305 but the rate limit as HTTP 429 (or
    // in-body 1302). Both are retried once, the rate limit with a longer pause.
    const elapsed = {};
    for (const kind of ["overloaded", "rate-limited"]) {
      let attempts = 0;
      const server = http.createServer((req, res) => {
        req.resume();
        attempts++;
        res.setHeader("Content-Type", "application/json");
        if (attempts === 1) {
          if (kind === "rate-limited") {
            res.statusCode = 429;
            res.end("{}");
          } else {
            res.end(
              JSON.stringify({ error: { code: 1305, message: "overloaded" } }),
            );
          }
          return;
        }
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: '{"action":"SKIP","product":null,"reason":"x"}',
                },
              },
            ],
          }),
        );
      });
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      const baseUrl = `http://127.0.0.1:${server.address().port}`;
      const started = Date.now();
      try {
        const m = new DecisionModel(
          { baseUrl, name: "glm-4.7-flash", allowNoKey: true },
          45000,
          resolver("zai", "glm-4.7-flash", baseUrl),
        );
        const d = await m.decide({
          strategy: "x",
          bot: { position: null },
          candidates: [],
        });
        assert.equal(d.action, "SKIP", kind);
        assert.equal(attempts, 2, `${kind} retried once`);
      } finally {
        server.closeAllConnections();
        await new Promise((r) => server.close(r));
      }
      elapsed[kind] = Date.now() - started;
    }
    // 8000ms backoff versus 1500ms, with request time subtracted out.
    assert.ok(
      elapsed["rate-limited"] > elapsed.overloaded + 3000,
      `rate-limit backoff (${elapsed["rate-limited"]}ms) must exceed overload (${elapsed.overloaded}ms)`,
    );
  });
  test("no retry is attempted when the deadline cannot absorb the wait", async () => {
    // With an 8s backoff and a 3s budget there is no room, so the call fails once
    // rather than hanging past its own timeout.
    let attempts = 0;
    const server = http.createServer((req, res) => {
      req.resume();
      attempts++;
      res.statusCode = 429;
      res.end("{}");
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    try {
      const m = new DecisionModel(
        { baseUrl, name: "glm-4.7-flash", allowNoKey: true },
        3000,
        resolver("zai", "glm-4.7-flash", baseUrl),
      );
      await assert.rejects(
        m.decide({ strategy: "x", bot: { position: null }, candidates: [] }),
        /HTTP 429/,
      );
      assert.equal(
        attempts,
        1,
        "no retry when the deadline cannot absorb the wait",
      );
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });
  let attempts = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    attempts++;
    res.setHeader("Content-Type", "application/json");
    if (attempts === 1) {
      // Zai reports overload with HTTP 200 and an in-body code.
      res.end(JSON.stringify({ error: { code: 1305, message: "overloaded" } }));
      return;
    }
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: '{"action":"SKIP","product":null,"reason":"x"}',
            },
          },
        ],
      }),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const m = new DecisionModel(
      { baseUrl, name: "glm-4.7-flash", allowNoKey: true },
      45000,
      resolver("zai", "glm-4.7-flash", baseUrl),
    );
    const d = await m.decide({
      strategy: "x",
      bot: { position: null },
      candidates: [],
    });
    assert.equal(d.action, "SKIP");
    assert.equal(attempts, 2, "one retry, then success");
    assert.equal(d.provider, "zai");
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }

  // A 401 is not transient; repeating it cannot help.
  let authAttempts = 0;
  const authServer = http.createServer((req, res) => {
    req.resume();
    authAttempts++;
    res.statusCode = 401;
    res.end("{}");
  });
  await new Promise((r) => authServer.listen(0, "127.0.0.1", r));
  const authUrl = `http://127.0.0.1:${authServer.address().port}`;
  try {
    const m = new DecisionModel(
      { baseUrl: authUrl, name: "glm-4.7-flash", allowNoKey: true },
      45000,
      resolver("zai", "glm-4.7-flash", authUrl),
    );
    await assert.rejects(
      m.decide({ strategy: "x", bot: { position: null }, candidates: [] }),
      /HTTP 401/,
    );
    assert.equal(authAttempts, 1, "auth failures are not retried");
  } finally {
    authServer.closeAllConnections();
    await new Promise((r) => authServer.close(r));
  }
});

test("provider token usage reaches the caller for costing", async () => {
  const usage = {
    prompt_tokens: 900,
    completion_tokens: 65,
    total_tokens: 994,
    prompt_tokens_details: { cached_tokens: 3 },
  };
  await withProvider("zai", "glm-4.7-flash", usage, async (m) => {
    const d = await m.decide({
      strategy: "x",
      bot: { position: null },
      candidates: [],
    });
    assert.deepEqual(d.usage, usage);
    assert.equal(d.model, "glm-4.7-flash");
    assert.equal(d.provider, "zai");
    assert.ok(d.providerName);
  });
});

test("an unknown model still works but claims no provider", async () => {
  await withProvider(null, "some-private-model", null, async (m) => {
    const d = await m.decide({
      strategy: "x",
      bot: { position: null },
      candidates: [],
    });
    assert.equal(d.model, "some-private-model");
    assert.equal(d.provider, null);
    assert.equal(d.providerName, null);
    // No catalogue entry means no capability flags are invented.
    assert.equal(lastRequest.thinking, undefined);
    assert.equal(lastRequest.response_format, undefined);
  });
});

test("a non-HTTPS endpoint is refused before a credential is sent", async () => {
  const m = new DecisionModel(
    { baseUrl: "http://example.com/v1", name: "x", allowNoKey: true },
    45000,
    resolver("deepseek", "deepseek-flash", "http://example.com/v1"),
  );
  await assert.rejects(
    m.decide({ strategy: "x", bot: { position: null }, candidates: [] }),
    /requires HTTPS or localhost/,
  );
});

test("verbose explanation remains valid and is preserved", () =>
  answer(
    { action: "SKIP", product: null, reason: "Evidence. ".repeat(100) },
    async (m) => {
      const d = await m.decide({
        strategy: "x",
        bot: { position: null },
        candidates: [],
      });
      assert.equal(d.reason, "Evidence. ".repeat(100));
    },
  ));

test("malformed actions and missing reasons remain rejected", async () => {
  for (const d of [
    null,
    [],
    { action: "TRADE", reason: "x" },
    { action: "SKIP", reason: 3 },
    { action: "SKIP", reason: " " },
  ]) {
    await answer(d, async (m) => {
      await assert.rejects(
        m.decide({ strategy: "x", bot: { position: null }, candidates: [] }),
        /Invalid decision schema:/,
      );
    });
  }
});

test("recovered analysis clears its warning without hiding another failure", () => {
  const e = {
    errors: new Map(),
    health: { error: null },
    setError: Engine.prototype.setError,
  };
  e.setError("analysis:trend", "Invalid decision schema");
  e.setError("protection:momentum", "Exchange unavailable");
  e.setError("analysis:trend", null);
  assert.equal(e.health.error, "Exchange unavailable");
  e.setError("protection:momentum", null);
  assert.equal(e.health.error, null);
});
test("model may not select an off-list asset", () =>
  answer({ action: "BUY", product: "FAKE-USDC", reason: "x" }, async (m) => {
    await assert.rejects(
      m.decide({
        strategy: "x",
        bot: { position: null },
        candidates: [{ product: "BTC-USDC" }],
      }),
      /Off-list/,
    );
  }));
test("the model may not exceed the position limit", () =>
  answer({ action: "BUY", product: "ETH-USDC", reason: "x" }, async (m) => {
    await assert.rejects(
      m.decide({
        strategy: "x",
        bot: { positions: [{ product: "BTC-USDC" }], maxPositions: 1 },
        candidates: [{ product: "BTC-USDC" }, { product: "ETH-USDC" }],
      }),
      /position limit/,
    );
  }));
test("the model may not buy a pair the bot already holds", () =>
  answer({ action: "BUY", product: "BTC-USDC", reason: "x" }, async (m) => {
    await assert.rejects(
      m.decide({
        strategy: "x",
        bot: { positions: [{ product: "BTC-USDC" }], maxPositions: 3 },
        candidates: [{ product: "BTC-USDC" }],
      }),
      /already held|held pair/,
    );
  }));
test("the model may not sell or hold a pair the bot does not hold", () =>
  answer({ action: "SELL", product: "BTC-USDC", reason: "x" }, async (m) => {
    await assert.rejects(
      m.decide({
        strategy: "x",
        bot: { positions: [{ product: "ETH-USDC" }], maxPositions: 3 },
        candidates: [{ product: "BTC-USDC" }, { product: "ETH-USDC" }],
      }),
      /unheld pair/,
    );
  }));
test("the model may open a new position while below the limit", () =>
  answer({ action: "BUY", product: "ETH-USDC", reason: "x" }, async (m) => {
    const r = await m.decide({
      strategy: "x",
      bot: { positions: [{ product: "BTC-USDC" }], maxPositions: 3 },
      candidates: [{ product: "BTC-USDC" }, { product: "ETH-USDC" }],
    });
    assert.equal(r.action, "BUY");
    assert.equal(r.product, "ETH-USDC");
  }));
test("the model may sell any one of several held positions", () =>
  answer({ action: "SELL", product: "SOL-USDC", reason: "x" }, async (m) => {
    const r = await m.decide({
      strategy: "x",
      bot: {
        positions: [{ product: "BTC-USDC" }, { product: "SOL-USDC" }],
        maxPositions: 3,
      },
      candidates: [{ product: "BTC-USDC" }, { product: "SOL-USDC" }],
    });
    assert.equal(r.action, "SELL");
    assert.equal(r.product, "SOL-USDC");
  }));
test("model result does not propagate extra fields into audit events", () =>
  answer(
    { action: "SKIP", product: null, reason: "No setup", kind: "fill", id: 12 },
    async (m) => {
      const r = await m.decide({
        strategy: "x",
        bot: { position: null },
        candidates: [],
      });
      assert.equal(r.kind, undefined);
      assert.equal(r.id, undefined);
      assert.equal(r.action, "SKIP");
    },
  ));

// A fixture for the review endpoint. `reply(n, body)` returns the raw message
// content for call n (1-based), so the parse and retry paths can be exercised.
async function reviewServer(reply, fn) {
  let calls = 0;
  const server = http.createServer((req, res) => {
    let text = "";
    req.on("data", (c) => (text += c));
    req.on("end", () => {
      calls++;
      lastRequest = text ? JSON.parse(text) : null;
      const { content, finish_reason } = reply(calls, lastRequest);
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          choices: [{ message: { content }, finish_reason }],
        }),
      );
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn(
      new DecisionModel({
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        name: "test",
        allowNoKey: true,
      }),
      () => calls,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

test("the review reads JSON even when the model wraps it in prose", async () => {
  await reviewServer(
    () => ({
      content:
        'Here is the review:\n```json\n{"summary":"ok","proposals":[]}\n```\nDone.',
    }),
    async (m) => {
      const r = await m.review("sys", "user", 1000);
      assert.equal(r.data.summary, "ok");
    },
  );
});

test("a length-truncated review is reported as truncated, not as invalid JSON", async () => {
  await reviewServer(
    () => ({ content: '{"summary":"cut off', finish_reason: "length" }),
    async (m) => {
      await assert.rejects(m.review("sys", "user", 1000), /truncated/);
    },
  );
});

test("the review retries once when the first reply has no JSON", async () => {
  await reviewServer(
    (n) =>
      n === 1
        ? { content: "I cannot comply with that request." }
        : { content: '{"summary":"retry ok","proposals":[]}' },
    async (m, calls) => {
      const r = await m.review("sys", "user", 1000);
      assert.equal(r.data.summary, "retry ok");
      assert.equal(calls(), 2);
    },
  );
});

test("the review reports not-JSON only after the retry also fails", async () => {
  await reviewServer(
    () => ({ content: "still no object here" }),
    async (m, calls) => {
      await assert.rejects(m.review("sys", "user", 1000), /not JSON/);
      assert.equal(calls(), 2);
    },
  );
});
