import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/store.mjs";
import { config, buy, arm, exchangeOrder } from "./helpers.mjs";
import { usageCounts } from "../src/providers.mjs";

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "beebots-mp-"));
  const file = join(dir, "beebots.sqlite");
  return {
    dir,
    file,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// The exact open positions on the live ledger when 2.3.0 was built. These are
// the shapes the migration must preserve byte-for-byte.
const LIVE = {
  trend: {
    product: "BONK-USDC",
    quantity: "5144643",
    cost: "19.107620818083",
    opened: 1790708423679,
    peak: "0",
    stopPct: 4,
    trailPct: 3,
    trailActivationPct: 6,
    maxHoldHours: 0,
    policy: {
      quote: 20.097885376952625,
      quantity: 5417219.778154346,
      stopPrice: 3.5341071428571428e-6,
      initialRisk: 1.758928571428573e-7,
      breakoutLevel: null,
      atr: 1.0357142857142863e-7,
      version: "2.0.0",
      signalTime: 1790708400000,
      bot: "trend",
      trailAtr: 3,
      trailR: 2,
      lastBar: 1790769600000,
      peakClose: 3.98e-6,
    },
  },
  momentum: {
    product: "PUMP-USDC",
    quantity: "2794",
    cost: "16.2174315732",
    opened: 1790758822220,
    peak: "0",
    stopPct: 3,
    trailPct: 2,
    trailActivationPct: 4,
    maxHoldHours: 48,
    policy: {
      quote: 16.21831447596401,
      quantity: 2796.743313668565,
      stopPrice: 0.005456428571428571,
      initialRisk: 0.00034257142857142993,
      breakoutLevel: null,
      atr: 0.00016278571428571408,
      version: "2.0.0",
      signalTime: 1790758800000,
      bot: "momentum",
      trailAtr: 2.5,
      trailR: 2,
      lastBar: 1790771400000,
      peakClose: 0.0058043778,
      lastRankTime: 1790769600000,
      weakRanks: 0,
    },
  },
};

// Write a legacy row (single `position`) directly, then reopen so the
// constructor migration runs.
function seedLegacy(file, c, positions) {
  const s = new Store(file, c);
  const raw = s.read();
  for (const id of Object.keys(raw.bots)) {
    raw.bots[id].position = positions[id] ?? null;
    delete raw.bots[id].positions;
  }
  s.db.prepare("UPDATE state SET body=? WHERE id=1").run(JSON.stringify(raw));
  s.close();
}

test("a legacy single position migrates to positions[] preserving every field", () => {
  const { file, cleanup } = tempStore();
  try {
    const c = config();
    seedLegacy(file, c, LIVE);
    const s = new Store(file, c); // constructor migrates
    const b = s.read().bots;
    assert.deepEqual(b.trend.positions, [LIVE.trend]);
    assert.deepEqual(b.momentum.positions, [LIVE.momentum]);
    assert.equal(b.breakout.positions.length, 0);
    // The scalar field is gone, not left alongside the array.
    assert.equal(Object.hasOwn(b.trend, "position"), false);
    // Policy survives intact so protective exits keep working.
    assert.equal(
      b.trend.positions[0].policy.stopPrice,
      LIVE.trend.policy.stopPrice,
    );
    assert.equal(b.momentum.positions[0].policy.weakRanks, 0);
    s.close();
  } finally {
    cleanup();
  }
});

test("migration is idempotent and records no event", () => {
  const { file, cleanup } = tempStore();
  try {
    const c = config();
    seedLegacy(file, c, LIVE);
    const s1 = new Store(file, c);
    const after = JSON.stringify(s1.read());
    s1.close();
    // Reopening a migrated ledger must not touch it again.
    const s2 = new Store(file, c);
    assert.equal(JSON.stringify(s2.read()), after);
    const events = s2.db.prepare("SELECT COUNT(*) c FROM events").get().c;
    assert.equal(events, 0, "migration is not an audited event");
    s2.close();
  } finally {
    cleanup();
  }
});

test("a legacy null position becomes an empty array", () => {
  const { file, cleanup } = tempStore();
  try {
    const c = config();
    seedLegacy(file, c, { breakout: null, trend: null, momentum: null });
    const s = new Store(file, c);
    for (const b of Object.values(s.read().bots))
      assert.deepEqual(b.positions, []);
    s.close();
  } finally {
    cleanup();
  }
});

test("a bot may not exceed maxPositions, and not twice in the same pair", () => {
  const c = config();
  for (const b of Object.values(c.bots)) b.maxPositions = 3;
  const s = new Store(":memory:", c);
  arm(s);
  // Only one order is in flight per bot, so each buy is settled before the next.
  const open = (product) => {
    const o = buy(s, "breakout", "10", product);
    s.acknowledge(o.id, "exchange-" + o.id);
    s.applyOrder(
      o.id,
      exchangeOrder(o, { filled_value: "10", total_fees: "0.1" }),
    );
  };
  open("BTC-USDC");
  open("ETH-USDC");
  // A duplicate pair is refused while there is still headroom.
  assert.throws(
    () => buy(s, "breakout", "10", "BTC-USDC"),
    /already holds this pair/,
  );
  // Another bot may hold the same pair; ownership is per bot.
  assert.doesNotThrow(() => buy(s, "trend", "10", "BTC-USDC"));
  open("SOL-USDC");
  assert.equal(
    s.read().bots.breakout.positions.length,
    3,
    "three settled positions",
  );
  // Fourth pair refused by the cap.
  assert.throws(
    () => buy(s, "breakout", "10", "ADA-USDC"),
    /holds 3 positions/,
  );
  s.close();
});

test("settling a buy opens a position; selling closes only the matching one", () => {
  const c = config();
  for (const b of Object.values(c.bots)) b.maxPositions = 3;
  const s = new Store(":memory:", c);
  arm(s);
  const open = (product) => {
    const o = buy(s, "breakout", "10", product);
    s.acknowledge(o.id, "exchange-" + o.id);
    s.applyOrder(
      o.id,
      exchangeOrder(o, { filled_value: "10", total_fees: "0.1" }),
    );
    return o;
  };
  open("BTC-USDC");
  open("ETH-USDC");
  assert.deepEqual(
    s.read().bots.breakout.positions.map((p) => p.product),
    ["BTC-USDC", "ETH-USDC"],
  );
  // Sell the first; the second must be untouched.
  const sell = s.reserve({
    bot: "breakout",
    product: "BTC-USDC",
    side: "SELL",
    size: s.read().bots.breakout.positions[0].quantity,
    reason: "exit",
  });
  s.acknowledge(sell.id, "exchange-" + sell.id);
  s.applyOrder(
    sell.id,
    exchangeOrder(sell, {
      side: "SELL",
      filled_size: "0.001",
      filled_value: "10",
    }),
  );
  assert.deepEqual(
    s.read().bots.breakout.positions.map((p) => p.product),
    ["ETH-USDC"],
  );
  assert.equal(s.read().bots.breakout.trades, 3);
  s.close();
});

test("equity and unrealised sum across positions, and go unmarked if any is unpriced", () => {
  const c = config();
  for (const b of Object.values(c.bots)) b.maxPositions = 3;
  const s = new Store(":memory:", c);
  s.change((st) => {
    st.bots.trend.cash = "50";
    st.bots.trend.positions = [
      { product: "A-USDC", quantity: "2", cost: "20", opened: 1 },
      { product: "B-USDC", quantity: "3", cost: "30", opened: 2 },
    ];
  });
  const priced = s
    .value({ "A-USDC": 15, "B-USDC": 12 })
    .find((b) => b.id === "trend");
  assert.equal(priced.equity, 50 + 2 * 15 + 3 * 12);
  assert.equal(priced.unrealised, 30 - 20 + (36 - 30));
  assert.equal(priced.positions.length, 2);
  assert.equal(priced.positions[0].unrealised, 10);
  assert.equal(priced.positions[1].unrealised, 6);
  // One missing price makes the whole mark unknown rather than understated.
  const partial = s.value({ "A-USDC": 15 }).find((b) => b.id === "trend");
  assert.equal(partial.equity, null);
  assert.equal(partial.positions[1].unrealised, null);
  s.close();
});

test("per-model token counts are recorded (was always zero)", () => {
  const s = new Store(":memory:", config());
  const day = new Date().toISOString().slice(0, 10);
  s.recordModelCall({
    day,
    provider: "deepseek",
    model: "deepseek-flash",
    usage: usageCounts({
      prompt_tokens: 1000,
      completion_tokens: 200,
      total_tokens: 1200,
      prompt_tokens_details: { cached_tokens: 50 },
    }),
    costNanos: 0n,
  });
  const p = s.read().modelUsage.perModel["deepseek:deepseek-flash"];
  assert.equal(p.tokens, 1200, "per-model tokens must not stay at zero");
  assert.equal(p.calls, 1);
  s.close();
});

test("event pruning removes only stale market telemetry", () => {
  const s = new Store(":memory:", config());
  const now = Date.now();
  const old = now - 48 * 3600000;
  // Bulk market rows, plus audit rows that must never be pruned.
  for (let i = 0; i < 20; i++) {
    s.db
      .prepare("INSERT INTO events(ts,kind,body) VALUES(?,?,?)")
      .run(old, "market", JSON.stringify({ products: "x".repeat(50000) }));
  }
  for (const kind of ["decision", "order", "fill", "veto", "control", "error"])
    s.db
      .prepare("INSERT INTO events(ts,kind,body) VALUES(?,?,?)")
      .run(old, kind, JSON.stringify({ note: kind }));
  s.db
    .prepare("INSERT INTO events(ts,kind,body) VALUES(?,?,?)")
    .run(now, "market", JSON.stringify({ fresh: true }));

  const removed = s.pruneEvents({ keepMs: 24 * 3600000, now });
  assert.equal(removed, 20, "only the stale market rows");
  const kinds = s.db
    .prepare("SELECT kind, COUNT(*) c FROM events GROUP BY kind")
    .all();
  const byKind = Object.fromEntries(kinds.map((r) => [r.kind, r.c]));
  assert.equal(byKind.market, 1, "the fresh market row survives");
  for (const kind of ["decision", "order", "fill", "veto", "control", "error"])
    assert.equal(byKind[kind], 1, `${kind} is an audit row and must survive`);
  // Replay still yields the audit trail after pruning.
  const replayed = s.events(0, 500).map((e) => e.kind);
  assert.ok(replayed.includes("decision"));
  s.close();
});

test("pruning is idempotent and safe on an empty ledger", () => {
  const s = new Store(":memory:", config());
  assert.equal(s.pruneEvents(), 0);
  assert.equal(s.pruneEvents(), 0);
  s.close();
});

// Exercises the engine's candidate construction: held pairs must remain
// reviewable, and fresh entries must stop being offered at the position cap.
import { Engine } from "../src/engine.mjs";
import { migrateConfig } from "../src/migrate-v2.mjs";

function engineFixture({ heldProducts, maxPositions = 3, freshCount = 4 }) {
  const c = migrateConfig(config());
  c.mode = "live";
  c.decisionIntervalMs = 0;
  for (const b of Object.values(c.bots)) b.maxPositions = maxPositions;
  const s = new Store(":memory:", c);
  arm(s);
  const held = heldProducts.map((p, i) => ({
    product: p,
    quantity: "0.1",
    cost: "10",
    opened: 1000 + i,
    peak: "0",
    stopPct: 3,
    trailPct: 2,
    trailActivationPct: 4,
    maxHoldHours: 24,
    policy: {
      stopPrice: 1,
      initialRisk: 1,
      trailAtr: 2,
      trailR: 2,
      lastBar: 0,
    },
  }));
  s.change((st) => {
    st.bots.breakout.positions = held;
    st.bots.breakout.cash = "70";
  });
  const products = [
    ...heldProducts,
    ...Array.from({ length: freshCount }, (_, i) => `NEW${i}-USDC`),
  ];
  const eligible = (product) => ({
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
    snapshot: (id) => (id ? products.map(eligible) : products.map(eligible)),
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
      apiKeyEnv: "BEEBOTS_MODEL_KEY",
      local: false,
    }),
    decide: async ({ bot, candidates }) => {
      seen.push({ bot: bot.id, products: candidates.map((x) => x.product) });
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
    analyze: async () => ({ answers: { fit: { score: 1 } }, queue_depth: 0 }),
  };
  const engine = new Engine({
    config: c,
    store: s,
    exchange: {},
    market,
    laya,
    model,
  });
  return {
    s,
    engine,
    seen,
    products,
    // Candidates offered for one specific bot.
    candidatesFor: (id) =>
      seen.filter((x) => x.bot === id).map((x) => x.products),
  };
}

test("held pairs stay in the candidate list for review", async () => {
  const { s, engine, candidatesFor } = engineFixture({
    heldProducts: ["AAA-USDC"],
  });
  await engine.cycle();
  const offered = candidatesFor("breakout");
  assert.equal(offered.length, 1, "the model was consulted once for breakout");
  assert.ok(
    offered[0].includes("AAA-USDC"),
    "a held pair is offered back to the model so it can be exited",
  );
  s.close();
});

test("fresh entries are offered while below the cap and withheld at it", async () => {
  const below = engineFixture({ heldProducts: ["AAA-USDC"], maxPositions: 3 });
  await below.engine.cycle();
  assert.ok(
    below.candidatesFor("breakout")[0].some((p) => p !== "AAA-USDC"),
    "with headroom, fresh candidates are offered",
  );
  below.s.close();

  const full = engineFixture({
    heldProducts: ["AAA-USDC", "BBB-USDC", "CCC-USDC"],
    maxPositions: 3,
  });
  await full.engine.cycle();
  const offered = new Set(full.candidatesFor("breakout")[0]);
  assert.equal(offered.size, 3, "at the cap only held pairs are reviewed");
  for (const p of ["AAA-USDC", "BBB-USDC", "CCC-USDC"])
    assert.ok(offered.has(p), `${p} is reviewed`);
  assert.ok(
    ![...offered].some((p) => p.startsWith("NEW")),
    "no fresh entry is offered at the cap",
  );
  full.s.close();
});

test("the engine never opens more positions than maxPositions", async () => {
  const { s, engine, candidatesFor } = engineFixture({
    heldProducts: ["AAA-USDC", "BBB-USDC", "CCC-USDC"],
    maxPositions: 3,
  });
  await engine.cycle();
  assert.equal(s.read().bots.breakout.positions.length, 3);
  assert.equal(candidatesFor("breakout")[0].length, 3);
  s.close();
});
