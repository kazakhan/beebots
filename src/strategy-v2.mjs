// Closed-bar strategy rules; all lookbacks exclude the bar being evaluated.
import { refuse } from "./refusal.mjs";
export const VERSION = "2.0.0";
export const defaults = {
  breakout: {
    rangeBars: 24,
    // Loosened in 2.3.0. The live coverage panel showed genuine breakouts held
    // back by four independent edges at once: compressionAtr 4.13-5.30 against a
    // 4.0 limit, and completed breakouts rejected only for being past the
    // 0.5-ATR extension cap (USELESS, PNUT). relativeVolume was never the
    // constraint - the same candidates ran 8x-43x against a 2x threshold.
    rangeAtr: 6,
    relativeVolume: 2,
    maxExtensionAtr: 2,
    riskPct: 1,
    // Meme pairs have wide spreads and thin books; 0.2 vetoed most candidates at
    // the execution-cost check.
    maxCostRisk: 0.4,
    trailAtr: 2,
    trailR: 2,
    // Shared Keeper core (3.3.8): the pullback window, measured on the signal
    // timeframe, then Scout's own range-breakout trigger.
    pullbackBars: 15,
    // Defaults are the starting point; the Trade Review tunes them (bounded by
    // the override schema). Scout scans every tradeable market, meme and new
    // listings ranked first.
    timeframe: "5m",
    minSignalBars: 120,
    cadenceMs: 300000,
    maxCandidates: 25,
    categories: ["meme", "speculative", "unclassified"],
  },
  trend: {
    pullbackBars: 5,
    maxExtensionAtr: 0.5,
    riskPct: 1,
    maxCostRisk: 0.2,
    trailAtr: 3,
    trailR: 2,
    // Keeper is a day trader: a 15-minute signal on the 4-hour trend context.
    timeframe: "15m",
    minSignalBars: 60,
    cadenceMs: 300000,
    maxCandidates: 25,
  },
  momentum: {
    topFraction: 0.2,
    minBreadth: 10,
    riskPct: 1,
    maxCostRisk: 0.2,
    trailAtr: 2.5,
    trailR: 2,
    // The shared trigger reads maxExtensionAtr; without it maxEntry is NaN and
    // every Spark setup is rejected as "Move already extended".
    maxExtensionAtr: 0.5,
    // Shared Keeper core (3.3.8): the pullback window, then Spark's momentum
    // trigger and top-quintile ranking.
    pullbackBars: 5,
    timeframe: "15m",
    minSignalBars: 4,
    cadenceMs: 300000,
    maxCandidates: 25,
  },
};
export function ema(xs, n) {
  return xs.reduce(
    (a, x) => (a === null ? x : a + (2 / (n + 1)) * (x - a)),
    null,
  );
}
export function median(xs) {
  const a = [...xs].sort((x, y) => x - y);
  return a.length % 2
    ? a[a.length >> 1]
    : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
}
export function atr(rows, n = 14) {
  if (rows.length < n + 1) throw Error("ATR history missing");
  const tr = rows
    .slice(1)
    .map((x, i) =>
      Math.max(
        x.high - x.low,
        Math.abs(x.high - rows[i].close),
        Math.abs(x.low - rows[i].close),
      ),
    );
  return tr.slice(-n).reduce((a, x) => a + x, 0) / n;
}
export function aggregate(rows, seconds) {
  const groups = new Map();
  for (const r of rows) {
    const t = Math.floor(r.time / (seconds * 1000)) * seconds * 1000;
    const g = groups.get(t) || [];
    g.push(r);
    groups.set(t, g);
  }
  const size = seconds / 300;
  return [...groups]
    .filter(
      ([t, g]) =>
        g.length === size && g.every((r, i) => r.time === t + i * 300000),
    )
    .map(([time, g]) => ({
      time,
      open: g[0].open,
      high: Math.max(...g.map((x) => x.high)),
      low: Math.min(...g.map((x) => x.low)),
      close: g.at(-1).close,
      volume: g.reduce((s, x) => s + x.volume, 0),
    }));
}
// Keeper's core, shared by every strategy: an uptrend on the context timeframe
// (the 1-hour frames) and an orderly EMA20 pullback on the signal timeframe.
// Each strategy supplies its own trigger on top, so the three stay distinct
// while all lean on the pattern that outperforms Dice. `fail(false, reason)`
// records a rejection. Sets the context EMAs and atr on `f` and returns the atr
// and the pullback stop.
//
// The context check is deliberately simple — price above a long EMA and the
// short EMA above the long one. Keeper's original 4-hour, 250-bar stack required
// ~41 days of history and starved every other market. Do not bring that back.
export function trendCore(f, ctx, prior, rules, fail) {
  const a = atr(prior),
    prices = ctx.map((x) => x.close),
    a20 = ema(prices, 20),
    a50 = ema(prices, 50);
  f.atr = a;
  f.ema20 = a20;
  f.ema50 = a50;
  f.contextClose = prices.at(-1);
  fail(f.contextClose > a50 && a20 > a50, "Context uptrend not established");
  const pullback = prior.slice(-Math.max(1, Number(rules.pullbackBars) || 5));
  const zones = pullback.map((bar, i) => {
    const tail = prior.slice(0, prior.length - pullback.length + i + 1);
    return {
      bar,
      e20: ema(
        tail.map((x) => x.close),
        20,
      ),
      e50: ema(
        tail.map((x) => x.close),
        50,
      ),
    };
  });
  fail(
    zones.some(
      (x) => x.bar.low <= x.e20 + 0.5 * a && x.bar.high >= x.e20 - 0.5 * a,
    ),
    "No orderly EMA20 pullback",
  );
  fail(
    zones.every((x) => x.bar.close >= x.e50),
    "Pullback lost EMA50",
  );
  return { a, stop: Math.min(...pullback.map((x) => x.low)) - 0.25 * a };
}
export function evaluate(id, frames, rules, membership) {
  const r = { ...defaults[id], ...rules },
    c = frames.five,
    h = frames.hour;
  // The signal timeframe is tunable (5m / 15m / 1h). The bar period the style
  // reads from is what the Trade Review tunes so a bot can day-trade.
  const bars =
    r.timeframe === "5m" ? c : r.timeframe === "1h" ? h : aggregate(c, 900);
  if (!bars?.length) throw Error("Signal history missing");
  const last = bars.at(-1),
    prior = bars.slice(0, -1),
    close = last.close;
  const f = {
    strategyVersion: VERSION,
    period: id === "breakout" ? "5m" : id === "trend" ? "1h" : "15m",
    signalTime:
      last.time +
      (id === "breakout" ? 300000 : id === "trend" ? 3600000 : 900000),
    close,
    previousClose: prior.at(-1)?.close,
    setupEligible: false,
    reasons: [],
    category: membership.category,
  };
  const fail = (condition, reason) => {
    if (!condition) f.reasons.push(reason);
  };
  if (id === "breakout") {
    const minBars = Number(r.minSignalBars) || 120;
    if (bars.length < Math.max(minBars, 15) || (h?.length ?? 0) < 60)
      throw Error(
        `Scout signal history warming (${bars.length}/${minBars} bars)`,
      );
    // Shared Keeper core: 1h uptrend context + orderly EMA20 pullback.
    const { a, stop } = trendCore(f, h, prior, r, fail);
    // Scout's distinct trigger: a fresh breakout above the pre-breakout
    // consolidation range, on a relative-volume surge.
    const range = prior.slice(-r.rangeBars),
      vols = range.map((x) => x.volume);
    f.channelHigh = Math.max(...range.map((x) => x.high));
    f.channelLow = Math.min(...range.map((x) => x.low));
    f.relativeVolume = median(vols) > 0 ? last.volume / median(vols) : 0;
    f.compressionAtr = a > 0 ? (f.channelHigh - f.channelLow) / a : 0;
    fail(close > f.channelHigh, "No completed breakout close");
    fail(f.relativeVolume >= r.relativeVolume, "Relative volume insufficient");
    f.stopPrice = stop;
    fail(close - f.stopPrice <= 3 * a, "Breakout stop too distant");
    f.maxEntry = close + r.maxExtensionAtr * a;
    f.rankScore = close / f.channelHigh;
  } else if (id === "trend") {
    if ((h?.length ?? 0) < 60 || bars.length < (Number(r.minSignalBars) || 60))
      throw Error("Keeper context history warming");
    const { a, stop } = trendCore(f, h, prior, r, fail);
    const hp = prior.map((x) => x.close);
    // Keeper's distinct trigger: a resumption close above the prior high and
    // above the signal-timeframe EMA20.
    fail(
      close > prior.at(-1).high && close > ema([...hp, close], 20),
      "No hourly resumption close",
    );
    f.stopPrice = stop;
    fail(close - f.stopPrice <= 3 * a, "Pullback stop too distant");
    f.maxEntry = close + r.maxExtensionAtr * a;
    f.rankScore = f.ema20 / f.ema50;
  } else {
    const minBars = Number(r.minSignalBars) || 4;
    if (h.length < 200 || bars.length < Math.max(minBars, 15))
      throw Error("Spark seven-day history warming");
    // Shared Keeper core, then Spark's momentum trigger.
    const { a, stop } = trendCore(f, h, prior, r, fail);
    const hp = h.map((x) => x.close),
      ema20h = ema(hp, 20);
    f.hourClose = hp.at(-1);
    f.momentum24hPct = (hp.at(-1) / hp.at(-25) - 1) * 100;
    f.momentum7dPct = (hp.at(-1) / hp.at(-169) - 1) * 100;
    fail(
      f.momentum24hPct > 0 && f.momentum7dPct > 0,
      "Momentum not positive on both horizons",
    );
    fail(hp.at(-1) > ema20h, "Hourly price below EMA20");
    fail(
      close > Math.max(...prior.slice(-3).map((x) => x.high)),
      "No 15-minute continuation breakout",
    );
    f.stopPrice = stop;
    fail(close - f.stopPrice <= 3 * a, "Continuation stop too distant");
    f.maxEntry = close + r.maxExtensionAtr * a;
    f.rankScore = 0;
    f.rankTime = h.at(-1).time + 3600000;
  }
  fail(
    Number.isFinite(f.atr) &&
      f.atr > 0 &&
      f.stopPrice > 0 &&
      f.stopPrice < close,
    "Invalid stop geometry",
  );
  fail(close <= f.maxEntry, "Move already extended");
  f.setupEligible = f.reasons.length === 0;
  return f;
}
export function rankMomentum(rows, rules = {}) {
  const r = { ...defaults.momentum, ...rules };
  // Rank only the same completed hour, never mix stale and new intervals.
  const latest = Math.max(0, ...rows.map((x) => x.rankTime));
  const cohort = rows.filter((x) => x.rankTime === latest);
  const pct = (key, x) =>
    cohort.length <= 1
      ? 0
      : cohort.filter((y) => y[key] < x[key]).length / (cohort.length - 1);
  for (const f of rows) {
    f.rankScore = (pct("momentum24hPct", f) + pct("momentum7dPct", f)) / 2;
    f.breadth = cohort.length;
  }
  const ranked = [...cohort].sort(
    (a, b) => b.rankScore - a.rankScore || a.product.localeCompare(b.product),
  );
  const top = new Set(
    ranked
      .slice(0, Math.max(1, Math.ceil(cohort.length * r.topFraction)))
      .map((x) => x.product),
  );
  for (const f of rows) {
    f.rankPercentile = f.rankScore;
    if (
      f.rankTime !== latest ||
      cohort.length < r.minBreadth ||
      !top.has(f.product)
    ) {
      f.setupEligible = false;
      f.reasons.push(
        cohort.length < r.minBreadth
          ? "Insufficient comparison breadth"
          : "Outside momentum leaders",
      );
    }
  }
  return rows;
}
// Why a candidate is not an executable entry, or null when it is. Used both to
// decide eligibility and to state the exact reason a chosen entry was declined.
export function entryRejection(id, f) {
  if (f.setupEligible !== true) return "Setup no longer qualifies";
  if (!(Number.isFinite(f.ask) && f.ask <= f.maxEntry))
    return "Entry too extended (ask past the max entry)";
  if (!(f.ask > f.stopPrice)) return "Entry below the stop";
  if (id === "breakout" && !(f.bid > f.channelHigh))
    return "Breakout lost the channel";
  return null;
}
export function entryEligible(id, f) {
  return entryRejection(id, f) === null;
}
export function walk(levels, quantity) {
  let remaining = quantity,
    value = 0;
  for (const l of levels ?? []) {
    const price = Number(l.price),
      size = Number(l.size);
    if (!(price > 0 && size >= 0)) throw Error("Invalid depth");
    const take = Math.min(remaining, size);
    value += take * price;
    remaining -= take;
    if (remaining <= quantity * 1e-12) break;
  }
  if (remaining > quantity * 1e-10)
    throw refuse("Insufficient order-book depth");
  return value / quantity;
}
export function executionPlan(f, q, cash, fee, rules) {
  const riskBudget = (cash * rules.riskPct) / 100;
  const distance = q.ask - f.stopPrice;
  if (!(distance > 0 && riskBudget > 0))
    throw refuse("Invalid strategy risk distance");
  const quantity = Math.min(
    (cash * rules.tradeFraction) / (q.ask * (1 + fee + 0.001)),
    riskBudget / (distance + 2 * fee * q.ask),
  );
  const buy = walk(q.asks, quantity),
    sell = walk(q.bids, quantity);
  const cost =
    quantity *
    (buy - q.ask + 2 * (q.bid - sell) + (q.ask - q.bid) + 2 * fee * buy);
  const risk = quantity * (buy - f.stopPrice);
  if (cost > risk * rules.maxCostRisk)
    throw refuse("Execution costs exceed strategy risk allowance");
  if (risk + quantity * 2 * fee * buy > riskBudget * 1.001)
    throw refuse("Depth impact exceeds risk budget");
  return {
    quote: quantity * q.ask,
    quantity,
    stopPrice: f.stopPrice,
    initialRisk: buy - f.stopPrice,
    breakoutLevel: f.channelHigh ?? null,
    atr: f.atr,
    version: VERSION,
    signalTime: f.signalTime,
  };
}
