// Deterministic portfolio backtest for the weighted model (4.0.5).
//
// Simulates the BOT, not a single product: one shared capital, at most
// `maxPositions` open at once, one position per product, the live entry gate
// (score >= scoreMin, executable, exitWouldFire false), the live cooldown on
// stop/rule exits, and the bot's own exits (percentage stop, trailing stop,
// max-hold, and the rule exit). Net P&L is returned as a percentage of the
// starting capital, so the numbers mean something. It is a SIMULATION over
// closed bars (bid/ask approximated by the bar close) and is bounded. No
// orders, no models.
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

const TAKER = 0.006; // fee per side, like the live taker tier
const TF_MS = { "5m": 300000, "15m": 900000, "1h": 3600000 };

function signalBars(frames, timeframe) {
  if (timeframe === "5m") return frames.five ?? [];
  if (timeframe === "1h") return frames.hour ?? [];
  return aggregate(frames.five ?? [], 900);
}

// The feature snapshot at signal bar i, mirroring what evaluate() provides.
function featuresAt(sig, hourAll, i) {
  const bar = sig[i];
  const closes = sig.slice(0, i + 1).map((x) => x.close);
  const priorHigh = sig.slice(Math.max(0, i - 24), i).map((x) => x.high);
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
  if (priorHigh.length) {
    f.channelHigh = Math.max(...priorHigh);
    f.channelLow = Math.min(...priorLow);
  }
  f.stopPrice = f.atr > 0 ? bar.close - 2 * f.atr : bar.close;
  f.maxEntry = bar.close + 0.5 * f.atr;
  return f;
}

export function backtestWeighted({
  bot,
  frameSets = [],
  rules = {},
  initialCapital = 100,
  maxProducts = 60,
  maxBars = 200,
} = {}) {
  const timeframe = rules.timeframe ?? "15m";
  const rule = resolveTemplate(rules.strategy)?.rule ?? rules.strategy;
  const weights = weightsFor(bot, rules);
  const min = scoreMinFor(bot, rules);
  const maxPos = Number(rules.maxPositions) || 3;
  const stopPct = Number(rules.stopPct) || 3;
  const trailAct = Number(rules.trailActivationPct) || 4;
  const trailPct = Number(rules.trailPct) || 3;
  const riskPct = Number(rules.riskPct) || 0.5;
  const tradeFrac = Number(rules.tradeFraction) || 0.9;
  const maxHoldMs =
    Number(rules.maxHoldHours) > 0 ? Number(rules.maxHoldHours) * 3600000 : 0;
  const cooldownMs = (Number(rules.exitCooldownHours) || 1) * 3600000;

  // Build each product's signal series and flatten the events on a shared clock.
  const series = [];
  for (const fs of frameSets.slice(0, maxProducts)) {
    const sig = signalBars(fs.frames ?? fs, timeframe);
    if (sig.length < 40) continue;
    series.push({
      product: fs.product ?? "?",
      sig,
      hourAll: (fs.frames ?? fs).hour ?? [],
      start: Math.max(30, sig.length - maxBars),
    });
  }
  const events = [];
  for (const s of series)
    for (let i = s.start; i < s.sig.length - 1; i++)
      events.push({ s, i, t: s.sig[i].time });
  events.sort((a, b) => a.t - b.t);

  let cash = initialCapital,
    trades = 0,
    wins = 0,
    losses = 0;
  const positions = new Map(); // product -> { qty, entry, stop, peak, openedT }
  const cooldown = new Map();

  const close = (product, price, openedT) => {
    const pos = positions.get(product);
    positions.delete(product);
    const proceeds = pos.qty * price;
    cash += proceeds - proceeds * TAKER;
    const pnl =
      proceeds - pos.qty * pos.entry - proceeds * TAKER - pos.entryFee;
    trades++;
    if (pnl > 0) wins++;
    else losses++;
    return openedT;
  };

  for (const { s, i, t } of events) {
    const bar = s.sig[i];
    const pos = positions.get(s.product);
    if (pos) {
      pos.peak = Math.max(pos.peak, bar.high);
      let exit = null,
        reason = null;
      if (bar.low <= pos.stop) {
        exit = pos.stop;
        reason = "stop";
      } else if (
        pos.peak >= pos.entry * (1 + trailAct / 100) &&
        bar.low <= pos.peak * (1 - trailPct / 100)
      ) {
        exit = pos.peak * (1 - trailPct / 100);
        reason = "trail";
      } else {
        const f = featuresAt(s.sig, s.hourAll, i);
        if (exitWouldFire(rule, f, rules)) {
          exit = bar.close;
          reason = "rule";
        } else if (maxHoldMs && t - pos.openedT >= maxHoldMs) {
          exit = bar.close;
          reason = "max-hold";
        }
      }
      if (exit != null) {
        close(s.product, exit, pos.openedT);
        if (reason === "stop" || reason === "rule")
          cooldown.set(s.product, t + cooldownMs);
      }
      continue;
    }
    if (positions.size >= maxPos) continue;
    const until = cooldown.get(s.product);
    if (until && t < until) continue;
    const f = featuresAt(s.sig, s.hourAll, i);
    if (!executable(f, rules)) continue;
    if (exitWouldFire(rule, f, rules)) continue;
    if (scoreCandidate(f, weights) < min) continue;
    const price = bar.close;
    if (!(price > 0)) continue;
    // Risk-based notional, capped so several positions fit (like the live book).
    const notional = Math.min(
      cash * tradeFrac,
      (cash * (riskPct / 100)) / (stopPct / 100),
    );
    const entryFee = notional * TAKER;
    if (notional + entryFee > cash || notional <= 0) continue;
    const qty = notional / price;
    cash -= notional + entryFee;
    positions.set(s.product, {
      qty,
      entry: price,
      entryFee,
      stop: price * (1 - stopPct / 100),
      peak: price,
      openedT: t,
    });
  }
  // Mark open positions to their last close.
  for (const [product, pos] of positions) {
    const s = series.find((x) => x.product === product);
    const price = s?.sig?.at(-1)?.close ?? pos.entry;
    close(product, price, pos.openedT);
  }

  return {
    bot,
    trades,
    wins,
    losses,
    capitalEnd: Number(cash.toFixed(3)),
    net: Number(((cash / initialCapital - 1) * 100).toFixed(3)),
  };
}
