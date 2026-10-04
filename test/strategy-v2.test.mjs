import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discover, classify } from "../src/universe.mjs";
import {
  aggregate,
  defaults,
  evaluate,
  rankMomentum,
  entryEligible,
  entryRejection,
  executionPlan,
  getTemplates,
  setTemplates,
  resolveTemplate,
} from "../src/strategy-v2.mjs";
import { migrateConfig } from "../src/migrate-v2.mjs";
import { validate } from "../src/config.mjs";
import { Store } from "../src/store.mjs";
import { Engine } from "../src/engine.mjs";
import { UniverseMarket } from "../src/collector.mjs";
import { fromTrades } from "../src/repair-candles.mjs";
import { Coinbase } from "../src/coinbase.mjs";
import { costOf, usageCounts } from "../src/providers.mjs";
import { config, buy, arm, exchangeOrder } from "./helpers.mjs";

test("v2 pipeline risk-sizes independent candidates and persists interval deduplication", async () => {
  const c = migrateConfig(config());
  c.mode = "live";
  c.decisionIntervalMs = 0;
  const s = new Store(":memory:", c);
  arm(s);
  let calls = 0;
  const submitted = [];
  const f = {
    product: "DOGE-USDC",
    category: "meme",
    strategyVersion: "2.0.0",
    setupEligible: true,
    signalTime: Math.floor(Date.now() / 300000) * 300000,
    at: Date.now(),
    close: 100,
    channelHigh: 99,
    stopPrice: 95,
    maxEntry: 101,
    atr: 2,
    rankScore: 1,
  };
  const quote = {
    bid: 99.99,
    ask: 100,
    at: Date.now(),
    bids: [{ price: "99.99", size: "100" }],
    asks: [{ price: "100", size: "100" }],
  };
  const exchange = {
    product: async () => ({
      product_id: "DOGE-USDC",
      product_type: "SPOT",
      quote_currency_id: "USDC",
      status: "online",
      base_increment: "0.000001",
      quote_increment: "0.01",
      base_min_size: "0.000001",
      quote_min_size: "1",
    }),
    accounts: async () => ({
      accounts: [
        {
          currency: "USDC",
          available_balance: {
            currency: "USDC",
            value: "306.335523648141718718854",
          },
        },
      ],
    }),
    fees: async () => ({ fee_tier: { taker_fee_rate: "0.001" } }),
    create: async (o) => {
      submitted.push(o);
      return {
        success: true,
        success_response: { order_id: "mock-" + submitted.length },
      };
    },
  };
  const market = {
    frames: new Map([["DOGE-USDC", {}]]),
    refresh: async () => {},
    snapshot: () => [{ ...f }],
    prices: () => ({ "DOGE-USDC": 100 }),
    quote: async () => quote,
  };
  const model = {
    decide: async () => {
      calls++;
      return {
        action: "BUY",
        product: "DOGE-USDC",
        reason: "fixture",
        usage: { total_tokens: 10 },
      };
    },
  };
  const laya = {
    analyze: async () => ({ answers: { fit: { score: 1 } }, queue_depth: 0 }),
  };
  const e = new Engine({ config: c, store: s, exchange, market, model, laya });
  // At a bar boundary frames can exist while the newly closed bar is unavailable.
  // Do not consume the interval and suppress a later valid assessment.
  const readySnapshot = market.snapshot;
  market.snapshot = () => [];
  await e.cycle();
  assert.equal(calls, 0);
  assert.equal(s.read().assessments?.breakout, undefined);
  // Visible, not silent: an empty snapshot still records a SKIP.
  assert.match(s.read().bots.breakout.lastDecision?.reason ?? "", /warming/);
  market.snapshot = readySnapshot;
  await e.cycle();
  assert.equal(submitted.length, 3);
  assert.equal(calls, 3);
  // Each entry is risk-sized: notional ~= riskBudget / stopPct * ask.
  assert.ok(submitted.every((o) => Number(o.size) < 40));
  assert.ok(
    Object.values(s.read().orders).every((o) => o.policy == null),
    "no strategy exit policy is attached (percentage exits only)",
  );
  // Reopening the same signal after a rejection must not issue duplicate assessments.
  for (const o of Object.values(s.read().orders)) s.reject(o.id);
  await e.cycle();
  assert.equal(calls, 3);
  assert.equal(s.read().modelUsage.tokens, 30);
  // The fixture model is uncatalogued, so tokens count and no cost is invented.
  assert.equal(s.read().modelUsage.costNanos, "0");
  assert.equal(s.read().modelUsage.calls, 3, "budget counted once per call");
  s.change((state) => {
    state.assessments = {};
  });
  market.snapshot = () => [{ ...f, setupEligible: false }];
  await e.cycle();
  assert.equal(
    calls,
    6,
    "Near misses still reach analysis and decision review",
  );
  assert.equal(s.read().modelUsage.tokens, 60);
  s.close();
});

test("a daily rollover resets calls, tokens and cost together", () => {
  const c = migrateConfig(config());
  const s = new Store(":memory:", c);
  const day = "2026-09-30";
  s.change((state) => {
    state.modelUsage = s.emptyUsage(day);
    state.modelUsage.calls = 5;
  });
  s.recordModelCall({
    day,
    provider: "zai",
    model: "glm-4.7-flash",
    usage: usageCounts({
      prompt_tokens: 900,
      completion_tokens: 65,
      total_tokens: 994,
      prompt_tokens_details: { cached_tokens: 3 },
    }),
    // A free model: tokens accrue, cost stays exactly zero.
    costNanos: costOf(
      {
        prompt_tokens: 900,
        completion_tokens: 65,
        prompt_tokens_details: { cached_tokens: 3 },
      },
      "zai",
      "glm-4.7-flash",
    ),
  });
  let u = s.read().modelUsage;
  assert.equal(u.tokens, 994);
  assert.equal(u.promptTokens, 900);
  assert.equal(u.completionTokens, 65);
  assert.equal(u.cachedTokens, 3);
  assert.equal(u.costNanos, "0");
  assert.equal(u.perModel["zai:glm-4.7-flash"].calls, 1);
  // The state row is JSON, so a BigInt cost would have thrown here.
  assert.equal(JSON.parse(JSON.stringify(s.read())).modelUsage.costNanos, "0");

  // A paid model under the same day accumulates a real cost.
  s.recordModelCall({
    day,
    provider: "deepseek",
    model: "deepseek-flash",
    usage: usageCounts({ prompt_tokens: 1_000_000, completion_tokens: 0 }),
    costNanos: 150_000_000n,
  });
  u = s.read().modelUsage;
  assert.equal(u.costNanos, "150000000");
  assert.equal(u.perModel["deepseek:deepseek-flash"].costNanos, "150000000");
  assert.equal(
    Object.keys(u.perModel).length,
    2,
    "switching provider keeps the earlier model's spend visible",
  );

  // A new UTC day resets every counter together.
  s.recordModelCall({
    day: "2026-10-01",
    provider: "zai",
    model: "glm-4.7-flash",
    usage: usageCounts({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    }),
    costNanos: 0n,
  });
  u = s.read().modelUsage;
  assert.equal(u.day, "2026-10-01");
  assert.equal(u.calls, 0);
  assert.equal(u.tokens, 15);
  assert.equal(u.costNanos, "0");
  assert.deepEqual(Object.keys(u.perModel), ["zai:glm-4.7-flash"]);
  s.close();
});

test("an unpriced model records tokens without inventing a cost", () => {
  const c = migrateConfig(config());
  const s = new Store(":memory:", c);
  s.recordModelCall({
    day: "2026-09-30",
    provider: null,
    model: "some-private-model",
    usage: usageCounts({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
    }),
    costNanos: costOf({}, null, "some-private-model"),
  });
  const u = s.read().modelUsage;
  assert.equal(u.tokens, 150, "tokens are still counted");
  assert.equal(u.costNanos, "0", "null cost leaves the total untouched");
  assert.ok(u.perModel["custom:some-private-model"]);
  s.close();
});

test("omitted candle repair uses verified trades and labels truly empty intervals", () => {
  const previous = { close: "10" },
    trade = {
      product_id: "X-USD",
      time: new Date(110000).toISOString(),
      price: "11",
      size: "2",
    };
  const filled = fromTrades(
    { trades: [trade] },
    "X-USDC",
    "X-USD",
    100,
    300,
    previous,
  );
  assert.equal(filled.volume, "2");
  assert.equal(filled.close, "11");
  assert.equal(filled.source, "verified_trades");
  const empty = fromTrades(
    { trades: [] },
    "X-USDC",
    "X-USD",
    100,
    300,
    previous,
  );
  assert.equal(empty.volume, "0");
  assert.equal(empty.close, "10");
  assert.equal(empty.source, "verified_no_trades");
  assert.throws(
    () =>
      fromTrades(
        { trades: Array(1000).fill(trade) },
        "X-USDC",
        "X-USD",
        100,
        300,
        previous,
      ),
    /incomplete/,
  );
  assert.throws(
    () =>
      fromTrades(
        { trades: [{ ...trade, product_id: "FAKE" }] },
        "X-USDC",
        "X-USD",
        100,
        300,
        previous,
      ),
    /identity/,
  );
  assert.throws(
    () =>
      fromTrades(
        { trades: [{ ...trade, time: new Date(999000).toISOString() }] },
        "X-USDC",
        "X-USD",
        100,
        300,
        previous,
      ),
    /interval/,
  );
});
test("moving catalogue pagination deduplicates overlaps but rejects no-progress pages", async () => {
  const page = Array.from({ length: 1000 }, (_, i) => ({
    product_id: "P" + i,
  }));
  const c = new Coinbase({});
  c.call = async (_, a) => ({
    products: a.offset === 0 ? page : [page[999], { product_id: "LAST" }],
  });
  assert.equal((await c.products()).products.length, 1001);
  c.call = async () => ({ products: page });
  await assert.rejects(c.products(), /no progress/);
});
const product = (id, name, extra = {}) => ({
  product_id: id + "-USDC",
  base_currency_id: id,
  base_name: name,
  quote_currency_id: "USDC",
  product_type: "SPOT",
  status: "online",
  // Real order sizing, so these count as tradeable under the 3.0.1 discovery
  // check (universe.test.mjs covers the missing-metadata case).
  base_increment: "0.01",
  quote_increment: "0.01",
  base_min_size: "1",
  quote_min_size: "1",
  ...extra,
});
const bar = (i, close = 100) => ({
  time: i * 300000,
  open: close,
  high: close + 0.2,
  low: close - 0.2,
  close,
  volume: 100,
});

test("discovery covers all USDC products, respects restrictions and alias deduplication", () => {
  const rows = discover([
    product("DOGE", "Dogecoin"),
    product("AAA", "Asset A"),
    product("BBB", "Asset B", { view_only: true }),
    product("CCC", "Asset C", { alias: "AAA-USDC" }),
    product("DAI", "Dai"),
    { ...product("BTC", "Bitcoin"), quote_currency_id: "USD" },
  ]);
  assert.equal(rows.length, 5);
  assert.equal(rows.filter((x) => x.eligible).length, 2);
  assert.equal(rows[0].membership.category, "meme");
  assert.match(rows[3].reason, /Duplicate/);
  assert.match(rows[4].reason, /category/);
});
test("category matching requires both identity fields; overrides carry provenance", () => {
  const cats = [
    { id: "cat", symbol: "cat", name: "Real Cat", reviewed: "today" },
  ];
  assert.equal(
    classify(product("CAT", "Fake Cat"), {}, cats).category,
    "unclassified",
  );
  assert.equal(classify(product("CAT", "Real Cat"), {}, cats).category, "meme");
  assert.equal(
    classify(product("X", "X"), {
      X: { category: "speculative", source: "owner research" },
    }).category,
    "speculative",
  );
});
test("aggregation never invents incomplete 15 minute bars", () => {
  const rows = Array.from({ length: 7 }, (_, i) => bar(i));
  assert.equal(aggregate(rows, 900).length, 2);
  rows.splice(1, 1);
  assert.equal(aggregate(rows, 900).length, 1);
});
test("Scout uses a prior range and rejects chasing (any category)", () => {
  const f = evaluate(
    "breakout",
    scoutFrame(),
    { strategy: "range_breakout" },
    { category: "meme" },
  );
  assert.equal(f.channelHigh, 100.5);
  assert.equal(f.relativeVolume, 5);
  assert.equal(f.setupEligible, true, "Keeper core + range breakout");
  assert.equal(
    entryEligible("breakout", {
      ...f,
      setupEligible: true,
      ask: f.maxEntry + 0.01,
      bid: f.close,
    }),
    false,
    "chasing past maxEntry is rejected",
  );
  // Scout scans every tradeable category; membership is no longer a veto.
  const other = evaluate(
    "breakout",
    scoutFrame(),
    {},
    { category: "unclassified" },
  );
  assert.ok(!other.reasons.includes("Not in Scout speculative universe"));
});
test("momentum ranks common-hour full comparison data and enforces breadth", () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({
    product: "P" + i,
    rankTime: 10,
    momentum24hPct: i,
    momentum7dPct: i,
    reasons: [],
    setupEligible: true,
  }));
  rows.push({
    product: "STALE",
    rankTime: 9,
    momentum24hPct: 999,
    momentum7dPct: 999,
    reasons: [],
    setupEligible: true,
  });
  rankMomentum(rows);
  assert.deepEqual(
    rows.filter((x) => x.setupEligible).map((x) => x.product),
    ["P8", "P9"],
  );
  const small = rows
    .slice(0, 3)
    .map((x) => ({ ...x, reasons: [], setupEligible: true }));
  rankMomentum(small);
  assert.ok(small.every((x) => !x.setupEligible));
});
test("risk sizing checks depth and fees, not absolute turnover", () => {
  const f = { stopPrice: 95 },
    q = {
      ask: 100,
      bid: 99.99,
      asks: [{ price: "100", size: "10" }],
      bids: [{ price: "99.99", size: "10" }],
    },
    r = { riskPct: 1, tradeFraction: 0.9, maxCostRisk: 0.2 };
  const p = executionPlan(f, q, 100, 0.001, r);
  assert.ok(p.quote < 20 && p.quote > 19);
  assert.ok(p.quantity * 5.2 <= 1.000001);
  assert.throws(
    () =>
      executionPlan(
        f,
        { ...q, asks: [{ price: "100", size: "0.001" }] },
        100,
        0.001,
        r,
      ),
    /depth/,
  );
  assert.throws(
    () => executionPlan(f, q, 100, 0.01, { ...r, maxCostRisk: 0.1 }),
    /costs/,
  );
});
test("configuration migration removes inherited volume filters and preserves capital", () => {
  const original = config(),
    c = migrateConfig(original);
  validate(c);
  assert.equal(c.products, undefined);
  assert.equal(c.bots.breakout.minPeriodTurnover, undefined);
  assert.equal(c.bots.breakout.capital, "100");
  assert.equal(original.products.length, 3);
});
test("ledger reopen preserves old positions and exits exactly", () => {
  const dir = mkdtempSync(join(tmpdir(), "bee-migration-")),
    file = join(dir, "ledger.sqlite");
  try {
    const c = config();
    let s = new Store(file, c);
    arm(s);
    const o = buy(s);
    s.acknowledge(o.id, "exchange-" + o.id);
    s.applyOrder(o.id, exchangeOrder(o));
    const before = s.read();
    s.close();
    s = new Store(file, migrateConfig(c));
    assert.deepEqual(s.read(), before);
    s.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("new exit policy survives fills; closed-bar trailing stop never loosens", () => {
  const c = migrateConfig(config()),
    s = new Store(":memory:", c);
  arm(s);
  const policy = {
    version: "2.0.0",
    stopPrice: 95,
    initialRisk: 5,
    trailR: 2,
    trailAtr: 2,
    signalTime: 1,
    breakoutLevel: 100,
  };
  const o = s.reserve({
    bot: "breakout",
    product: "X-USDC",
    side: "BUY",
    size: "50",
    reserve: "51",
    policy,
  });
  s.acknowledge(o.id, "exchange-" + o.id);
  s.applyOrder(o.id, exchangeOrder(o, { filled_size: "0.5" }));
  assert.equal(s.read().bots.breakout.positions[0].policy.version, "2.0.0");
  const e = {
    store: s,
    market: {
      snapshot: () => [
        { product: "X-USDC", signalTime: 2, close: 115, atr: 2 },
      ],
    },
  };
  Engine.prototype.strategyExit.call(
    e,
    "breakout",
    s.read().bots.breakout.positions[0],
    { bid: 114 },
  );
  assert.equal(s.read().bots.breakout.positions[0].policy.stopPrice, 111);
  e.market.snapshot = () => [
    { product: "X-USDC", signalTime: 3, close: 113, atr: 5 },
  ];
  Engine.prototype.strategyExit.call(
    e,
    "breakout",
    s.read().bots.breakout.positions[0],
    { bid: 113 },
  );
  assert.equal(s.read().bots.breakout.positions[0].policy.stopPrice, 111);
  s.close();
});
test("incremental candle cache reuses complete periods", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bee-cache-"));
  const c = migrateConfig(config());
  c.dataDir = dir;
  const m = new UniverseMarket({}, c);
  let calls = 0;
  const end = Math.floor(Date.now() / 300000) * 300;
  const reader = {
    candles: async () => {
      calls++;
      return {
        candles: Array.from({ length: 300 }, (_, i) => ({
          start: String(end - (300 - i) * 300),
          open: "100",
          close: "100",
          high: "101",
          low: "99",
          volume: "1",
        })),
      };
    },
  };
  try {
    await m.candles(reader, "X-USDC", 300, "FIVE_MINUTE", 300);
    await m.candles(reader, "X-USDC", 300, "FIVE_MINUTE", 300);
    assert.equal(calls, 1);
  } finally {
    await m.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("full cache with a missing interior candle still repairs the gap", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bee-gap-"));
  const c = migrateConfig(config());
  c.dataDir = dir;
  const m = new UniverseMarket({}, c);
  const end = Math.floor(Date.now() / 300000) * 300;
  const rows = Array.from({ length: 301 }, (_, i) => ({
    start: String(end - (301 - i) * 300),
    open: "100",
    close: "100",
    high: "100",
    low: "100",
    volume: "1",
  }));
  const gap = rows[150].start;
  m.save(
    "X-USDC:300",
    rows.filter((x) => x.start !== gap),
  );
  let repairs = 0;
  try {
    const result = await m.candles(
      {
        candles: async () => ({ candles: [] }),
        trades: async () => {
          repairs++;
          return { trades: [] };
        },
      },
      "X-USDC",
      300,
      "FIVE_MINUTE",
      300,
    );
    assert.equal(repairs, 1);
    assert.equal(result.length, 300);
    assert.equal(
      result.find((x) => x.time === Number(gap) * 1000).source,
      "verified_no_trades",
    );
  } finally {
    await m.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a legacy usage row does not stop the v2 pipeline from trading", async () => {
  // End-to-end: the pre-2.1.0 shape on a live ledger must not abort the cycle.
  // This is the regression that broke production - the bot threw before it could
  // record a decision or place an order.
  const c = migrateConfig(config());
  c.mode = "live";
  c.decisionIntervalMs = 0;
  const s = new Store(":memory:", c);
  arm(s);
  const submitted = [];
  const f = {
    product: "DOGE-USDC",
    category: "meme",
    strategyVersion: "2.0.0",
    setupEligible: true,
    signalTime: Math.floor(Date.now() / 300000) * 300000,
    at: Date.now(),
    close: 100,
    channelHigh: 99,
    stopPrice: 95,
    maxEntry: 101,
    atr: 2,
    rankScore: 1,
  };
  const quote = {
    bid: 99.99,
    ask: 100,
    at: Date.now(),
    bids: [{ price: "99.99", size: "100" }],
    asks: [{ price: "100", size: "100" }],
  };
  const exchange = {
    product: async () => ({
      product_id: "DOGE-USDC",
      product_type: "SPOT",
      quote_currency_id: "USDC",
      status: "online",
      base_increment: "0.000001",
      quote_increment: "0.01",
      base_min_size: "0.000001",
      quote_min_size: "1",
    }),
    fees: async () => ({ fee_tier: { taker_fee_rate: "0.006" } }),
    accounts: async () => ({
      accounts: [
        {
          currency: "USDC",
          available_balance: {
            currency: "USDC",
            value: "306.335523648141718718854",
          },
        },
      ],
    }),
    fees: async () => ({ fee_tier: { taker_fee_rate: "0.001" } }),
    create: async (o) => {
      submitted.push(o);
      return { success: true, success_response: { order_id: "m" } };
    },
  };
  const market = {
    frames: new Map([["DOGE-USDC", {}]]),
    refresh: async () => {},
    snapshot: () => [{ ...f }],
    prices: () => ({ "DOGE-USDC": 100 }),
    quote: async () => quote,
  };
  const model = {
    resolve: () => ({
      provider: "deepseek",
      model: "deepseek-flash",
      baseUrl: "https://api.deepseek.com",
      key: "k",
      allowNoKey: false,
      apiKeyEnv: "BEEBOTS_MODEL_KEY",
      local: false,
    }),
    decide: async () => ({
      action: "BUY",
      product: "DOGE-USDC",
      reason: "fixture",
      provider: "deepseek",
      model: "deepseek-flash",
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 200,
        total_tokens: 1200,
        prompt_tokens_details: { cached_tokens: 100 },
      },
    }),
  };
  const laya = {
    analyze: async () => ({ answers: { fit: { score: 1 } }, queue_depth: 0 }),
  };
  // Seed the exact legacy row that was on the live ledger.
  const day = new Date().toISOString().slice(0, 10);
  s.change((state) => {
    state.modelUsage = { day, calls: 394, tokens: 120000 };
  });

  const e = new Engine({ config: c, store: s, exchange, market, model, laya });
  await e.cycle();

  assert.deepEqual(
    [...e.errors.entries()],
    [],
    "a legacy usage row must not raise a bot error",
  );
  assert.ok(submitted.length > 0, "the bot still trades");
  assert.ok(s.read().bots.breakout.lastDecision, "the decision was recorded");
  const u = s.read().modelUsage;
  // All three bots complete a cycle, each recording 1200 tokens.
  assert.equal(u.tokens, 120000 + 3 * 1200);
  assert.equal(u.promptTokens, 3 * 1000);
  assert.equal(u.perModel["deepseek:deepseek-flash"].calls, 3);
  assert.ok(
    !JSON.stringify(s.read()).includes('"promptTokens":null'),
    "no NaN leaked into persisted state",
  );
  s.close();
});

test("a usage write failure never prevents the decision from being recorded", async () => {
  const c = migrateConfig(config());
  c.mode = "live";
  c.decisionIntervalMs = 0;
  const s = new Store(":memory:", c);
  arm(s);
  const submitted = [];
  const f = {
    product: "DOGE-USDC",
    category: "meme",
    strategyVersion: "2.0.0",
    setupEligible: true,
    signalTime: Math.floor(Date.now() / 300000) * 300000,
    at: Date.now(),
    close: 100,
    channelHigh: 99,
    stopPrice: 95,
    maxEntry: 101,
    atr: 2,
    rankScore: 1,
  };
  const quote = {
    bid: 99.99,
    ask: 100,
    at: Date.now(),
    bids: [{ price: "99.99", size: "100" }],
    asks: [{ price: "100", size: "100" }],
  };
  const exchange = {
    product: async () => ({
      product_id: "DOGE-USDC",
      product_type: "SPOT",
      quote_currency_id: "USDC",
      status: "online",
      base_increment: "0.000001",
      quote_increment: "0.01",
      base_min_size: "0.000001",
      quote_min_size: "1",
    }),
    fees: async () => ({ fee_tier: { taker_fee_rate: "0.006" } }),
    accounts: async () => ({
      accounts: [
        {
          currency: "USDC",
          available_balance: {
            currency: "USDC",
            value: "306.335523648141718718854",
          },
        },
      ],
    }),
    fees: async () => ({ fee_tier: { taker_fee_rate: "0.001" } }),
    create: async (o) => {
      submitted.push(o);
      return { success: true, success_response: { order_id: "m" } };
    },
  };
  const market = {
    frames: new Map([["DOGE-USDC", {}]]),
    refresh: async () => {},
    snapshot: () => [{ ...f }],
    prices: () => ({ "DOGE-USDC": 100 }),
    quote: async () => quote,
  };
  const model = {
    resolve: () => ({
      provider: "deepseek",
      model: "deepseek-flash",
      baseUrl: "https://api.deepseek.com",
      key: "k",
      allowNoKey: false,
      apiKeyEnv: "BEEBOTS_MODEL_KEY",
      local: false,
    }),
    decide: async () => ({
      action: "BUY",
      product: "DOGE-USDC",
      reason: "fixture",
      provider: "deepseek",
      model: "deepseek-flash",
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
  };
  const laya = {
    analyze: async () => ({ answers: { fit: { score: 1 } }, queue_depth: 0 }),
  };
  const e = new Engine({ config: c, store: s, exchange, market, model, laya });
  // Make the telemetry write fail the way a corrupt row used to.
  s.recordModelCall = () => {
    throw Error("usage store unavailable");
  };
  await e.cycle();
  assert.ok(
    s.read().bots.breakout.lastDecision,
    "the decision survives a usage-write failure",
  );
  assert.ok(submitted.length > 0, "the order is still placed");
  s.close();
});

// --- Scout shares Keeper's core (3.3.8) ----------------------------------
// A 1h uptrend context, an orderly EMA20 pullback on the signal timeframe, and
// Scout's own range-breakout trigger.
function risingHour(n = 260, base = 100) {
  return Array.from({ length: n }, (_, i) => ({
    time: i * 3600000,
    open: base + i * 0.1,
    high: base + i * 0.1 + 1,
    low: base + i * 0.1 - 1,
    close: base + i * 0.1,
    volume: 1,
  }));
}
function scoutFrame({
  n = 210,
  base = 100,
  half = 0.5,
  lastVolume = 5,
  breakoutOffset = 0.5,
  closeBelowHigh = false,
  hour = risingHour(),
} = {}) {
  const five = [];
  for (let i = 0; i < n; i++)
    five.push({
      time: i * 300000,
      open: base,
      high: base + half,
      low: base - half,
      close: base,
      volume: 1,
    });
  const prior = five.slice(0, -1);
  const rangeHigh = Math.max(...prior.slice(-24).map((b) => b.high));
  const last = five[n - 1];
  const close = closeBelowHigh ? rangeHigh - 0.1 : rangeHigh + breakoutOffset;
  last.close = close;
  last.volume = lastVolume;
  last.high = close;
  last.low = close - 2 * half;
  return { five, hour, four: [] };
}
const meme = { category: "meme" };
const scout = (f, rules = defaults.breakout) =>
  evaluate("breakout", f, { ...rules, strategy: "range_breakout" }, meme);

test("Scout shares Keeper's core, with its own breakout trigger", () => {
  assert.equal(defaults.breakout.pullbackBars, 15);
  const f = scout(scoutFrame());
  assert.equal(f.setupEligible, true);
  assert.deepEqual(f.reasons, []);
  assert.ok(f.contextClose > f.ema20 && f.ema20 > f.ema50, "4h uptrend set");
});

test("Scout rejects a close below the range high", () => {
  const f = scout(scoutFrame({ closeBelowHigh: true }));
  assert.equal(f.setupEligible, false);
  assert.ok(f.reasons.includes("No completed breakout close"));
});

test("Scout requires the relative-volume surge", () => {
  assert.equal(scout(scoutFrame({ lastVolume: 2 })).setupEligible, true);
  const thin = scout(scoutFrame({ lastVolume: 1.9 }));
  assert.equal(thin.setupEligible, false);
  assert.ok(thin.reasons.includes("Relative volume insufficient"));
});

test("Scout rejects a market with no uptrend context", () => {
  const fall = Array.from({ length: 260 }, (_, i) => ({
    time: i * 3600000,
    open: 200 - i * 0.2,
    high: 200 - i * 0.2 + 1,
    low: 200 - i * 0.2 - 1,
    close: 200 - i * 0.2,
    volume: 1,
  }));
  const f = scout(scoutFrame({ hour: fall }));
  assert.equal(f.setupEligible, false);
  assert.ok(f.reasons.includes("Context uptrend not established"));
});

test("Scout's warm-up is tunable via minSignalBars", () => {
  const five = Array.from({ length: 130 }, (_, i) => bar(i));
  // 130 bars clears the 120 default but not an explicit 150.
  assert.doesNotThrow(() =>
    evaluate(
      "breakout",
      { five, hour: risingHour() },
      {},
      { category: "unclassified" },
    ),
  );
  assert.throws(
    () =>
      evaluate(
        "breakout",
        { five, hour: risingHour() },
        { minSignalBars: 150 },
        { category: "unclassified" },
      ),
    /warming/,
  );
  // The shared Keeper core needs the 1h context too.
  assert.throws(
    () => evaluate("breakout", { five }, {}, { category: "unclassified" }),
    /warming/,
  );
});

test("entryRejection names the exact failing condition", () => {
  const base = {
    setupEligible: true,
    ask: 100,
    maxEntry: 101,
    stopPrice: 95,
    bid: 100.5,
    channelHigh: 99,
  };
  assert.equal(entryRejection("breakout", base), null);
  assert.equal(entryEligible("breakout", base), true);
  assert.match(
    entryRejection("breakout", { ...base, setupEligible: false }),
    /Setup/,
  );
  assert.match(entryRejection("breakout", { ...base, ask: 102 }), /extended/);
  assert.match(entryRejection("breakout", { ...base, stopPrice: 101 }), /stop/);
  assert.match(entryRejection("breakout", { ...base, bid: 98 }), /channel/);
});

test("a bot runs the strategy template it is assigned", () => {
  // The default for trend is trend_pullback, but assigning range_breakout makes
  // it behave exactly like Scout on the same frames.
  const asBreakout = evaluate(
    "trend",
    scoutFrame(),
    { strategy: "range_breakout" },
    meme,
  );
  assert.equal(asBreakout.setupEligible, true);
  // An unknown template is refused, not silently defaulted.
  assert.throws(
    () => evaluate("trend", scoutFrame(), { strategy: "nope" }, meme),
    /Unknown strategy/,
  );
});

test("defaults carry a strategy template for every bot", () => {
  assert.equal(defaults.breakout.strategy, "orakelia");
  assert.equal(defaults.trend.strategy, "market_mover");
  assert.equal(defaults.momentum.strategy, "hexchaser");
});

test("the rotation ranking keeps only the top-3 leaders", () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({
    product: "P" + i,
    rankTime: 1,
    setupEligible: true,
    reasons: [],
    momentum24hPct: 10 - i,
    momentum7dPct: 10 - i,
  }));
  rankMomentum(
    rows,
    { minBreadth: 2 },
    { count: 3, keys: ["momentum24hPct", "momentum7dPct"] },
  );
  const leaders = rows
    .filter((x) => x.setupEligible)
    .map((x) => x.product)
    .sort();
  assert.deepEqual(leaders, ["P0", "P1", "P2"]);
});

test("the fast rotation computes the 4h-24h momentum", () => {
  const frames = { five: scoutFrame().five, hour: risingHour(), four: [] };
  const f = evaluate(
    "momentum",
    frames,
    { strategy: "momentum_rotation_fast" },
    meme,
  );
  assert.ok(Number.isFinite(f.return4hPct), "4h momentum set");
  assert.ok(Number.isFinite(f.momentum24hPct), "24h momentum set");
});

test("rotation entries are exempt from the maxEntry cap", () => {
  const base = {
    setupEligible: true,
    ask: 200,
    maxEntry: 101,
    stopPrice: 95,
    bid: 200,
    rotation: true,
  };
  assert.equal(entryRejection("breakout", base), null);
  assert.match(
    entryRejection("breakout", { ...base, rotation: false }),
    /extended/,
  );
});

test("the channel rule only applies when a channel is present", () => {
  const base = {
    setupEligible: true,
    ask: 100,
    maxEntry: 101,
    stopPrice: 95,
    bid: 90,
  };
  assert.equal(
    entryRejection("breakout", base),
    null,
    "no channelHigh -> no channel check",
  );
  assert.match(
    entryRejection("breakout", { ...base, channelHigh: 99 }),
    /channel/,
  );
});

test("hexchaser buys the strongest 7-day momentum", () => {
  const f = evaluate(
    "momentum",
    { five: scoutFrame().five, hour: risingHour(), four: [] },
    { strategy: "hexchaser" },
    meme,
  );
  assert.equal(f.setupEligible, true);
  assert.ok(f.momentum7dPct > 0);
  assert.equal(f.rotation, true);
});

test("orakelia requires volume to be rising", () => {
  const flat = evaluate(
    "breakout",
    { five: scoutFrame().five, hour: risingHour(), four: [] },
    { strategy: "orakelia" },
    meme,
  );
  assert.equal(flat.setupEligible, false);
  assert.ok(flat.reasons.includes("Volume not rising"));
  const hour = risingHour();
  hour[hour.length - 1].volume = 5;
  const f = evaluate(
    "breakout",
    { five: scoutFrame().five, hour, four: [] },
    { strategy: "orakelia" },
    meme,
  );
  assert.equal(f.setupEligible, true);
});

test("market_mover accumulates while above the hourly EMA50", () => {
  const f = evaluate(
    "trend",
    { five: scoutFrame().five, hour: risingHour(), four: [] },
    { strategy: "market_mover" },
    meme,
  );
  assert.equal(f.setupEligible, true);
});

test("setTemplates makes a created template live and prunes the listing", () => {
  const original = { ...getTemplates() };
  try {
    setTemplates({
      hex5: {
        label: "H",
        rule: "hexchaser",
        universe: "top20",
        timeframe: "5m",
      },
    });
    assert.equal(resolveTemplate("hex5").rule, "hexchaser");
    assert.deepEqual(Object.keys(getTemplates()), ["hex5"]);
    // A deleted built-in still resolves, so a bot running it keeps trading.
    assert.ok(resolveTemplate("orakelia"));
  } finally {
    setTemplates(original);
  }
});
