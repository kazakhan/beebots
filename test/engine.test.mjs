import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("effectiveRules pins maxCandidates to 100 even with a hostile override", () => {
  const c = config();
  const dir = mkdtempSync(join(tmpdir(), "beebots-maxcand-"));
  c.dataDir = dir;
  mkdirSync(join(dir, "overrides"), { recursive: true });
  writeFileSync(
    join(dir, "overrides", "params-momentum.json"),
    JSON.stringify({ maxCandidates: 6, riskPct: 1.2 }),
  );
  const store = new Store(":memory:", c);
  try {
    const engine = new Engine({
      config: c,
      store,
      exchange: {},
      market: {},
      laya: {},
      model: {},
    });
    const rules = engine.effectiveRules("momentum");
    assert.equal(rules.maxCandidates, 100, "pinned");
    assert.equal(rules.riskPct, 1.2, "other stored values still apply");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("engineState carries recent-close context and the guidance", () => {
  const f = fixture();
  try {
    const state = f.engine.engineState(
      "trend",
      [{ product: "X-USDC", setupEligible: true }],
      { positions: [] },
      {
        "X-USDC": {
          minsAgo: 60,
          pnlPct: -1.2,
          win: false,
          why: "Strategy protective stop",
        },
      },
    );
    assert.match(state.guidance, /recently closed/);
    assert.equal(state.candidates[0].lastClose.why, "Strategy protective stop");
    assert.equal(state.candidates[0].lastClose.win, false);
    assert.equal(state.candidates[0].lastClose.pnlPct, -1.2);
  } finally {
    f.store.close();
  }
});

test("recentCloses reads the ledger within the window", () => {
  const f = fixture();
  try {
    const now = Date.now();
    const orders = {
      a: {
        id: "a",
        bot: "trend",
        product: "X-USDC",
        side: "BUY",
        status: "SETTLED",
        filled: "1",
        value: "100",
        fees: "0.5",
        created: now - 7200000,
      },
      b: {
        id: "b",
        bot: "trend",
        product: "X-USDC",
        side: "SELL",
        status: "SETTLED",
        filled: "1",
        value: "102",
        fees: "0.5",
        created: now - 3600000,
        reason: "Strategy protective stop",
      },
      c: {
        id: "c",
        bot: "trend",
        product: "OLD-USDC",
        side: "BUY",
        status: "SETTLED",
        filled: "1",
        value: "100",
        fees: "0",
        created: now - 40 * 3600000,
      },
      d: {
        id: "d",
        bot: "trend",
        product: "OLD-USDC",
        side: "SELL",
        status: "SETTLED",
        filled: "1",
        value: "100",
        fees: "0",
        created: now - 39 * 3600000,
        reason: "Strategy protective stop",
      },
    };
    const rc = f.engine.recentCloses(orders, "trend", "1h", 24);
    assert.ok(rc["X-USDC"], "the recent close is included");
    assert.equal(rc["X-USDC"].why, "Strategy protective stop");
    assert.equal(rc["X-USDC"].win, true);
    assert.ok(!rc["OLD-USDC"], "a close older than the window is excluded");
  } finally {
    f.store.close();
  }
});

test("decisionSubset caps the prompt and keeps held positions", () => {
  const f = fixture();
  try {
    const analyzed = Array.from({ length: 50 }, (_, i) => ({
      product: "P" + i + "-USDC",
      setupEligible: false,
    }));
    const sub = f.engine.decisionSubset("trend", analyzed, [
      { product: "P49-USDC" },
    ]);
    assert.equal(sub.length, 32, "bounded to 32");
    assert.ok(
      sub.some((x) => x.product === "P49-USDC"),
      "the held position is kept",
    );
  } finally {
    f.store.close();
  }
});
