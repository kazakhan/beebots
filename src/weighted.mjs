// Weighted trading model (4.0.0).
//
// Trading is decided by a code-side weighted score over a candidate's features,
// not by a model call. Weights are per bot, seeded from the templates the bot
// used to run, and tuned by the Trade Review (which backtests any change). Laya
// and the LLM are used only by the review.
//
// Feature normalisation uses FIXED clip ranges (not cohort-relative), so a score
// is stable, reproducible in the backtest, and needs no cohort to compute.
const clip = (x, a, b) => (x < a ? a : x > b ? b : x);

// The weight keys a bot may carry in `params.<bot>`, one per feature plus the
// entry threshold. Kept flat so they ride the existing override schema.
export const WEIGHT_KEYS = [
  "wM7",
  "wM24",
  "wVol",
  "wRsiLow",
  "wReversion",
  "wPriceUp",
  "wEma20",
  "wEma50",
  "wBreakout",
  "wLiquidity",
  "wRank",
];

// Seed weights per bot, reproducing the template each ran on: momentum+volume
// (Keeper/Orakelia), RSI mean-reversion (Spark/ConnorsThorp), breakout
// (Scout/Breakout).
export const SEED_WEIGHTS = {
  trend: {
    wM7: 2,
    wM24: 1.5,
    wVol: 1,
    wPriceUp: 0.5,
    wEma20: 0.5,
    wLiquidity: 0.5,
    wRank: 0.5,
  },
  momentum: {
    wRsiLow: 2,
    wReversion: 1.5,
    wEma20: 0.3,
    wEma50: 0.5,
    wLiquidity: 0.5,
  },
  breakout: {
    wBreakout: 2,
    wVol: 1.5,
    wEma20: 0.3,
    wEma50: 0.5,
    wLiquidity: 0.5,
  },
};
// Per-bot entry threshold on the score; the review tunes it.
export const SEED_SCORE_MIN = { trend: 1, momentum: 1, breakout: 1 };

const finite = (x) => Number.isFinite(Number(x));

// Normalise one candidate to the feature vector, each component in [0,1].
export function extract(f) {
  const rsi = finite(f.rsi) ? Number(f.rsi) : null;
  const m7 = finite(f.momentum7dPct) ? Number(f.momentum7dPct) : 0;
  const m24 = finite(f.momentum24hPct) ? Number(f.momentum24hPct) : 0;
  return {
    m7: (clip(m7, -20, 20) + 20) / 40,
    m24: (clip(m24, -10, 10) + 10) / 20,
    vol: finite(f.relativeVolume)
      ? clip(Number(f.relativeVolume) - 1, 0, 3) / 3
      : 0,
    rsiLow: rsi == null ? 0 : clip(30 - rsi, 0, 30) / 30,
    reversion:
      finite(f.prevRsi) && rsi != null && Number(f.prevRsi) < 30 && rsi >= 30
        ? 1
        : 0,
    priceUp: finite(f.previousClose) && f.close > f.previousClose ? 1 : 0,
    ema20:
      finite(f.hourClose) && finite(f.ema20) && f.hourClose > f.ema20 ? 1 : 0,
    ema50: finite(f.ema20) && finite(f.ema50) && f.ema20 > f.ema50 ? 1 : 0,
    breakout:
      finite(f.channelHigh) && f.channelHigh > 0
        ? clip((f.close / f.channelHigh - 1) * 100, 0, 5) / 5
        : 0,
    liquidity: finite(f.spreadBps)
      ? clip(10 - Number(f.spreadBps), 0, 10) / 10
      : 0,
    rank: finite(f.rankPercentile) ? clip(Number(f.rankPercentile), 0, 1) : 0,
  };
}

const FEATURE_OF = {
  wM7: "m7",
  wM24: "m24",
  wVol: "vol",
  wRsiLow: "rsiLow",
  wReversion: "reversion",
  wPriceUp: "priceUp",
  wEma20: "ema20",
  wEma50: "ema50",
  wBreakout: "breakout",
  wLiquidity: "liquidity",
  wRank: "rank",
};

// Merge a bot's seed weights with any tuned values in its effective rules.
export function weightsFor(bot, rules = {}) {
  const seed = SEED_WEIGHTS[bot] ?? {};
  const out = { ...seed };
  for (const key of WEIGHT_KEYS)
    if (finite(rules[key])) out[key] = Number(rules[key]);
  return out;
}

export function scoreMinFor(bot, rules = {}) {
  return finite(rules.scoreMin)
    ? Number(rules.scoreMin)
    : (SEED_SCORE_MIN[bot] ?? 0);
}

// A candidate is EXECUTABLE when the stop geometry is sane and it is not past
// the anti-chase cap (unless the setup is explicitly exempt) and not below the
// stop. Entry strategy is the score, so no template gate is required here.
export function executable(f, rules = {}) {
  if (!finite(f.atr) || Number(f.atr) <= 0) return false;
  if (!finite(f.stopPrice) || Number(f.stopPrice) <= 0) return false;
  if (!(f.close > f.stopPrice)) return false;
  if (
    !f.rotation &&
    finite(f.ask) &&
    finite(f.maxEntry) &&
    Number(f.ask) > Number(f.maxEntry)
  )
    return false;
  if (finite(f.ask) && !(Number(f.ask) > Number(f.stopPrice))) return false;
  return true;
}

export function scoreCandidate(f, weights) {
  const x = extract(f);
  let s = 0;
  for (const [key, feat] of Object.entries(FEATURE_OF))
    s += (Number(weights[key]) || 0) * x[feat];
  return s;
}

// Whether the code rule exit would fire for this feature snapshot. Shared by the
// entry (do not buy a position that would be closed immediately) and the exit
// (RuleExit), so entry and exit can never disagree (4.0.2).
export function exitWouldFire(rule, f, rules = {}) {
  if (rule === "orakelia")
    return Number(f.momentum7dPct) <= 0 || Number(f.momentum24hPct) <= 0;
  if (rule === "connors_thorp") {
    const neutral = Number(rules.rsiNeutral) || 50;
    return Number.isFinite(f.rsi) && Number(f.rsi) >= neutral;
  }
  return false;
}

// The weighted decision: buy the best-scoring executable candidate while room
// remains and the score clears the threshold; otherwise skip. Held positions are
// managed by code exits, so no HOLD/SELL is produced here. Candidates that the
// rule exit would immediately close, or that are in a post-exit cooldown, are
// never bought.
export function chooseWeightedMove({
  bot,
  rule = null,
  candidates = [],
  positions = [],
  maxPositions = 1,
  rules = {},
  paused = null,
}) {
  const weights = weightsFor(bot, rules);
  const min = scoreMinFor(bot, rules);
  const held = new Set(positions.map((p) => p.product));
  const room = positions.length < Number(maxPositions || 1);
  const pausedSet = paused instanceof Set ? paused : new Set(paused ?? []);
  let best = null;
  for (const c of candidates) {
    if (!c || typeof c.product !== "string") continue;
    if (held.has(c.product)) continue;
    if (pausedSet.has(c.product)) continue;
    if (!executable(c, rules)) continue;
    if (exitWouldFire(rule, c, rules)) continue;
    const score = scoreCandidate(c, weights);
    if (!best || score > best.score) best = { product: c.product, score };
  }
  if (room && best && best.score >= min)
    return { action: "BUY", product: best.product, score: best.score, min };
  return { action: "SKIP", product: null, score: best?.score ?? null, min };
}
