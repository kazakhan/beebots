import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.mjs";
import { Engine } from "../src/engine.mjs";
import { config } from "./helpers.mjs";

// Laya is optional evidence. With it disabled the model decides on the raw
// metrics; with it enabled but failing, the candidate degrades rather than the
// whole bot cycle aborting.
function fixture({ layaEnabled, layaThrows = false }) {
  const c = config();
  c.mode = "live";
  c.decisionIntervalMs = 0;
  c.strategyVersion = 2;
  c.layaEnabled = layaEnabled;
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
    snapshot: (id) => products.map(row),
    prices: () => Object.fromEntries(products.map((p) => [p, 101])),
    quote: async () => ({
      bid: 100.99,
      ask: 101,
      at: Date.now(),
      bids: [{ price: "100.99", size: "1000" }],
      asks: [{ price: "101", size: "1000" }],
    }),
  };
  const seen = [];
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
    decide: async ({ candidates }) => {
      seen.push(candidates);
      return {
        action: "SKIP",
        product: null,
        reason: "observe",
        provider: "deepseek",
        model: "deepseek-flash",
      };
    },
  };
  const laya = {
    analyze: async () => {
      if (layaThrows) throw Error("Laya socket unavailable");
      return {
        answers: {
          fit: { score: 1.2 },
          regime: { choice: "range" },
          quality: { choice: "mixed" },
        },
        queue_depth: 0,
      };
    },
  };
  const engine = new Engine({
    config: c,
    store: s,
    exchange: {},
    market,
    laya,
    model,
  });
  return { s, engine, seen };
}

test("with Laya disabled the model still reviews every candidate", async () => {
  const { s, engine, seen } = fixture({ layaEnabled: false });
  await engine.cycle();
  const breakout = seen.filter((c) => c.length);
  assert.ok(breakout.length, "the model was consulted");
  const candidates = breakout[0];
  assert.equal(candidates.length, 2);
  // No analysis is attached when Laya is off; the model sees the metrics only.
  assert.ok(
    candidates.every((c) => c.analysis === undefined),
    "candidates carry no Laya analysis",
  );
  assert.equal(engine.health.laya.disabled, true);
  s.close();
});

test("a failing Laya degrades the candidate instead of aborting the bot", async () => {
  const { s, engine, seen } = fixture({ layaEnabled: true, layaThrows: true });
  await engine.cycle();
  assert.ok(seen.filter((c) => c.length).length, "the bot still decided");
  const candidates = seen.filter((c) => c.length)[0];
  // The candidate survived without analysis rather than the cycle erroring.
  assert.equal(candidates.length, 2);
  assert.ok(candidates.every((c) => c.analysis === undefined));
  assert.equal(
    [...engine.errors.keys()].some((k) => k.startsWith("analysis:")),
    false,
    "no per-bot analysis error",
  );
  s.close();
});

test("with Laya enabled and working, analysis is attached and ranked", async () => {
  const { s, engine, seen } = fixture({ layaEnabled: true, layaThrows: false });
  await engine.cycle();
  const candidates = seen.filter((c) => c.length)[0];
  assert.ok(
    candidates.every((c) => c.analysis),
    "analysis attached",
  );
  assert.equal(engine.health.laya.ready, true);
  s.close();
});
