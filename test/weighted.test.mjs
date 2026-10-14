import test from "node:test";
import assert from "node:assert/strict";
import {
  extract,
  scoreCandidate,
  weightsFor,
  chooseWeightedMove,
  executable,
  exitWouldFire,
  SEED_WEIGHTS,
} from "../src/weighted.mjs";
import { backtestWeighted } from "../src/backtest.mjs";

const strong = {
  product: "AAA-USDC",
  close: 10,
  previousClose: 9,
  hourClose: 10,
  ema20: 9,
  ema50: 8,
  momentum7dPct: 15,
  momentum24hPct: 5,
  relativeVolume: 3,
  spreadBps: 2,
  rankPercentile: 0.9,
  atr: 1,
  stopPrice: 8,
  maxEntry: 11,
  ask: 10,
  bid: 9.99,
  rotation: false,
};
const weak = {
  ...strong,
  momentum7dPct: -10,
  momentum24hPct: -3,
  relativeVolume: 1,
  rankPercentile: 0.1,
};

test("weights seed from the bot and merge tuned overrides", () => {
  const w = weightsFor("trend", { wM7: 3 });
  assert.equal(w.wM7, 3);
  assert.equal(w.wVol, SEED_WEIGHTS.trend.wVol);
});

test("the score rises with favoured features", () => {
  const w = weightsFor("trend");
  assert.ok(scoreCandidate(strong, w) > scoreCandidate(weak, w));
  const x = extract(strong);
  for (const v of Object.values(x))
    assert.ok(v >= 0 && v <= 1, `feature in [0,1]: ${v}`);
});

test("chooseWeightedMove buys the best executable candidate above threshold", () => {
  const read = chooseWeightedMove({
    bot: "trend",
    candidates: [weak, strong],
    positions: [],
    maxPositions: 3,
    rules: {},
  });
  assert.equal(read.action, "BUY");
  assert.equal(read.product, "AAA-USDC");
});

test("chooseWeightedMove skips when at capacity or below threshold", () => {
  const full = chooseWeightedMove({
    bot: "trend",
    candidates: [strong],
    positions: [
      { product: "X-USDC" },
      { product: "Y-USDC" },
      { product: "Z-USDC" },
    ],
    maxPositions: 3,
    rules: {},
  });
  assert.equal(full.action, "SKIP");
  const high = chooseWeightedMove({
    bot: "trend",
    candidates: [strong],
    positions: [],
    maxPositions: 3,
    rules: { scoreMin: 999 },
  });
  assert.equal(high.action, "SKIP");
});

test("executable requires sane stop geometry", () => {
  assert.equal(executable(strong, {}), true);
  assert.equal(executable({ ...strong, atr: 0 }, {}), false);
  assert.equal(executable({ ...strong, stopPrice: 11 }, {}), false);
  assert.equal(executable({ ...strong, ask: 12 }, {}), false); // past maxEntry
});

function risingFrames() {
  const five = [];
  for (let i = 0; i < 300; i++)
    five.push({
      time: i * 300000,
      open: 100 + i * 0.1,
      high: 100 + i * 0.1 + 0.2,
      low: 100 + i * 0.1 - 0.2,
      close: 100 + i * 0.1,
      volume: 1,
    });
  const hour = [];
  for (let i = 0; i < 220; i++)
    hour.push({
      time: i * 3600000,
      open: 100 + i * 0.1,
      high: 100 + i * 0.1 + 1,
      low: 100 + i * 0.1 - 1,
      close: 100 + i * 0.1,
      volume: 1,
    });
  return { five, hour, four: [] };
}

test("backtestWeighted is deterministic and bounded", () => {
  const frames = risingFrames();
  const a = backtestWeighted({ bot: "trend", frames, rules: {} });
  const b = backtestWeighted({ bot: "trend", frames, rules: {} });
  assert.deepEqual(a, b);
  assert.ok(a.trades <= 25);
});

test("exitWouldFire matches the code exit for each rule", () => {
  assert.equal(
    exitWouldFire("orakelia", { momentum7dPct: 1, momentum24hPct: -1 }),
    true,
  );
  assert.equal(
    exitWouldFire("orakelia", { momentum7dPct: 1, momentum24hPct: 1 }),
    false,
  );
  assert.equal(exitWouldFire("connors_thorp", { rsi: 55 }, {}), true);
  assert.equal(exitWouldFire("connors_thorp", { rsi: 20 }, {}), false);
  assert.equal(exitWouldFire("breakout_liquid", { rsi: 90 }), false);
});

test("chooseWeightedMove never buys a candidate the rule exit would close", () => {
  const wouldFade = { ...strong, momentum24hPct: -2 };
  const read = chooseWeightedMove({
    bot: "trend",
    rule: "orakelia",
    candidates: [wouldFade],
    positions: [],
    maxPositions: 3,
    rules: {},
  });
  assert.equal(read.action, "SKIP");
});

test("chooseWeightedMove skips paused products", () => {
  const read = chooseWeightedMove({
    bot: "trend",
    rule: "orakelia",
    candidates: [strong],
    positions: [],
    maxPositions: 3,
    rules: {},
    paused: new Set(["AAA-USDC"]),
  });
  assert.equal(read.action, "SKIP");
});
