import test from "node:test";
import assert from "node:assert/strict";
import { simulateTimeframe, buildTimeframeLab } from "../src/timeframe-lab.mjs";

const budget = () => ({ exceeded: false, spend() {} });
const signal = () => ({ setupEligible: true });
const bar = (time, o, h, l, c) => ({
  time,
  open: o,
  high: h,
  low: l,
  close: c,
  volume: 1,
});

test("the protective stop closes the simulated position", () => {
  const five = [
    bar(0, 100, 101, 99, 100),
    bar(300000, 100, 100.5, 94, 95),
    bar(600000, 95, 96, 95, 95),
  ];
  const stats = simulateTimeframe({
    frames: { five, hour: [], four: [] },
    id: "breakout",
    rules: { stopPct: 4, trailPct: 3, trailActivationPct: 5, maxHoldHours: 0 },
    timeframe: "5m",
    since: 0,
    until: 300000,
    feePct: 0,
    evaluateFn: signal,
    budget: budget(),
  });
  assert.equal(stats.trades, 1);
  assert.equal(stats.wins, 0);
  assert.equal(stats.losses, 1);
  assert.ok(Math.abs(stats.net - -4) < 1e-9);
});

test("the trailing stop banks a winner", () => {
  const five = [
    bar(0, 100, 101, 99, 100),
    bar(300000, 100, 110, 100, 106),
    bar(600000, 106, 107, 105, 106),
  ];
  const stats = simulateTimeframe({
    frames: { five, hour: [], four: [] },
    id: "breakout",
    rules: { stopPct: 4, trailPct: 3, trailActivationPct: 5, maxHoldHours: 0 },
    timeframe: "5m",
    since: 0,
    until: 300000,
    feePct: 0,
    evaluateFn: signal,
    budget: budget(),
  });
  assert.equal(stats.trades, 1);
  assert.equal(stats.wins, 1);
  assert.ok(Math.abs(stats.net - 6) < 1e-9);
});

test("the maxHoldHours time stop closes a stalling position", () => {
  const hour = [
    bar(0, 100, 101, 99, 100),
    bar(3600000, 100, 101, 99, 100),
    bar(7200000, 100, 101, 99, 100),
  ];
  const stats = simulateTimeframe({
    frames: { five: [], hour, four: [] },
    id: "momentum",
    rules: {
      stopPct: 4,
      trailPct: 3,
      trailActivationPct: 100,
      maxHoldHours: 1,
    },
    timeframe: "1h",
    since: 0,
    until: 3600000,
    feePct: 0,
    evaluateFn: signal,
    budget: budget(),
  });
  assert.equal(stats.trades, 1, "the time stop realised the trade");
});

test("the lab compares timeframes per arm and caps products", () => {
  const five = [bar(0, 100, 101, 99, 100), bar(300000, 100, 100.5, 94, 95)];
  const lab = buildTimeframeLab({
    products: ["A", "B", "C"],
    framesFor: (p) => (p === "C" ? null : { five, hour: [], four: [] }),
    arms: [
      {
        id: "breakout",
        rules: {
          stopPct: 4,
          trailPct: 3,
          trailActivationPct: 5,
          maxHoldHours: 0,
          timeframe: "5m",
        },
      },
    ],
    since: 0,
    until: 300000,
    feePct: 0,
    productCap: 2,
    evaluateFn: signal,
  });
  const arm = lab.arms.breakout;
  assert.equal(arm.current, "5m");
  assert.deepEqual(Object.keys(arm.timeframes).sort(), ["15m", "1h", "5m"]);
  assert.equal(arm.timeframes["5m"].trades, 2, "two products, not three");
  assert.equal(arm.timeframes["5m"].net, -8);
});
