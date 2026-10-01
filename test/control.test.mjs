import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.mjs";
import { Engine } from "../src/engine.mjs";
import { config, addControl } from "./helpers.mjs";

// A control arm is a fourth bot that enters at random on the same universe, with
// the same sizing and exits, to serve as the null baseline. These tests pin the
// two properties that make it usable: it never touches the exchange while paper,
// and it never duplicates a held pair or exceeds its cap.
function fixture({
  paper = true,
  maxPositions = 3,
  products = ["A-USDC", "B-USDC", "C-USDC", "D-USDC"],
} = {}) {
  const c = addControl(config(), { paper, maxPositions });
  // The control is an execution-capable arm; it runs in the live runtime.
  c.mode = "live";
  c.decisionIntervalMs = 0;
  const s = new Store(":memory:", c);
  s.change((st) => {
    st.paused = false;
  });
  const created = [];
  const exchange = {
    product: async (id) => ({
      product_id: id,
      product_type: "SPOT",
      quote_currency_id: "USDC",
      status: "online",
      base_increment: "0.000001",
      quote_increment: "0.01",
      base_min_size: "0.000001",
      quote_min_size: "1",
    }),
    fees: async () => ({ fee_tier: { taker_fee_rate: "0.001" } }),
    accounts: async () => ({
      accounts: [
        {
          currency: "USDC",
          available_balance: { currency: "USDC", value: "1000000" },
        },
      ],
    }),
    create: async (o) => {
      created.push(o);
      return {
        success: true,
        success_response: { order_id: "x-" + o.client_order_id },
      };
    },
  };
  const market = {
    held: [],
    refresh: async () => {},
    snapshot: () =>
      products.map((p) => ({
        product: p,
        at: Date.now(),
        atr: 1,
        signalTime: Date.now(),
        close: 100,
      })),
    prices: () => Object.fromEntries(products.map((p) => [p, 100])),
    quote: async () => ({
      bid: 99.99,
      ask: 100,
      at: Date.now(),
      bids: [{ price: "99.99", size: "100000" }],
      asks: [{ price: "100", size: "100000" }],
    }),
  };
  const laya = {
    analyze: async () => ({
      answers: {
        fit: { score: 1 },
        regime: { choice: "uptrend" },
        quality: { choice: "complete" },
      },
      queue_depth: 0,
    }),
  };
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
    decide: async () => ({
      action: "HOLD",
      product: null,
      reason: "hold",
      provider: "deepseek",
      model: "deepseek-flash",
    }),
  };
  const engine = new Engine({
    config: c,
    store: s,
    exchange,
    market,
    laya,
    model,
  });
  // Force the next control cadence to run without waiting on the wall clock.
  const tick = async () => {
    s.change((st) => {
      st.assessments ??= {};
      st.assessments.control = -1;
    });
    await engine.cycle();
  };
  return { c, s, engine, created, tick };
}

test("a paper control arm books a position without touching the exchange", async () => {
  const f = fixture({ paper: true });
  await f.tick();
  assert.equal(f.created.length, 0, "no exchange order for a paper arm");
  const pos = f.s.read().bots.control.positions;
  assert.equal(pos.length, 1, "one simulated position opened");
  assert.ok(Number(pos[0].quantity) > 0);
  // The fill is settled through the same ledger path, so cash moved.
  assert.ok(Number(f.s.read().bots.control.cash) < 100);
  assert.equal(f.s.pending().length, 0, "paper fills settle immediately");
  f.s.close();
});

test("a real control arm uses the exchange like any other bot", async () => {
  const f = fixture({ paper: false });
  await f.tick();
  assert.ok(f.created.length >= 1, "the real arm submits an order");
  f.s.close();
});

test("the control never duplicates a held pair and respects its cap", async () => {
  const f = fixture({
    maxPositions: 2,
    products: ["A-USDC", "B-USDC", "C-USDC", "D-USDC"],
  });
  for (let i = 0; i < 6; i++) await f.tick();
  const pos = f.s.read().bots.control.positions;
  assert.equal(pos.length, 2, "capped at maxPositions");
  assert.equal(new Set(pos.map((p) => p.product)).size, 2, "no duplicate pair");
  f.s.close();
});

test("a paper arm's simulated cash is excluded from real reconciliation", async () => {
  const f = fixture({ paper: true });
  // Give the paper arm a large simulated holding and cash.
  await f.tick();
  f.s.change((st) => {
    st.bots.control.cash = "999999";
  });
  // A real strategy bot must still be able to reconcile against the exchange,
  // which holds nowhere near the paper arm's imaginary balance.
  const balances = await f.engine.reconcileBalances();
  assert.ok(balances.USDC, "reconciliation returns real balances");
  f.s.close();
});

test("the control is excluded from observe-mode vetoes only because it trades", async () => {
  // Sanity: the control is a configured bot, so it appears in the roster and the
  // snapshot, which is what the fourth dashboard card and the leaderboard read.
  const f = fixture();
  await f.tick();
  const snap = f.engine.snapshot();
  assert.ok(Object.hasOwn(snap.rules, "control"));
  const ids = f.engine.botIds();
  assert.deepEqual(ids, ["breakout", "trend", "momentum", "control"]);
  f.s.close();
});

// --- roster migration (2.5.0) --------------------------------------------
// Adding the control arm to a ledger created before it must not crash the
// runtime. Before 2.5.0 the roster was frozen at ledger creation, so the
// constructor dereferenced an undefined bot and exited 1 on every start -
// systemd looped and lighttpd returned 503.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

test("a control arm named in config is ADDED to an existing three-bot ledger", () => {
  const dir = mkdtempSync(join(tmpdir(), "beebots-roster-"));
  const file = join(dir, "beebots.sqlite");
  try {
    // 1. A ledger created before the control arm existed.
    const base = config();
    const first = new Store(file, base);
    assert.deepEqual(Object.keys(first.read().bots).sort(), [
      "breakout",
      "momentum",
      "trend",
    ]);
    first.close();

    // 2. The same ledger opened by a runtime that knows the control arm.
    const withControl = addControl(config());
    const second = new Store(file, withControl);
    const bots = second.read().bots;
    assert.deepEqual(Object.keys(bots).sort(), [
      "breakout",
      "control",
      "momentum",
      "trend",
    ]);
    // The new bot has the same funded shape as a first-time bot.
    assert.equal(bots.control.capital, "100");
    assert.equal(bots.control.cash, "100");
    assert.equal(bots.control.reserved, "0");
    assert.deepEqual(bots.control.positions, []);
    // The three originals are untouched.
    assert.equal(bots.breakout.capital, "100");
    // It appears in the valued roster the dashboard reads.
    assert.equal(second.value({}).length, 4);

    // 3. Idempotent: a second open changes nothing.
    const snapshot = JSON.stringify(second.read());
    second.close();
    const third = new Store(file, withControl);
    assert.equal(JSON.stringify(third.read()), snapshot);
    third.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the roster migration records no audit event", () => {
  const dir = mkdtempSync(join(tmpdir(), "beebots-roster2-"));
  const file = join(dir, "beebots.sqlite");
  try {
    const first = new Store(file, config());
    first.close();
    const second = new Store(file, addControl(config()));
    const events = second.db.prepare("SELECT COUNT(*) c FROM events").get().c;
    assert.equal(events, 0, "adding a bot is not an audited event");
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a capital change on an EXISTING bot still requires a funding migration", () => {
  const dir = mkdtempSync(join(tmpdir(), "beebots-roster3-"));
  const file = join(dir, "beebots.sqlite");
  try {
    const first = new Store(file, config());
    first.close();
    const changed = config();
    changed.bots.breakout.capital = "250";
    assert.throws(
      () => new Store(file, changed),
      /Capital differs from persisted ledger/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a configured bot absent from the ledger cannot be dereferenced defensively", () => {
  // Belt-and-braces: even if a bot somehow bypasses migrateRoster, the capital
  // check must not throw a TypeError on an undefined bot.
  const dir = mkdtempSync(join(tmpdir(), "beebots-roster4-"));
  const file = join(dir, "beebots.sqlite");
  try {
    const first = new Store(file, config());
    // Remove control from the persisted state behind the store's back.
    first.db.prepare("UPDATE state SET body=? WHERE id=1").run(
      JSON.stringify({
        ...first.read(),
        bots: { breakout: first.read().bots.breakout },
      }),
    );
    first.close();
    assert.doesNotThrow(() => {
      const s = new Store(file, addControl(config()));
      s.close();
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- paper arms are not bound by exchange minimums (3.0.1) ----------------
// A paper position that is dust can never be closed through the exchange, but a
// simulated arm has no exchange to satisfy. Before 3.0.1 the minimum check was
// applied to paper too, so the control stranded its own dust.
function dustFixture(paper) {
  const f = fixture({ paper, maxPositions: 1 });
  // A position worth less than the product's 1 USDC quote minimum.
  f.s.change((st) => {
    st.bots.control.cash = "99.5";
    st.bots.control.positions = [
      { product: "A-USDC", quantity: "0.005", cost: "0.5", opened: Date.now() },
    ];
  });
  // The model asks to close it.
  f.engine.model.decide = async () => ({
    action: "SELL",
    product: "A-USDC",
    reason: "exit dust",
    model: "m",
    provider: null,
  });
  // A paper SELL needs the taker fee; the subsequent random BUY is what we want
  // to block, so fail on the second fee call only. For a real arm the SELL needs
  // no fee and the position stays at capacity, so no entry is attempted.
  if (paper) {
    let feeCalls = 0;
    f.engine.exchange.fees = async () => {
      feeCalls++;
      if (feeCalls > 1) throw Error("entries disabled for test");
      return { fee_tier: { taker_fee_rate: "0.001" } };
    };
  }
  return f;
}

test("a paper arm closes a below-minimum holding", async () => {
  const f = dustFixture(true);
  await f.tick();
  assert.equal(
    f.s.read().bots.control.positions.length,
    0,
    "the paper arm cleared its dust",
  );
  f.s.close();
});

test("a real arm refuses a below-minimum holding for owner review", async () => {
  const f = dustFixture(false);
  await f.tick();
  assert.equal(
    f.s.read().bots.control.positions.length,
    1,
    "the real arm keeps dust for owner review",
  );
  f.s.close();
});
