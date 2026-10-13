import test from "node:test";
import assert from "node:assert/strict";
import { buildReport, roundTrips, exitGroup } from "../src/report.mjs";

const buy = (id, over = {}) => ({
  id,
  bot: "trend",
  product: "X-USDC",
  side: "BUY",
  status: "SETTLED",
  filled: "1",
  value: "100",
  fees: "0.1",
  created: 1000,
  rulesHash: "aaa",
  exitRules: { rule: "orakelia" },
  ...over,
});
const sell = (id, over = {}) => ({
  id,
  bot: "trend",
  product: "X-USDC",
  side: "SELL",
  status: "SETTLED",
  filled: "1",
  value: "100",
  fees: "0.1",
  created: 2000,
  ...over,
});

test("exitGroup collapses free-text reasons", () => {
  assert.equal(exitGroup("Protective stop"), "stop");
  assert.equal(exitGroup("Trailing exit"), "trail");
  assert.equal(exitGroup("Momentum faded"), "momentum-fade");
  assert.equal(
    exitGroup("Laya chose SELL AAVE-USDC (conviction 1.6)"),
    "decider-sell",
  );
});

test("roundTrips separates gross, fees and net and keeps excursions", () => {
  const trips = roundTrips({
    b1: buy("b1"),
    s1: sell("s1", {
      value: "110",
      fees: "0.11",
      exitPeak: 112,
      exitTrough: 95,
      reason: "Trailing exit",
    }),
  });
  assert.equal(trips.length, 1);
  const t = trips[0];
  assert.ok(Math.abs(t.gross - 10) < 1e-9, `gross ${t.gross}`);
  assert.ok(Math.abs(t.fees - 0.21) < 1e-9, `fees ${t.fees}`);
  assert.ok(Math.abs(t.net - 9.79) < 1e-9, `net ${t.net}`);
  assert.ok(Math.abs(t.mfePct - 12) < 1e-9, `mfe ${t.mfePct}`);
  assert.ok(Math.abs(t.maePct - -5) < 1e-9, `mae ${t.maePct}`);
  assert.equal(t.reason, "trail");
  assert.equal(t.rulesHash, "aaa");
});

test("buildReport aggregates wins, losers, profit factor and exit reasons", () => {
  const orders = {
    b1: buy("b1"),
    s1: sell("s1", {
      value: "110",
      fees: "0.11",
      exitPeak: 112,
      exitTrough: 95,
      reason: "Trailing exit",
    }),
    b2: buy("b2", { product: "Y-USDC" }),
    s2: sell("s2", {
      product: "Y-USDC",
      value: "90",
      reason: "Protective stop",
    }),
  };
  const report = buildReport({
    orders,
    equity: [],
    capitalById: { trend: 100 },
  });
  const b = report.perBot.trend;
  assert.equal(b.trades, 2);
  assert.equal(b.wins, 1);
  assert.equal(b.losses, 1);
  assert.equal(b.winRate, 50);
  assert.ok(Math.abs(b.gross - 0) < 1e-9, `gross ${b.gross}`);
  assert.ok(Math.abs(b.net - -0.41) < 1e-9, `net ${b.net}`);
  assert.ok(Math.abs(b.profitFactor - 1) < 1e-9, `pf ${b.profitFactor}`);
  const reasons = Object.fromEntries(b.byReason.map((r) => [r.key, r]));
  assert.ok(reasons.trail && Math.abs(reasons.trail.net - 9.79) < 1e-9);
  assert.ok(reasons.stop && Math.abs(reasons.stop.net - -10.2) < 1e-9);
});
