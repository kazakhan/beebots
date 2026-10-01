import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.mjs";
import { Engine } from "../src/engine.mjs";
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
