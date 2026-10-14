// Deterministic backtest for the weighted model (4.0.0).
//
// Replays a bot's weighted entries over the candles already held and simulates
// the bot's own exits, so the Trade Review can accept a weight change only if it
// improves net P&L. It is a SIMULATION over closed bars (bid/ask approximated by
// the bar close) and is bounded (product/eval/time caps). No orders, no models.
import {
  aggregate,
  atr,
  ema,
  median,
  rsi,
  resolveTemplate,
} from "./strategy-v2.mjs";
import {
  weightsFor,
  scoreMinFor,
  executable,
  scoreCandidate,
  exitWouldFire,
} from "./weighted.mjs";

const TAKER = 0.006; // round-trip fee assumption (each side), like the live taker tier
const TF_MS = { "5m": 300000, "15m": 900000, "1h": 3600000 };

function signalBars(frames, timeframe) {
  if (timeframe === "5m") return frames.five ?? [];
  if (timeframe === "1h") return frames.hour ?? [];
  return aggregate(frames.five ?? [], 900);
}

// A bounded feature snapshot at signal bar i, mirroring what evaluate() provides.
function featuresAt(sig, hourAll, i, bot) {
  const bar = sig[i];
  const closes = sig.slice(0, i + 1).map((x) => x.close);
  const prior = sig.slice(Math.max(0, i - 24), i).map((x) => x.high);
  const priorLow = sig.slice(Math.max(0, i - 24), i).map((x) => x.low);
  const hour = hourAll.filter((h) => h.time + 3600000 <= bar.time + 900000);
  const hp = hour.map((x) => x.close);
  const vols = hour.slice(-25, -1).map((x) => x.volume);
  const med = median(vols);
  const f = {
    close: bar.close,
    previousClose: sig[i - 1]?.close ?? bar.close,
    atr: 0,
    rotation: false,
    spreadBps: 5,
    rankPercentile: 0.5,
  };
  try {
    f.atr = atr(sig.slice(0, i + 1));
  } catch {
    f.atr = 0;
  }
  if (hp.length >= 169) {
    f.momentum7dPct = (hp.at(-1) / hp.at(-169) - 1) * 100;
    f.momentum24hPct = (hp.at(-1) / hp.at(-25) - 1) * 100;
  } else if (hp.length >= 25) {
    f.momentum24hPct = (hp.at(-1) / hp.at(-25) - 1) * 100;
  }
  f.hourClose = hp.at(-1);
  f.ema20 = ema(hp, 20);
  f.ema50 = ema(hp, 50);
  f.relativeVolume = med > 0 ? hour.at(-1).volume / med : 0;
  f.rsi = rsi(closes, 14);
  f.prevRsi = rsi(closes.slice(0, -1), 14);
  if (prior.length) {
    f.channelHigh = Math.max(...prior);
    f.channelLow = Math.min(...priorLow);
  }
  f.stopPrice = f.atr > 0 ? bar.close - 2 * f.atr : bar.close;
  f.maxEntry = bar.close + 0.5 * f.atr;
  f._closes = closes;
  return f;
}

// The exit that fires next for a position opened at `entry` on signal bar `i`.
function exitAt(sig, hourAll, i, entry, rules, bot) {
  const rule = resolveTemplate(rules.strategy)?.rule ?? rules.strategy;
  const stop = entry * (1 - (Number(rules.stopPct) || 3) / 100);
  const trailAct = Number(rules.trailActivationPct) || 4;
  const trailPct = Number(rules.trailPct) || 3;
  const maxHoldBars =
    Number(rules.maxHoldHours) > 0
      ? Math.round(
          (Number(rules.maxHoldHours) * 3600000) / TF_MS[rules.timeframe],
        )
      : Infinity;
  let peak = entry;
  const end = Math.min(
    sig.length - 1,
    i + (Number.isFinite(maxHoldBars) ? maxHoldBars : 200),
  );
  for (let j = i + 1; j <= end; j++) {
    const bar = sig[j];
    peak = Math.max(peak, bar.high);
    if (bar.low <= stop) return { exit: stop, reason: "stop", j };
    if (
      peak >= entry * (1 + trailAct / 100) &&
      bar.low <= peak * (1 - trailPct / 100)
    )
      return { exit: peak * (1 - trailPct / 100), reason: "trail", j };
    // Rule exit (Keeper fade / Spark RSI-neutral).
    const f = featuresAt(sig, hourAll, j, bot);
    if (exitWouldFire(rule, f, rules))
      return { exit: bar.close, reason: "rule", j };
    if (j >= i + maxHoldBars) return { exit: bar.close, reason: "max-hold", j };
  }
  return { exit: sig[end].close, reason: "end", j: end };
}

export function backtestWeighted({
  bot,
  frames,
  rules = {},
  bars = 200,
  maxTrades = 25,
} = {}) {
  const timeframe = rules.timeframe ?? "15m";
  const sig = signalBars(frames, timeframe);
  const hourAll = frames.hour ?? [];
  const weights = weightsFor(bot, rules);
  const min = scoreMinFor(bot, rules);
  const rule = resolveTemplate(rules.strategy)?.rule ?? rules.strategy;
  const cooldownMs = (Number(rules.exitCooldownHours) || 1) * 3600000;
  const warmup = Math.max(20, 15);
  const start = Math.max(warmup, sig.length - bars);
  let net = 0,
    gross = 0,
    fees = 0,
    trades = 0,
    wins = 0,
    losses = 0,
    cooldownUntil = 0;
  for (let i = start; i < sig.length - 1 && trades < maxTrades; i++) {
    if (sig[i].time < cooldownUntil) continue;
    const f = featuresAt(sig, hourAll, i, bot);
    if (!executable(f, rules)) continue;
    if (scoreCandidate(f, weights) < min) continue;
    // Never enter a position the rule exit would close immediately (4.0.2).
    if (exitWouldFire(rule, f, rules)) continue;
    const entry = sig[i].close;
    const { exit, reason, j } = exitAt(sig, hourAll, i, entry, rules, bot);
    // A stop or a rule exit puts the product in a cooldown mirroring the live
    // engine, so the backtest cannot reward churn (4.0.2).
    if (reason === "stop" || reason === "rule")
      cooldownUntil = sig[j].time + cooldownMs;
    const g = (exit / entry - 1) * 100;
    const fee = TAKER * 200;
    net += g - fee;
    gross += g;
    fees += fee;
    trades++;
    if (g - fee > 0) wins++;
    else losses++;
  }
  return {
    bot,
    trades,
    wins,
    losses,
    gross: Number(gross.toFixed(3)),
    fees: Number(fees.toFixed(3)),
    net: Number(net.toFixed(3)),
  };
}
