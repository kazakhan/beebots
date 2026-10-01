// Closed-bar strategy rules; all lookbacks exclude the bar being evaluated.
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
  },
  trend: {
    pullbackBars: 5,
    maxExtensionAtr: 0.5,
    riskPct: 1,
    maxCostRisk: 0.2,
    trailAtr: 3,
    trailR: 2,
  },
  momentum: {
    topFraction: 0.2,
    minBreadth: 10,
    riskPct: 1,
    maxCostRisk: 0.2,
    trailAtr: 2.5,
    trailR: 2,
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
export function evaluate(id, frames, rules, membership) {
  const r = { ...defaults[id], ...rules },
    c = frames.five,
    h = frames.hour,
    ctx = frames.four;
  const bars = id === "breakout" ? c : id === "trend" ? h : aggregate(c, 900);
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
    if (c.length < 200)
      throw Error("Scout requires 200 completed 5-minute bars");
    fail(
      ["meme", "speculative"].includes(membership.category),
      "Not in Scout speculative universe",
    );
    const range = prior.slice(-r.rangeBars),
      a = atr(prior),
      vols = range.map((x) => x.volume);
    const reference = Array.from({ length: 100 }, (_, i) =>
      atr(prior.slice(0, prior.length - i)),
    );
    f.atr = a;
    f.channelHigh = Math.max(...range.map((x) => x.high));
    f.channelLow = Math.min(...range.map((x) => x.low));
    f.relativeVolume = median(vols) > 0 ? last.volume / median(vols) : 0;
    f.compressionAtr = (f.channelHigh - f.channelLow) / a;
    fail(f.compressionAtr <= r.rangeAtr, "Range not compressed");
    // Loosened in 2.3.0: was `a < median(reference)`, which vetoed almost every
    // candidate. The live panel showed SHIB, PNUT and BASECAT failing only on
    // this test. Contraction is now measured relative to the rolling median.
    fail(a < 1.5 * median(reference), "Volatility not contracted");
    fail(close > f.channelHigh, "No completed breakout close");
    // Loosened in 2.3.0: was >= 0.75, which rejected PNUT, BASECAT and GHST.
    fail(
      last.high > last.low &&
        (close - last.low) / (last.high - last.low) >= 0.5,
      "Weak breakout close location",
    );
    fail(f.relativeVolume >= r.relativeVolume, "Relative volume insufficient");
    f.stopPrice = Math.max(f.channelLow, f.channelHigh - 1.5 * a);
    fail(close - f.stopPrice >= 0.5 * a, "Stop inside execution noise");
    f.maxEntry = f.channelHigh + r.maxExtensionAtr * a;
    f.rankScore = close / f.channelHigh;
  } else if (id === "trend") {
    if (ctx.length < 250 || h.length < 60)
      throw Error("Keeper context history warming");
    const prices = ctx.map((x) => x.close),
      hp = prior.map((x) => x.close),
      a = atr(prior);
    f.atr = a;
    f.ema20 = ema(prices, 20);
    f.ema50 = ema(prices, 50);
    f.contextClose = prices.at(-1);
    fail(
      f.contextClose > f.ema20 &&
        f.ema20 > f.ema50 &&
        f.ema50 > ema(prices.slice(0, -5), 50),
      "Four-hour uptrend not established",
    );
    const pullback = prior.slice(-r.pullbackBars);
    const zones = pullback.map((bar, i) => {
      const tail = prior.slice(0, prior.length - r.pullbackBars + i + 1);
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
    fail(
      close > prior.at(-1).high && close > ema([...hp, close], 20),
      "No hourly resumption close",
    );
    f.stopPrice = Math.min(...pullback.map((x) => x.low)) - 0.25 * a;
    fail(close - f.stopPrice <= 3 * a, "Pullback stop too distant");
    f.maxEntry = close + r.maxExtensionAtr * a;
    f.rankScore = f.ema20 / f.ema50;
  } else {
    if (h.length < 200 || bars.length < 4)
      throw Error("Spark seven-day history warming");
    const hp = h.map((x) => x.close);
    f.atr = atr(h);
    f.ema20 = ema(hp, 20);
    f.hourClose = hp.at(-1);
    f.momentum24hPct = (hp.at(-1) / hp.at(-25) - 1) * 100;
    f.momentum7dPct = (hp.at(-1) / hp.at(-169) - 1) * 100;
    fail(
      f.momentum24hPct > 0 && f.momentum7dPct > 0,
      "Momentum not positive on both horizons",
    );
    fail(hp.at(-1) > f.ema20, "Hourly price below EMA20");
    fail(
      close > Math.max(...prior.slice(-3).map((x) => x.high)),
      "No 15-minute continuation breakout",
    );
    f.stopPrice = close - 2 * f.atr;
    f.maxEntry = f.ema20 + 2 * f.atr;
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
export function entryEligible(id, f) {
  return (
    f.setupEligible === true &&
    Number.isFinite(f.ask) &&
    f.ask <= f.maxEntry &&
    f.ask > f.stopPrice &&
    (id !== "breakout" || f.bid > f.channelHigh)
  );
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
    throw Error("Insufficient order-book depth");
  return value / quantity;
}
export function executionPlan(f, q, cash, fee, rules) {
  const riskBudget = (cash * rules.riskPct) / 100;
  const distance = q.ask - f.stopPrice;
  if (!(distance > 0 && riskBudget > 0))
    throw Error("Invalid strategy risk distance");
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
    throw Error("Execution costs exceed strategy risk allowance");
  if (risk + quantity * 2 * fee * buy > riskBudget * 1.001)
    throw Error("Depth impact exceeds risk budget");
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
