import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.mjs";
import { Engine } from "../src/engine.mjs";
import { Refusal } from "../src/refusal.mjs";
import { config } from "./helpers.mjs";

// One bot cycle per engine, with every component stubbed. Proves the dispatch:
// which component is asked, what it is asked, and whether the LLM is consulted.
function fixture({ engine, jevResult, layaResult } = {}) {
  const c = config();
  c.mode = "live";
  c.decisionIntervalMs = 0;
  c.strategyVersion = 2;
  const s = new Store(":memory:", c);
  s.change((st) => {
    st.paused = false;
  });
  const products = ["AAA-USDC", "BBB-USDC"];
  const row = (product) => ({
    product,
    category: "meme",
    strategyVersion: "2.0.0",
    setupEligible: true,
    signalTime: Math.floor(Date.now() / 300000) * 300000,
    at: Date.now(),
    close: 101,
    channelHigh: 100.5,
    stopPrice: 95,
    maxEntry: 103,
    atr: 1,
    rankScore: 1,
  });
  const market = {
    held: [],
    refresh: async () => {},
    snapshot: () => products.map(row),
    prices: () => Object.fromEntries(products.map((p) => [p, 101])),
    quote: async () => ({
      bid: 100.99,
      ask: 101,
      at: Date.now(),
      bids: [{ price: "100.99", size: "1000" }],
      asks: [{ price: "101", size: "1000" }],
    }),
  };
  const seen = { model: [], jev: [], laya: [] };
  const model = {
    resolve: () => ({
      provider: "deepseek",
      model: "deepseek-flash",
      baseUrl: "https://api.deepseek.com",
      key: "k",
      allowNoKey: false,
      apiKeyEnv: "K",
      local: false,
    }),
    decide: async (args) => {
      seen.model.push(args);
      return {
        action: "SKIP",
        product: null,
        reason: "llm observe",
        provider: "deepseek",
        model: "deepseek-flash",
      };
    },
  };
  const laya = {
    analyze: async () => ({
      answers: {
        fit: { score: 1.2 },
        regime: { choice: "range" },
        quality: { choice: "mixed" },
      },
      queue_depth: 0,
    }),
    decide: async (args) => {
      seen.laya.push(args);
      return (
        layaResult ?? {
          ok: true,
          choice: "SKIP",
          probabilities: { SKIP: 1 },
          confidence: 0.9,
          convictionRaw: 2,
          model: "laya",
        }
      );
    },
  };
  const jev = {
    decide: async (args) => {
      seen.jev.push(args);
      return (
        jevResult ?? {
          ok: true,
          choice: "SKIP",
          probabilities: { SKIP: 1 },
          confidence: 0.9,
          convictionRaw: 2,
          inputTokens: 1000,
          costUsd: 0.000042,
          model: "jev-1.13.0",
        }
      );
    },
  };
  const settings = engine ? { engineValue: () => engine } : null;
  const eng = new Engine({
    config: c,
    store: s,
    exchange: {},
    market,
    laya,
    model,
    jev,
    settings,
  });
  return { s, engine: eng, seen };
}

const lastDecision = (s, id) => s.read().bots[id].lastDecision;

test("Laya alone decides and the LLM is never consulted", async () => {
  const { s, engine, seen } = fixture({ engine: "laya" });
  await engine.cycle();
  assert.equal(seen.model.length, 0, "the LLM was not asked");
  assert.ok(seen.laya.length >= 1, "Laya was asked for the bot");
  const menu = seen.laya[0].menu;
  assert.ok(Object.hasOwn(menu, "BUY AAA-USDC"));
  assert.ok(Object.hasOwn(menu, "SKIP"));
  const d = lastDecision(s, "breakout");
  assert.equal(d.action, "SKIP");
  assert.match(d.reason, /Laya chose SKIP/);
  s.close();
});

test("Jev alone decides from the same menu and the LLM is not consulted", async () => {
  const { s, engine, seen } = fixture({ engine: "jev" });
  await engine.cycle();
  assert.equal(seen.model.length, 0);
  assert.ok(seen.jev.length >= 1);
  assert.ok(Object.hasOwn(seen.jev[0].menu, "BUY BBB-USDC"));
  const d = lastDecision(s, "breakout");
  assert.equal(d.action, "SKIP");
  assert.match(d.reason, /Jev \(TypeSafe\) chose SKIP/);
  s.close();
});

test("Jev + LLM passes Jev's answer to the LLM as evidence", async () => {
  const { s, engine, seen } = fixture({
    engine: "jev+llm",
    jevResult: {
      ok: true,
      choice: "BUY AAA-USDC",
      probabilities: { "BUY AAA-USDC": 0.7, SKIP: 0.3 },
      confidence: 0.7,
      conviction: 2,
      convictionRaw: 2,
      model: "jev-1.13.0",
    },
  });
  await engine.cycle();
  assert.ok(seen.jev.length >= 1, "Jev was consulted");
  assert.ok(seen.model.length >= 1, "the LLM decided");
  const evidence = seen.model[0].evidence;
  assert.equal(evidence.engine, "jev");
  assert.equal(evidence.choice, "BUY AAA-USDC");
  assert.equal(evidence.action, "BUY");
  assert.equal(evidence.product, "AAA-USDC");
  assert.equal(evidence.conviction, 2);
  s.close();
});

test("a Jev failure in Jev + LLM is not fatal: the LLM still decides", async () => {
  const { s, engine, seen } = fixture({
    engine: "jev+llm",
    jevResult: { ok: false, reason: "error", error: { message: "down" } },
  });
  await engine.cycle();
  assert.ok(seen.jev.length >= 1);
  assert.ok(seen.model.length >= 1);
  assert.equal(seen.model[0].evidence, null, "no evidence attached");
  assert.equal(lastDecision(s, "breakout").action, "SKIP");
  s.close();
});

test("a failing Jev-only engine holds the bot and records the error", async () => {
  const { s, engine } = fixture({
    engine: "jev",
    jevResult: { ok: false, reason: "daily_cap" },
  });
  await engine.cycle();
  assert.equal(
    [...engine.errors.keys()].some((k) => k === "analysis:breakout"),
    true,
    "the failure is surfaced per bot",
  );
  s.close();
});

test("a Jev decision is recorded in the day-scoped ledger", async () => {
  const { s, engine } = fixture({ engine: "jev" });
  await engine.cycle();
  const u = s.normaliseUsage(s.read().modelUsage);
  const rows = Object.values(u?.perModel ?? {}).filter(
    (p) => p.provider === "jev",
  );
  assert.ok(rows.length, "a Jev row is written");
  assert.ok(rows[0].calls >= 1, "the call is counted");
  assert.ok(BigInt(rows[0].costNanos) > 0n, "the estimated cost is recorded");
  assert.ok(rows[0].tokens >= 1000, "input tokens are recorded");
  s.close();
});

test("the Jev daily cap is restored from the ledger on construction", () => {
  const c = config();
  c.mode = "live";
  c.strategyVersion = 2;
  const s = new Store(":memory:", c);
  const day = new Date().toISOString().slice(0, 10);
  s.recordModelCall({
    day,
    provider: "jev",
    model: "jev-1.13.0",
    usage: { promptTokens: 1000, totalTokens: 1000 },
    costNanos: 1_500_000_000n,
  });
  const jevStub = {
    spentTodayUsd: 0,
    dailyUsdCap: 2,
    decide: async () => ({ ok: false, reason: "backoff" }),
  };
  new Engine({
    config: c,
    store: s,
    exchange: {},
    market: {
      refresh: async () => {},
      snapshot: () => [],
      prices: () => ({}),
      quote: async () => ({}),
    },
    laya: {},
    model: { resolve: () => ({}) },
    jev: jevStub,
  });
  assert.equal(jevStub.spentTodayUsd, 1.5, "1.5 USD restored");
  s.close();
});

// --- held products outside the strategy universe (3.0.1) ------------------
// A held product that has dropped out of the strategy universe must still be
// reviewed, quoted and valued; otherwise it is unmanageable and its bot cannot
// be marked. The full collected snapshot is the fallback.
test("a held product outside the strategy universe is still reviewed", async () => {
  const { s, engine, seen } = fixture({ engine: "laya+llm" });
  const row = (product) => ({
    product,
    category: "meme",
    strategyVersion: "2.0.0",
    setupEligible: true,
    signalTime: Math.floor(Date.now() / 300000) * 300000,
    at: Date.now(),
    close: 101,
    channelHigh: 100.5,
    stopPrice: 95,
    maxEntry: 103,
    atr: 1,
    rankScore: 1,
  });
  // The strategy universe lists only AAA; the full snapshot also holds ZZZ.
  engine.market.snapshot = (id) =>
    id ? [row("AAA-USDC")] : [row("AAA-USDC"), row("ZZZ-USDC")];
  engine.market.quote = async () => ({
    bid: 100.99,
    ask: 101,
    at: Date.now(),
    bids: [{ price: "100.99", size: "1000" }],
    asks: [{ price: "101", size: "1000" }],
  });
  s.change((st) => {
    st.bots.breakout.positions = [
      { product: "ZZZ-USDC", quantity: "1", cost: "100", opened: Date.now() },
    ];
  });
  await engine.cycle();
  const reviewed = seen.model.some((a) =>
    a.candidates.some((c) => c.product === "ZZZ-USDC"),
  );
  assert.ok(reviewed, "the held product reached the model");
  s.close();
});

// --- refusals are vetoes, not errors (3.0.4) ------------------------------
test("an expected refusal is logged as a veto, not an error", async () => {
  const { s, engine } = fixture({ engine: "laya+llm" });
  engine.execute = async () => {
    throw new Refusal("Depth impact exceeds risk budget");
  };
  engine.model.decide = async () => ({
    action: "BUY",
    product: "AAA-USDC",
    reason: "enter",
    model: "m",
    provider: null,
  });
  await engine.cycle();
  const rows = s.db.prepare("SELECT kind,body FROM events").all();
  assert.ok(
    rows.some((r) => r.kind === "veto" && r.body.includes("Depth impact")),
    "the refusal is a veto",
  );
  assert.equal(
    rows.filter((r) => r.kind === "error" && r.body.includes("Depth impact"))
      .length,
    0,
    "the refusal is not an error",
  );
  // The card must show that the chosen BUY was not executed.
  const d = s.read().bots.breakout.lastDecision;
  assert.equal(d.action, "BUY");
  assert.equal(d.executed, false);
  assert.match(d.refusal, /Depth impact/);
  s.close();
});

test("a submitted decision records executed", async () => {
  const { s, engine } = fixture({ engine: "laya+llm" });
  engine.execute = async () => "order-1";
  engine.model.decide = async () => ({
    action: "BUY",
    product: "AAA-USDC",
    reason: "enter",
    model: "m",
    provider: null,
  });
  await engine.cycle();
  const d = s.read().bots.breakout.lastDecision;
  assert.equal(d.action, "BUY");
  assert.equal(d.executed, true);
  assert.equal(d.refusal, null);
  s.close();
});

test("a genuine fault is still logged as an error", async () => {
  const { s, engine } = fixture({ engine: "laya+llm" });
  engine.execute = async () => {
    throw Error("ledger corrupted");
  };
  engine.model.decide = async () => ({
    action: "BUY",
    product: "AAA-USDC",
    reason: "enter",
    model: "m",
    provider: null,
  });
  await engine.cycle();
  const rows = s.db.prepare("SELECT kind,body FROM events").all();
  assert.ok(
    rows.some((r) => r.kind === "error" && r.body.includes("ledger corrupted")),
    "a fault is an error",
  );
  s.close();
});

test("Scout considers a non-meme market (no category gate)", async () => {
  const { s, engine, seen } = fixture({ engine: "laya+llm" });
  const row = (product) => ({
    product,
    category: "stablecoin",
    strategyVersion: "2.0.0",
    setupEligible: true,
    signalTime: Math.floor(Date.now() / 300000) * 300000,
    at: Date.now(),
    close: 101,
    channelHigh: 100.5,
    stopPrice: 95,
    maxEntry: 103,
    atr: 1,
    rankScore: 1,
  });
  engine.market.snapshot = (id) => [row("XYZ-USDC")];
  engine.market.quote = async () => ({
    bid: 100.99,
    ask: 101,
    at: Date.now(),
    bids: [{ price: "100.99", size: "1000" }],
    asks: [{ price: "101", size: "1000" }],
  });
  await engine.cycle();
  assert.ok(
    seen.model.some((a) => a.candidates.some((c) => c.product === "XYZ-USDC")),
    "a non-meme candidate reached the model",
  );
  s.close();
});
