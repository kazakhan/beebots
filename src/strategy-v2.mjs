// Closed-bar strategy rules; all lookbacks exclude the bar being evaluated.
import { refuse } from "./refusal.mjs";
export const VERSION = "2.0.0";
// A strategy template names one of the CODED rules below, plus the universe it
// scans and the timeframe its signal is read on. The Trade Review assigns a
// template to a bot via `params.<bot>.strategy`. The daily review may add a
// template that recombines these rules (a "new" strategy) and may delete a
// template that is losing; it can never add a rule that is not coded here, so a
// template is always executable.
export const STRATEGY_RULES = {
  hexchaser: "7-day momentum leaders",
  orakelia: "7-day momentum + rising price & volume",
  market_mover: "Top-20 market-cap accumulation",
  trend_pullback: "Trend pullback (Keeper)",
};
// The initial template pool; id -> spec. `universe` is all | top100 | top20.
export const BUILTIN_TEMPLATES = {
  hexchaser: {
    label: "Hexchaser (7d momentum leader)",
    rule: "hexchaser",
    universe: "all",
    timeframe: "15m",
    count: 3,
  },
  orakelia: {
    label: "Orakelia (7d momentum + volume)",
    rule: "orakelia",
    universe: "all",
    timeframe: "15m",
    count: 3,
  },
  market_mover: {
    label: "Market Mover (top-20 accumulator)",
    rule: "market_mover",
    universe: "top20",
    timeframe: "1h",
    count: 3,
  },
  trend_pullback: {
    label: "Trend pullback (Keeper)",
    rule: "trend_pullback",
    universe: "all",
    timeframe: "15m",
    count: 3,
  },
};
// Kept for callers that only need the built-in names. The live pool may also
// contain review-created templates loaded via setTemplates().
export const STRATEGY_POOL = BUILTIN_TEMPLATES;
let POOL = { ...BUILTIN_TEMPLATES };
export function setTemplates(map) {
  // An explicit pool replaces the built-ins (so the daily review can delete a
  // template); no map resets to the built-ins.
  if (map && typeof map === "object" && Object.keys(map).length)
    POOL = { ...map };
  else POOL = { ...BUILTIN_TEMPLATES };
}
export function getTemplates() {
  return POOL;
}
export function resolveTemplate(strat) {
  // Fall back to the built-ins so a bot whose template was deleted keeps trading
  // until the review reassigns it.
  return POOL[strat] ?? BUILTIN_TEMPLATES[strat] ?? null;
}
export const DEFAULT_STRATEGY = {
  breakout: "orakelia",
  trend: "market_mover",
  momentum: "hexchaser",
};
// Every strategy now manages its own exit in code (percentage stop / trailing /
// max hold); the decider is never offered a discretionary SELL. Retained as a
// predicate for callers that still ask.
export const ROTATION_STRATEGIES = new Set(Object.keys(BUILTIN_TEMPLATES));
export function isRotationStrategy(strat) {
  return resolveTemplate(strat) !== null;
}
// Per-template defaults, merged under the bot defaults, so any bot can run any
// template even if its own defaults omit the fields that template reads.
export const TEMPLATE_DEFAULTS = {
  hexchaser: {
    maxExtensionAtr: 0.5,
    minSignalBars: 4,
    topFraction: 0.2,
    minBreadth: 10,
  },
  orakelia: {
    maxExtensionAtr: 0.5,
    minSignalBars: 4,
    topFraction: 0.2,
    minBreadth: 10,
    relativeVolume: 1,
  },
  market_mover: { maxExtensionAtr: 0.5, minSignalBars: 4, minBreadth: 1 },
  momentum_leaders: {
    maxExtensionAtr: 0.5,
    minSignalBars: 4,
    topFraction: 0.2,
    minBreadth: 10,
  },
  momentum_rotation_fast: {
    maxExtensionAtr: 0.5,
    minSignalBars: 0,
    topFraction: 0.2,
    minBreadth: 10,
  },
  range_breakout: {
    rangeBars: 24,
    rangeAtr: 6,
    relativeVolume: 2,
    maxExtensionAtr: 2,
    minSignalBars: 60,
    pullbackBars: 5,
  },
  trend_pullback: { pullbackBars: 5, maxExtensionAtr: 0.5, minSignalBars: 60 },
  momentum_continuation: {
    pullbackBars: 5,
    maxExtensionAtr: 0.5,
    minSignalBars: 4,
    topFraction: 0.2,
    minBreadth: 10,
  },
  mean_reversion: { pullbackBars: 5, maxExtensionAtr: 0.75, minSignalBars: 20 },
  breakout_retest: {
    rangeBars: 24,
    maxExtensionAtr: 0.75,
    minSignalBars: 20,
  },
  volatility_compression: {
    rangeBars: 24,
    rangeAtr: 6,
    relativeVolume: 2,
    maxExtensionAtr: 2,
    minSignalBars: 60,
  },
  range_mean_return: { rangeBars: 24, maxExtensionAtr: 0.5, minSignalBars: 40 },
};
export const defaults = {
  breakout: {
    strategy: "orakelia",
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
    // The protective stop / trailing / time exits are percentage-based and shared
    // with the control arm (3.6.0); size = riskPct / stopPct.
    stopPct: 3,
    trailPct: 3,
    trailActivationPct: 3,
    maxHoldHours: 48,
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
    strategy: "market_mover",
    pullbackBars: 5,
    maxExtensionAtr: 0.5,
    riskPct: 1,
    maxCostRisk: 0.2,
    stopPct: 3,
    trailPct: 3,
    trailActivationPct: 3,
    maxHoldHours: 48,
    trailAtr: 3,
    trailR: 2,
    // Keeper is a day trader: a 15-minute signal on the 4-hour trend context.
    timeframe: "15m",
    minSignalBars: 60,
    cadenceMs: 300000,
    maxCandidates: 25,
  },
  momentum: {
    strategy: "hexchaser",
    topFraction: 0.2,
    minBreadth: 10,
    riskPct: 1,
    maxCostRisk: 0.2,
    stopPct: 3,
    trailPct: 3,
    trailActivationPct: 3,
    maxHoldHours: 48,
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
  // Which template this bot runs. Its `rule` is a coded trigger; the template
  // may also carry the universe/timeframe. Unknown ids fall back to the bot's
  // own defaults.
  const template = resolveTemplate(rules?.strategy);
  const strat =
    template?.rule ??
    rules?.strategy ??
    defaults[id]?.strategy ??
    DEFAULT_STRATEGY[id] ??
    id;
  const r = {
      // Bot defaults are the base; the template's own defaults refine the keys its
      // rule reads (notably minSignalBars for a different timeframe); an explicit
      // rule/config value always wins.
      ...defaults[id],
      ...TEMPLATE_DEFAULTS[strat],
      ...rules,
      ...(template?.timeframe ? { timeframe: template.timeframe } : {}),
    },
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
  if (strat === "momentum_leaders") {
    if ((h?.length ?? 0) < 200 || bars.length < (Number(r.minSignalBars) || 4))
      throw Error("Momentum-leaders history warming");
    const a = atr(h),
      hp = h.map((x) => x.close);
    f.atr = a;
    f.hourClose = hp.at(-1);
    f.momentum24hPct = (hp.at(-1) / hp.at(-25) - 1) * 100;
    f.momentum7dPct = (hp.at(-1) / hp.at(-169) - 1) * 100;
    // No pullback/breakout gate: the ranking marks the top-3 leaders eligible.
    fail(
      f.momentum7dPct > 0 && f.momentum24hPct > 0,
      "Momentum not positive on both horizons",
    );
    fail(hp.at(-1) > ema(hp, 20), "Price below hourly EMA20");
    f.stopPrice = close - 2 * a;
    fail(close - f.stopPrice <= 3 * a, "Momentum stop too distant");
    f.maxEntry = close + r.maxExtensionAtr * a;
    f.rotation = true;
    f.rankScore = 0;
    f.rankTime = h.at(-1).time + 3600000;
  } else if (strat === "momentum_rotation_fast") {
    if ((h?.length ?? 0) < 30 || bars.length < (Number(r.minSignalBars) || 0))
      throw Error("Momentum-rotation history warming");
    const a = atr(h),
      hp = h.map((x) => x.close);
    f.atr = a;
    f.hourClose = hp.at(-1);
    f.return4hPct = (hp.at(-1) / hp.at(-5) - 1) * 100;
    f.momentum24hPct = (hp.at(-1) / hp.at(-25) - 1) * 100;
    fail(
      f.return4hPct > 0 && f.momentum24hPct > 0,
      "Momentum not positive on 4h and 24h",
    );
    fail(hp.at(-1) > ema(hp, 20), "Price below hourly EMA20");
    f.stopPrice = close - 2 * a;
    fail(close - f.stopPrice <= 3 * a, "Momentum stop too distant");
    f.maxEntry = close + r.maxExtensionAtr * a;
    f.rotation = true;
    f.rankScore = 0;
    f.rankTime = h.at(-1).time + 3600000;
  } else if (strat === "hexchaser") {
    // Hexchaser: the strongest 7-day momentum coins, ranked by the collector.
    if ((h?.length ?? 0) < 200 || bars.length < (Number(r.minSignalBars) || 4))
      throw Error("Hexchaser history warming");
    const a = atr(h),
      hp = h.map((x) => x.close);
    f.atr = a;
    f.hourClose = hp.at(-1);
    f.momentum24hPct = (hp.at(-1) / hp.at(-25) - 1) * 100;
    f.momentum7dPct = (hp.at(-1) / hp.at(-169) - 1) * 100;
    fail(f.momentum7dPct > 0, "7-day momentum not positive");
    fail(hp.at(-1) > ema(hp, 20), "Price below hourly EMA20");
    f.stopPrice = close - 2 * a;
    fail(close - f.stopPrice <= 3 * a, "Momentum stop too distant");
    f.maxEntry = close + r.maxExtensionAtr * a;
    f.rotation = true;
    f.rankScore = 0;
    f.rankTime = h.at(-1).time + 3600000;
  } else if (strat === "orakelia") {
    // Orakelia: 7-day momentum, but only while price and volume keep rising.
    if ((h?.length ?? 0) < 200 || bars.length < (Number(r.minSignalBars) || 4))
      throw Error("Orakelia history warming");
    const a = atr(h),
      hp = h.map((x) => x.close);
    f.atr = a;
    f.hourClose = hp.at(-1);
    f.momentum24hPct = (hp.at(-1) / hp.at(-25) - 1) * 100;
    f.momentum7dPct = (hp.at(-1) / hp.at(-169) - 1) * 100;
    const vols = h.slice(-25, -1).map((x) => x.volume),
      med = median(vols);
    f.relativeVolume = med > 0 ? h.at(-1).volume / med : 0;
    fail(f.momentum7dPct > 0, "7-day momentum not positive");
    fail(h.at(-1).close > h.at(-2).close, "Price not rising");
    fail(f.relativeVolume > 1, "Volume not rising");
    fail(hp.at(-1) > ema(hp, 20), "Price below hourly EMA20");
    f.stopPrice = close - 2 * a;
    fail(close - f.stopPrice <= 3 * a, "Momentum stop too distant");
    f.maxEntry = close + r.maxExtensionAtr * a;
    f.rotation = true;
    f.rankScore = 0;
    f.rankTime = h.at(-1).time + 3600000;
  } else if (strat === "market_mover") {
    // Market Mover: accumulate the largest top-20 coins and hold. The collector
    // restricts its universe; here we only avoid buying an established downtrend.
    if ((h?.length ?? 0) < 60) throw Error("Market-mover history warming");
    const a = atr(h),
      hp = h.map((x) => x.close);
    f.atr = a;
    f.hourClose = hp.at(-1);
    f.momentum24hPct = (hp.at(-1) / hp.at(-25) - 1) * 100;
    fail(hp.at(-1) > ema(hp, 50), "Price below the hourly EMA50");
    f.stopPrice = close - 2 * a;
    fail(close - f.stopPrice <= 3 * a, "Stop too distant");
    f.maxEntry = close + r.maxExtensionAtr * a;
    f.rotation = true;
    f.rankScore = 0;
    f.rankTime = h.at(-1).time + 3600000;
  } else if (strat === "range_breakout") {
    const minBars = Number(r.minSignalBars) || 120;
    if (bars.length < Math.max(minBars, 15) || (h?.length ?? 0) < 60)
      throw Error(
        `Range-breakout signal history warming (${bars.length}/${minBars} bars)`,
      );
    // Shared Keeper core: 1h uptrend context + orderly EMA20 pullback.
    const { a, stop } = trendCore(f, h, prior, r, fail);
    // Distinct trigger: a fresh breakout above the pre-breakout consolidation
    // range, on a relative-volume surge.
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
  } else if (strat === "trend_pullback") {
    if ((h?.length ?? 0) < 60 || bars.length < (Number(r.minSignalBars) || 60))
      throw Error("Trend-pullback context history warming");
    const { a, stop } = trendCore(f, h, prior, r, fail);
    const hp = prior.map((x) => x.close);
    // Resumption close above the prior high and the signal-timeframe EMA20.
    fail(
      close > prior.at(-1).high && close > ema([...hp, close], 20),
      "No hourly resumption close",
    );
    f.stopPrice = stop;
    fail(close - f.stopPrice <= 3 * a, "Pullback stop too distant");
    f.maxEntry = close + r.maxExtensionAtr * a;
    f.rankScore = f.ema20 / f.ema50;
  } else if (strat === "momentum_continuation") {
    const minBars = Number(r.minSignalBars) || 4;
    if (h.length < 200 || bars.length < Math.max(minBars, 15))
      throw Error("Momentum seven-day history warming");
    // Shared Keeper core, then the momentum trigger.
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
      "No continuation breakout",
    );
    f.stopPrice = stop;
    fail(close - f.stopPrice <= 3 * a, "Continuation stop too distant");
    f.maxEntry = close + r.maxExtensionAtr * a;
    f.rankScore = 0;
    f.rankTime = h.at(-1).time + 3600000;
  } else if (strat === "mean_reversion") {
    if ((h?.length ?? 0) < 60 || bars.length < (Number(r.minSignalBars) || 20))
      throw Error("Mean-reversion history warming");
    // Buy a dip within a 1h uptrend: the prior bar closed below the signal EMA20
    // and this bar reclaims the prior close (no demanded breakout).
    const { a, stop } = trendCore(f, h, prior, r, fail);
    const ema20s = ema([...prior.map((x) => x.close), close], 20);
    fail(prior.at(-1)?.close < ema20s, "No dip below EMA20");
    fail(close > prior.at(-1).close, "No reversion close");
    f.stopPrice = stop;
    fail(close - f.stopPrice <= 3 * a, "Reversion stop too distant");
    f.maxEntry = close + r.maxExtensionAtr * a;
    f.rankScore = f.ema20 / f.ema50;
  } else if (strat === "breakout_retest") {
    if ((h?.length ?? 0) < 60 || bars.length < (Number(r.minSignalBars) || 20))
      throw Error("Breakout-retest history warming");
    const { a, stop } = trendCore(f, h, prior, r, fail);
    const range = prior.slice(-r.rangeBars);
    f.channelHigh = Math.max(...range.map((x) => x.high));
    f.channelLow = Math.min(...range.map((x) => x.low));
    // The prior bar retested the broken level; this bar holds above it.
    fail(
      prior.at(-1)?.low <= f.channelHigh && close > f.channelHigh,
      "No breakout retest",
    );
    f.stopPrice = stop;
    fail(close - f.stopPrice <= 3 * a, "Retest stop too distant");
    f.maxEntry = close + r.maxExtensionAtr * a;
    f.rankScore = close / f.channelHigh;
  } else if (strat === "volatility_compression") {
    const minBars = Number(r.minSignalBars) || 60;
    if (bars.length < Math.max(minBars, 15))
      throw Error(`Compression history warming (${bars.length}/${minBars})`);
    const a = atr(prior);
    const range = prior.slice(-r.rangeBars),
      vols = range.map((x) => x.volume);
    f.atr = a;
    f.channelHigh = Math.max(...range.map((x) => x.high));
    f.channelLow = Math.min(...range.map((x) => x.low));
    f.relativeVolume = median(vols) > 0 ? last.volume / median(vols) : 0;
    f.compressionAtr = a > 0 ? (f.channelHigh - f.channelLow) / a : 0;
    fail(f.compressionAtr <= r.rangeAtr, "Range not compressed");
    fail(close > f.channelHigh, "No breakout close");
    fail(f.relativeVolume >= r.relativeVolume, "Relative volume insufficient");
    f.stopPrice = f.channelLow;
    fail(close - f.stopPrice <= 3 * a, "Compression stop too distant");
    f.maxEntry = close + r.maxExtensionAtr * a;
    f.rankScore = close / f.channelHigh;
  } else if (strat === "range_mean_return") {
    if ((h?.length ?? 0) < 60 || bars.length < (Number(r.minSignalBars) || 40))
      throw Error("Range history warming");
    const a = atr(prior),
      prices = h.map((x) => x.close);
    f.atr = a;
    f.ema20 = ema(prices, 20);
    f.ema50 = ema(prices, 50);
    // A range, not a trend: the context EMAs are close together.
    fail(
      Math.abs(f.ema20 - f.ema50) <= 0.02 * f.ema50,
      "Context is trending, not ranging",
    );
    const range = prior.slice(-r.rangeBars);
    f.channelHigh = Math.max(...range.map((x) => x.high));
    f.channelLow = Math.min(...range.map((x) => x.low));
    const width = f.channelHigh - f.channelLow;
    // Buy the lower band, expecting a return to the middle.
    fail(close <= f.channelLow + 0.25 * width, "Not at the range low");
    fail(close > prior.at(-1).close, "No upward turn");
    f.stopPrice = f.channelLow - 0.25 * a;
    fail(close - f.stopPrice <= 3 * a, "Range stop too distant");
    f.maxEntry = f.channelLow + 0.5 * width;
    f.rankScore = 0;
  } else {
    throw Error(`Unknown strategy ${strat}`);
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
export function rankMomentum(
  rows,
  rules = {},
  { count = null, keys = ["momentum24hPct", "momentum7dPct"] } = {},
) {
  const r = { ...defaults.momentum, ...rules };
  // Rank only the same completed hour, never mix stale and new intervals.
  const latest = Math.max(0, ...rows.map((x) => x.rankTime));
  const cohort = rows.filter((x) => x.rankTime === latest);
  const pct = (key, x) =>
    cohort.length <= 1
      ? 0
      : cohort.filter((y) => y[key] < x[key]).length / (cohort.length - 1);
  for (const f of rows) {
    f.rankScore = keys.reduce((n, k) => n + pct(k, f), 0) / keys.length;
    f.breadth = cohort.length;
  }
  const ranked = [...cohort].sort(
    (a, b) => b.rankScore - a.rankScore || a.product.localeCompare(b.product),
  );
  // `count` = an explicit top-K leader set (the rotation templates); otherwise
  // the historical top-`topFraction` set.
  const n = count
    ? Math.max(1, count)
    : Math.max(1, Math.ceil(cohort.length * r.topFraction));
  const top = new Set(ranked.slice(0, n).map((x) => x.product));
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
  // The momentum-rotation templates buy strength by design, so they are exempt
  // from the anti-chase maxEntry cap (size is still risk-capped by the stop).
  if (!f.rotation && !(Number.isFinite(f.ask) && f.ask <= f.maxEntry))
    return "Entry too extended (ask past the max entry)";
  if (!(f.ask > f.stopPrice)) return "Entry below the stop";
  // The channel rule belongs to the breakout setup, not to the bot id: only
  // applies when the candidate actually carries a channel.
  if (
    id === "breakout" &&
    Number.isFinite(f.channelHigh) &&
    !(f.bid > f.channelHigh)
  )
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
  // Size against the exit that will actually fire: a percentage stop shared with
  // the control arm when `stopPct` is set, else the setup geometry stop.
  const stopPct = Number(rules.stopPct) || 0;
  const distance = stopPct > 0 ? (q.ask * stopPct) / 100 : q.ask - f.stopPrice;
  if (!(distance > 0 && riskBudget > 0))
    throw refuse("Invalid strategy risk distance");
  const quantity = Math.min(
    (cash * rules.tradeFraction) / (q.ask * (1 + fee + 0.001)),
    riskBudget / (distance + 2 * fee * q.ask),
  );
  const buy = walk(q.asks, quantity),
    sell = walk(q.bids, quantity);
  const stopLevel = stopPct > 0 ? q.ask * (1 - stopPct / 100) : f.stopPrice;
  const cost =
    quantity *
    (buy - q.ask + 2 * (q.bid - sell) + (q.ask - q.bid) + 2 * fee * buy);
  const risk = quantity * (buy - stopLevel);
  if (cost > risk * rules.maxCostRisk)
    throw refuse("Execution costs exceed strategy risk allowance");
  if (risk + quantity * 2 * fee * buy > riskBudget * 1.001)
    throw refuse("Depth impact exceeds risk budget");
  return {
    quote: quantity * q.ask,
    quantity,
    stopPrice: stopLevel,
    initialRisk: buy - stopLevel,
    breakoutLevel: f.channelHigh ?? null,
    atr: f.atr,
    version: VERSION,
    signalTime: f.signalTime,
  };
}
