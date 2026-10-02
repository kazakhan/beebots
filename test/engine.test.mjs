import test from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../src/engine.mjs";
import { Store } from "../src/store.mjs";
import { config, arm, buy, exchangeOrder } from "./helpers.mjs";
import { eligibility, closedCandles } from "../src/market.mjs";
function fixture() {
  const c = config();
  c.mode = "live";
  const store = new Store(":memory:", c);
  arm(store);
  let submissions = 0;
  const product = {
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
    product: async () => product,
    accounts: async () => ({
      accounts: [
        {
          currency: "USDC",
          available_balance: { currency: "USDC", value: "300" },
        },
        { currency: "BTC", available_balance: { currency: "BTC", value: "1" } },
      ],
    }),
    fees: async () => ({ fee_tier: { taker_fee_rate: "0.006" } }),
    create: async () => {
      submissions++;
      throw Error("lost response");
    },
    find: async () => ({ order: null }),
  };
  const market = {
    quote: async () => ({
      bid: 60000,
      ask: 60001,
      spreadBps: 1,
      at: Date.now(),
    }),
    prices: () => ({ "BTC-USDC": 60000 }),
    snapshot: () => ({}),
  };
  const engine = new Engine({
    config: c,
    store,
    exchange,
    market,
    laya: {},
    model: {},
  });
  return {
    engine,
    store,
    exchange,
    get submissions() {
      return submissions;
    },
  };
}
const evidence = () => ({
  at: Date.now(),
  periodTurnover: 200000,
  turnover24h: 3000000,
  spreadBps: 1,
  close: 60000,
  channelHigh: 59000,
  bid: 60000,
});
test("lost POST response is not resubmitted on reconciliation", async () => {
  const f = fixture();
  try {
    await f.engine.execute("breakout", "BUY", "BTC-USDC", "setup", evidence());
    assert.equal(f.submissions, 1);
    assert.equal(f.store.pending()[0].status, "UNKNOWN");
    await f.engine.reconcileOrders();
    await f.engine.execute("breakout", "BUY", "BTC-USDC", "setup", evidence());
    assert.equal(f.submissions, 1);
  } finally {
    f.store.close();
  }
});
test("observe mode cannot call create", async () => {
  const f = fixture();
  f.engine.config.mode = "observe";
  await f.engine.execute("breakout", "BUY", "BTC-USDC", "setup", evidence());
  assert.equal(f.submissions, 0);
  f.store.close();
});
test("stale analysis cannot become an order", async () => {
  const f = fixture();
  await assert.rejects(
    f.engine.execute("breakout", "BUY", "BTC-USDC", "setup", {
      ...evidence(),
      at: 0,
    }),
    /Analysis expired before execution/,
  );
  assert.equal(f.submissions, 0);
  f.store.close();
});
test("independent protective exit works while entries paused and Laya unavailable", async () => {
  const f = fixture();
  const o = buy(f.store);
  f.store.acknowledge(o.id, "exchange-" + o.id);
  f.store.applyOrder(o.id, exchangeOrder(o));
  f.store.change((s) => {
    s.paused = true;
  });
  f.engine.market.quote = async () => ({
    bid: 40000,
    ask: 40001,
    spreadBps: 1,
  });
  await f.engine.protect();
  assert.equal(f.submissions, 1);
  assert.equal(f.store.pending()[0].side, "SELL");
  f.store.close();
});
test("selected-period turnover is distinct from 24h admission", () => {
  const rules = config().bots.breakout;
  assert.equal(eligibility("breakout", evidence(), rules), true);
  assert.equal(
    eligibility(
      "breakout",
      { ...evidence(), periodTurnover: 99999, turnover24h: 100000000 },
      rules,
    ),
    false,
  );
  assert.equal(
    eligibility("breakout", { ...evidence(), turnover24h: 1999999 }, rules),
    false,
  );
});
test("incomplete candles excluded and gaps rejected", () => {
  const now = Date.now(),
    end = Math.floor(now / 900000) * 900000;
  const rows = Array.from({ length: 101 }, (_, i) => ({
    start: String((end - (100 - i) * 900000) / 1000),
    open: "10",
    high: "11",
    low: "9",
    close: "10",
    volume: "100",
  }));
  assert.equal(closedCandles(rows, 900, now).length, 100);
  rows.splice(50, 1);
  assert.throws(() => closedCandles(rows, 900, now), /Missing/);
});

test("the snapshot exposes the review running state and error", () => {
  const f = fixture();
  try {
    const snap = f.engine.snapshot();
    assert.equal(snap.reviewing, false);
    assert.equal(snap.reviewError, null);
    f.engine.reviewing = true;
    assert.equal(f.engine.snapshot().reviewing, true);
  } finally {
    f.store.close();
  }
});

test("review skips an hour already reviewed but retries a failed one", async () => {
  const f = fixture();
  let runs = 0;
  f.engine.reviewer = { run: async () => void runs++ };
  await f.engine.review();
  assert.equal(runs, 1, "first pass reviews the current hour");
  const hour = Math.floor(Date.now() / 3600000) * 3600000;
  f.store.change(
    (st) => {
      st.lastReview = { until: hour, summary: "ok" };
      st.lastReviewError = null;
    },
    "test",
    {},
  );
  await f.engine.review();
  assert.equal(runs, 1, "an already-reviewed hour is skipped");
  f.store.change(
    (st) => {
      st.lastReviewError = { at: hour, message: "nope" };
    },
    "test",
    {},
  );
  await f.engine.review();
  assert.equal(runs, 2, "a failed hour is retried");
  f.store.close();
});

test("scheduleReview runs the just-closed hour on startup", async () => {
  const f = fixture();
  let runs = 0;
  f.engine.reviewer = { run: async () => void runs++ };
  f.engine.scheduleReview();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(runs, 1, "startup triggers one review without waiting for :00");
  f.engine.stop();
  f.store.close();
});
