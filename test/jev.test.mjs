import test from "node:test";
import assert from "node:assert/strict";
import { Jev } from "../src/jev.mjs";

// A TypeSafe-shaped answer builder, so tests never touch the network.
function fakeClient(overrides = {}) {
  const client = {
    calls: 0,
    last: null,
    result: {
      model: "jev-1.13.0",
      answers: {
        action: {
          type: "choice",
          choice: "SKIP",
          confidence: 0.9,
          probabilities: { SKIP: 1 },
        },
        conviction: { type: "score", score: 2 },
      },
      usage: { input_tokens: 100, output_tokens: 0 },
      ...overrides,
    },
    error: null,
    systemOne(req, opts) {
      this.calls++;
      this.last = { req, opts };
      if (this.error) return Promise.reject(this.error);
      return Promise.resolve(this.result);
    },
  };
  return client;
}

const withKey = (key = "jev-test-key", model = "jev-1.13.0") => ({
  effectiveJev: () => ({ key, model }),
});

function clearEnv() {
  delete process.env.TYPESAFE_API_KEY;
}

test("Jev picks a move and scores its conviction", async () => {
  const client = fakeClient();
  const jev = new Jev({ client }, withKey());
  const r = await jev.decide({
    state: { bot: "breakout" },
    menu: { SKIP: "No trade", "BUY BTC-USDC": "Enter BTC" },
    convictionLabels: ["very weak", "weak", "moderate", "strong"],
  });
  assert.equal(r.ok, true);
  assert.equal(r.choice, "SKIP");
  assert.equal(r.conviction, 2);
  assert.equal(r.model, "jev-1.13.0");
  assert.equal(r.inputTokens, 100);
  assert.ok(r.costUsd > 0);
  // The request carried the model and the two questions only.
  assert.equal(client.last.req.model, "jev-1.13.0");
  assert.equal(client.last.req.questions.action.type, "choice");
  assert.equal(client.last.req.questions.conviction.type, "score");
});

test("no key fails closed without reaching the network", async () => {
  clearEnv();
  const client = fakeClient();
  const jev = new Jev(
    { client },
    { effectiveJev: () => ({ key: null, model: "jev-1.13.0" }) },
  );
  const r = await jev.decide({
    state: {},
    menu: { SKIP: "x" },
    convictionLabels: [],
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "no_key");
  assert.equal(client.calls, 0);
  await assert.rejects(() => jev.systemOne({}, {}), /key unavailable/i);
});

test("TYPESAFE_API_KEY is the fallback when settings have none", async () => {
  process.env.TYPESAFE_API_KEY = "env-jev-key";
  try {
    const client = fakeClient();
    const jev = new Jev({ client }, null);
    assert.equal(jev.hasKey(), true);
    const r = await jev.decide({
      state: {},
      menu: { SKIP: "x" },
      convictionLabels: [],
    });
    assert.equal(r.ok, true);
  } finally {
    clearEnv();
  }
});

test("an off-menu choice is refused", async () => {
  const client = fakeClient({
    answers: {
      action: { type: "choice", choice: "BUY NOPE-USDC", confidence: 0.5 },
      conviction: { type: "score", score: 1 },
    },
  });
  const jev = new Jev({ client }, withKey());
  const r = await jev.decide({
    state: {},
    menu: { SKIP: "No trade" },
    convictionLabels: ["weak"],
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "OFF_MENU");
});

test("the daily cap stops calls before they are sent", async () => {
  const client = fakeClient();
  const jev = new Jev({ client, dailyUsdCap: 0 }, withKey());
  assert.equal(jev.capTripped, true);
  const r = await jev.decide({
    state: {},
    menu: { SKIP: "x" },
    convictionLabels: [],
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "daily_cap");
  assert.equal(client.calls, 0);
});

test("a rate limit backs off and the next call does not hit the network", async () => {
  const client = fakeClient();
  client.error = Object.assign(Error("rate limited"), { status: 429 });
  const jev = new Jev({ client }, withKey());
  const first = await jev.decide({
    state: {},
    menu: { SKIP: "x" },
    convictionLabels: [],
  });
  assert.equal(first.ok, false);
  assert.equal(first.reason, "backoff");
  const before = client.calls;
  const second = await jev.decide({
    state: {},
    menu: { SKIP: "x" },
    convictionLabels: [],
  });
  assert.equal(second.reason, "backoff");
  assert.equal(client.calls, before, "backoff suppresses the second call");
});

test("probe sends a tiny real check and discards the answer", async () => {
  const client = fakeClient();
  const jev = new Jev({ client }, withKey());
  const r = await jev.probe();
  assert.deepEqual(r, { ok: true, model: "jev-1.13.0" });
  assert.deepEqual(client.last.req.questions.ok.criteria, {
    YES: "Yes",
    NO: "No",
  });
});
