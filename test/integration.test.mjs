import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.mjs";
import { Engine } from "../src/engine.mjs";
import { config, arm } from "./helpers.mjs";
test("three bots: analysis → decisions → real-adapter requests → reconciled fills", async () => {
  const c = config();
  c.mode = "live";
  const store = new Store(":memory:", c);
  arm(store);
  const orders = new Map();
  let n = 0;
  const p = {
    product_id: "BTC-USDC",
    product_type: "SPOT",
    quote_currency_id: "USDC",
    status: "online",
    base_increment: "0.00000001",
    quote_increment: "0.01",
    base_min_size: "0.00001",
    quote_min_size: "1",
  };
  const exchange = {
    product: async () => p,
    fees: async () => ({ fee_tier: { taker_fee_rate: "0.006" } }),
    accounts: async () => ({
      accounts: [
        {
          currency: "USDC",
          available_balance: { currency: "USDC", value: "1000" },
        },
        { currency: "BTC", available_balance: { currency: "BTC", value: "1" } },
      ],
    }),
    create: async (r) => {
      const id = "exchange-" + ++n;
      orders.set(id, {
        order_id: id,
        client_order_id: r.client_order_id,
        product_id: r.product_id,
        side: r.side,
        filled_size: "0.001",
        filled_value: "60",
        total_fees: "0.36",
        status: "FILLED",
        settled: true,
      });
      return { success: true, success_response: { order_id: id } };
    },
    order: async (id) => ({ order: orders.get(id) }),
  };
  const f = {
    product: "BTC-USDC",
    at: Date.now(),
    periodTurnover: 200000,
    turnover24h: 3000000,
    spreadBps: 1,
    bid: 60000,
    ask: 60001,
    close: 60000,
    previousClose: 59000,
    channelHigh: 59000,
    hourClose: 60000,
    hourPrevious: 59000,
    ema20: 58000,
    ema50: 55000,
    momentum7dPct: 5,
    momentum24hPct: 2,
  };
  const market = {
    refresh: async () => {},
    snapshot: () => [f],
    prices: () => ({ "BTC-USDC": 60000 }),
    quote: async () => ({
      bid: 60000,
      ask: 60001,
      spreadBps: 1,
      at: Date.now(),
    }),
  };
  const engine = new Engine({
    config: c,
    store,
    exchange,
    market,
    laya: {
      analyze: async () => ({
        answers: {
          fit: { score: 1.5 },
          regime: { choice: "uptrend" },
          quality: { choice: "complete" },
        },
        queue_depth: 0,
        calibrated: false,
      }),
    },
    model: {
      decide: async () => ({
        action: "BUY",
        product: "BTC-USDC",
        reason: "Fixture decision",
      }),
    },
  });
  await engine.cycle();
  assert.equal(orders.size, 3);
  await engine.protect();
  assert.equal(store.pending().length, 0);
  for (const b of Object.values(store.read().bots)) {
    assert.equal(b.positions[0].quantity, "0.001");
    assert.equal(b.cash, "39.64");
    assert.equal(b.fees, "0.36");
  }
  const kinds = store.recent().map((e) => e.kind);
  assert.ok(kinds.indexOf("analysis") < kinds.indexOf("decision"));
  assert.ok(kinds.indexOf("decision") < kinds.indexOf("order"));
  assert.ok(kinds.indexOf("order") < kinds.indexOf("fill"));
  store.close();
});
test("failure reconciling one bot does not stop another bot protective exit", async () => {
  const c = config();
  c.mode = "live";
  const store = new Store(":memory:", c);
  arm(store);
  store.change((s) => {
    s.orders.bad = {
      id: "bad",
      bot: "breakout",
      status: "UNKNOWN",
      created: Date.now(),
    };
    s.bots.trend.positions = [
      {
        product: "BTC-USDC",
        quantity: "0.001",
        cost: "100",
        peak: "100000",
        stopPct: 3,
        trailPct: 2,
        trailActivationPct: 4,
        maxHoldHours: 0,
        opened: Date.now(),
      },
    ];
  });
  const engine = new Engine({
    config: c,
    store,
    exchange: {
      find: async () => {
        throw Error("Unavailable");
      },
    },
    market: { quote: async () => ({ bid: 50000 }) },
    laya: {},
    model: {},
  });
  const exits = [];
  engine.execute = async (...args) => exits.push(args);
  await engine.protect();
  assert.equal(exits.length, 1);
  assert.equal(exits[0][0], "trend");
  store.close();
});
