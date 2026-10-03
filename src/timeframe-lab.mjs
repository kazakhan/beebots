// Timeframe Lab — deterministic, code-generated evidence about the signal
// timeframe.
//
// The Trade Review may change a bot's `timeframe` (5m / 15m / 1h). Without
// evidence that is guesswork, so this module re-runs each bot's own strategy
// (`evaluate`, the same function the live collector uses) over the candles we
// already hold, at every timeframe, and simulates the bot's own exits —
// protective stop, trailing stop, and the maxHoldHours time stop. It returns, per
// arm per timeframe, the trades, wins, losses and net return.
//
// It is a SIMULATION over closed bars (bid/ask approximated by the bar close),
// not a live result, and it is bounded: a product cap, an evaluation cap and a
// time budget. When a bound is hit the sample is marked `partial` and the review
// must not act on it. No orders, no LLM, no side effects.

import { evaluate, aggregate } from "./strategy-v2.mjs";

export const TIMEFRAME_MS = { "5m": 300000, "15m": 900000, "1h": 3600000 };
export const DEFAULT_TIMEFRAMES = ["5m", "15m", "1h"];

// A time-limited, count-limited budget. `exceeded` is checked between bars so a
// pathological universe cannot stall the review loop. The deadline is shared
// across the whole lab so the total synchronous time stays bounded.
function budgetFor({ evalCap, deadline }) {
  let count = 0;
  return {
    get exceeded() {
      return count >= evalCap || Date.now() > deadline;
    },
    spend() {
      count++;
    },
  };
}

// Slice the frame history to the bars that are complete by `endTime`, advancing
// monotonic pointers so the walk is linear, not quadratic, in the bar count.
function frameBuilder(frames) {
  const five = frames.five ?? [],
    hour = frames.hour ?? [],
    four = frames.four ?? [];
  let i5 = 0,
    ih = 0,
    i4 = 0;
  return (endTime) => {
    while (i5 < five.length && five[i5].time + 300000 <= endTime) i5++;
    while (ih < hour.length && hour[ih].time + 3600000 <= endTime) ih++;
    while (i4 < four.length && four[i4].time + 14400000 <= endTime) i4++;
    return {
      five: five.slice(0, i5),
      hour: hour.slice(0, ih),
      four: four.slice(0, i4),
    };
  };
}

function barsFor(frames, timeframe) {
  if (timeframe === "5m") return frames.five ?? [];
  if (timeframe === "1h") return frames.hour ?? [];
  return aggregate(frames.five ?? [], 900);
}

// One arm at one timeframe. Emits signals through `evaluateFn` (injectable so the
// simulation can be tested deterministically) and simulates the arm's exits.
export function simulateTimeframe({
  frames,
  membership = { category: "unclassified" },
  id,
  rules,
  timeframe,
  since,
  until,
  feePct,
  evaluateFn = evaluate,
  budget,
}) {
  const bars = barsFor(frames, timeframe),
    period = TIMEFRAME_MS[timeframe],
    build = frameBuilder(frames);
  const exits = {
    stopPct: Number(rules.stopPct) || 0,
    trailPct: Number(rules.trailPct) || 0,
    trailActivationPct: Number(rules.trailActivationPct) || 0,
    maxHoldHours: Number(rules.maxHoldHours) || 0,
  };
  const stats = { trades: 0, wins: 0, losses: 0, net: 0, partial: false };
  let open = null;
  const close = (exit, entryTime) => {
    const ret = (exit / open.entry - 1) * 100 - feePct;
    stats.trades++;
    stats.net += ret;
    if (ret > 0) stats.wins++;
    else stats.losses++;
    open = null;
  };
  for (let k = 0; k < bars.length; k++) {
    const bar = bars[k];
    const barCloseTime = bar.time + period;
    // Only simulate bars whose result lands inside the review window; but an
    // open position must still be advanced through them.
    const inWindow = barCloseTime >= since && barCloseTime <= until;
    if (open) {
      open.peak = Math.max(open.peak, bar.high);
      if (bar.low <= open.stopLevel) close(open.stopLevel, barCloseTime);
      else if (
        open.peak >= open.trailActivate &&
        bar.close <= open.peak * (1 - exits.trailPct / 100)
      )
        close(bar.close, barCloseTime);
      else if (
        exits.maxHoldHours > 0 &&
        barCloseTime - open.entryTime > exits.maxHoldHours * 3600000
      )
        close(bar.close, barCloseTime);
    }
    if (open || !inWindow) continue;
    if (budget.exceeded) {
      stats.partial = true;
      break;
    }
    let f;
    try {
      f = evaluateFn(
        id,
        build(barCloseTime),
        { ...rules, timeframe },
        membership,
      );
    } catch {
      continue;
    }
    budget.spend();
    if (f?.setupEligible) {
      open = {
        entry: bar.close,
        entryTime: barCloseTime,
        peak: bar.close,
        stopLevel: bar.close * (1 - exits.stopPct / 100),
        trailActivate: bar.close * (1 + exits.trailActivationPct / 100),
      };
    }
  }
  // Realise a still-open position at the final bar so it is not silently dropped.
  if (open) {
    const last = bars.at(-1);
    if (last) close(last.close, last.time + period);
  }
  return stats;
}

// Build the whole table. `framesFor(product)` and `membershipFor(product)` keep
// the caller (the engine) free to hand over the market's own structures.
export function buildTimeframeLab({
  products = [],
  framesFor,
  membershipFor = () => ({ category: "unclassified" }),
  arms = [],
  since,
  until,
  feePct = 1.2,
  productCap = 12,
  evalCap = 2500,
  timeBudgetMs = 1500,
  timeframes = DEFAULT_TIMEFRAMES,
  evaluateFn = evaluate,
} = {}) {
  const list = [...new Set(products)].slice(0, productCap);
  const deadline = Date.now() + Math.max(500, timeBudgetMs);
  const out = {
    generatedAt: Date.now(),
    since,
    until,
    feePct,
    arms: {},
    partial: false,
  };
  for (const arm of arms) {
    const rules = arm.rules ?? {};
    const entry = {
      current: rules.timeframe ?? null,
      timeframes: {},
      baseline: null,
      partial: false,
    };
    // A buy-and-hold baseline over the window, for context only (not a gate).
    let baseSum = 0,
      baseN = 0;
    for (const timeframe of timeframes) {
      const budget = budgetFor({ evalCap, deadline });
      let trades = 0,
        wins = 0,
        losses = 0,
        net = 0,
        partial = false;
      for (const product of list) {
        const frames = framesFor(product);
        if (!frames?.five?.length) continue;
        const stats = simulateTimeframe({
          frames,
          membership: membershipFor(product),
          id: arm.id,
          rules,
          timeframe,
          since,
          until,
          feePct,
          budget,
          evaluateFn,
        });
        trades += stats.trades;
        wins += stats.wins;
        losses += stats.losses;
        net += stats.net;
        partial = partial || stats.partial;
      }
      entry.timeframes[timeframe] = {
        trades,
        wins,
        losses,
        net: Number(net.toFixed(2)),
        avg: trades ? Number((net / trades).toFixed(3)) : 0,
        partial,
      };
      entry.partial = entry.partial || partial;
    }
    // Baseline: equal-weight product return over the window, best effort.
    for (const product of list) {
      const five = framesFor(product)?.five;
      if (!five?.length || five.length < 2) continue;
      baseSum += (five.at(-1).close / five[0].close - 1) * 100;
      baseN++;
    }
    entry.baseline = baseN ? Number((baseSum / baseN).toFixed(2)) : null;
    out.arms[arm.id] = entry;
    out.partial = out.partial || entry.partial;
  }
  return out;
}
