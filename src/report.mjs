// Per-exit-reason P&L report (3.10.0).
//
// The evidence layer the experiments are judged on: reconstruct each bot's
// closed round trips from the order ledger, separate GROSS from FEES from NET,
// and report average winner / average loser, profit factor, count and net by
// exit reason, MFE/MAE, holding time, turnover and drawdown - per bot and per
// config version (rulesHash).
//
// Run with `npm run report [dbPath]` (defaults to $BEEBOTS_DB, then
// /var/lib/beebots/beebots.sqlite). Read-only; it never touches the ledger.
import { DatabaseSync } from "node:sqlite";
import { dec } from "./decimal.mjs";

const NANO = 1e18;
const usd = (b) => Number(b) / NANO;

// Collapse a free-text exit reason into a stable group, keeping the raw text too.
export function exitGroup(reason) {
  const s = String(reason ?? "unknown");
  if (/protective stop/i.test(s)) return "stop";
  if (/trailing/i.test(s)) return "trail";
  if (/maximum holding time/i.test(s)) return "max-hold";
  if (/momentum faded/i.test(s)) return "momentum-fade";
  if (/volume dropped/i.test(s)) return "volume-drop";
  if (/rsi returned/i.test(s)) return "rsi-neutral";
  if (/breakout failed/i.test(s)) return "breakout-failed";
  if (/momentum deteriorated/i.test(s)) return "momentum-deteriorated";
  if (/chose sell/i.test(s)) return "decider-sell";
  // Legacy rule sells stored the whole rationale as the reason; collapse them.
  return s.length > 32 ? "other" : s;
}

// Walk the ledger FIFO/average-cost style and reconstruct closed round trips.
export function roundTrips(orders) {
  const open = new Map();
  const trips = [];
  const list = Object.values(orders ?? {}).sort(
    (a, b) => a.created - b.created,
  );
  for (const o of list) {
    const q = dec(o.filled || "0");
    if (q <= 0n) continue;
    const key = o.bot + ":" + o.product;
    const value = dec(o.value || "0"),
      fees = dec(o.fees || "0");
    if (o.side === "BUY") {
      let p = open.get(key);
      if (!p || p.qty === 0n)
        p = {
          qty: 0n,
          cost: 0n,
          buyFees: 0n,
          opened: o.created,
          rulesHash: o.rulesHash ?? null,
          exitRules: o.exitRules ?? null,
        };
      p.qty += q;
      p.cost += value;
      p.buyFees += fees;
      if (!p.rulesHash && o.rulesHash) p.rulesHash = o.rulesHash;
      open.set(key, p);
    } else if (o.side === "SELL") {
      const p = open.get(key);
      if (!p || p.qty < q) continue;
      const basisValue = (p.cost * q) / p.qty;
      const basisFees = (p.buyFees * q) / p.qty;
      const feeUsd = usd(basisFees + fees);
      const gross = usd(value - basisValue);
      const net = gross - feeUsd;
      const entry = Number(basisValue) / Number(q);
      const exit = Number(value) / Number(q);
      const peak = o.exitPeak != null ? Number(o.exitPeak) : null;
      const trough = o.exitTrough != null ? Number(o.exitTrough) : null;
      trips.push({
        bot: o.bot,
        product: o.product,
        opened: p.opened,
        closed: o.created,
        hours: Math.max(0, (o.created - p.opened) / 3600000),
        entry,
        exit,
        gross,
        fees: feeUsd,
        net,
        reason: exitGroup(o.reason),
        rawReason: o.reason ?? null,
        rulesHash: p.rulesHash,
        exitRule: p.exitRules?.rule ?? null,
        mfePct:
          peak != null && entry > 0 ? ((peak - entry) / entry) * 100 : null,
        maePct:
          trough != null && entry > 0 ? ((trough - entry) / entry) * 100 : null,
      });
      p.qty -= q;
      p.cost -= basisValue;
      p.buyFees -= basisFees;
      open.set(key, p);
    }
  }
  return trips;
}

function maxDrawdownPct(series) {
  let peak = -Infinity,
    maxDd = 0;
  for (const v of series) {
    if (v > peak) peak = v;
    if (peak > 0) maxDd = Math.max(maxDd, (1 - v / peak) * 100);
  }
  return maxDd;
}

function summarise(trips) {
  const net = (t) => t.net;
  const wins = trips.filter((t) => t.net > 0);
  const losses = trips.filter((t) => t.net < 0);
  const grossWin = wins.reduce((n, t) => n + t.gross, 0);
  const grossLoss = losses.reduce((n, t) => n + t.gross, 0);
  const mfe = trips.map((t) => t.mfePct).filter((x) => x != null);
  const mae = trips.map((t) => t.maePct).filter((x) => x != null);
  const avg = (xs) =>
    xs.length ? xs.reduce((n, x) => n + x, 0) / xs.length : null;
  return {
    trades: trips.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trips.length ? (wins.length / trips.length) * 100 : null,
    gross: trips.reduce((n, t) => n + t.gross, 0),
    fees: trips.reduce((n, t) => n + t.fees, 0),
    net: trips.reduce((n, t) => n + net(t), 0),
    avgWin: avg(wins.map((t) => t.net)),
    avgLoss: avg(losses.map((t) => t.net)),
    profitFactor:
      grossLoss < 0
        ? grossWin / Math.abs(grossLoss)
        : grossWin > 0
          ? Infinity
          : null,
    avgMfe: avg(mfe),
    avgMae: avg(mae),
    avgHours: avg(trips.map((t) => t.hours)),
    turnover: trips.reduce((n, t) => n + t.entry * t.qty + t.exit * t.qty, 0),
    byReason: group(trips, (t) => t.reason),
    byStrategyVersion: group(trips, (t) => t.rulesHash ?? "unknown"),
  };
}

function group(trips, keyFn) {
  const m = new Map();
  for (const t of trips) {
    const k = keyFn(t);
    const g = m.get(k) ?? {
      key: k,
      trades: 0,
      wins: 0,
      net: 0,
      gross: 0,
      fees: 0,
    };
    g.trades++;
    if (t.net > 0) g.wins++;
    g.net += t.net;
    g.gross += t.gross;
    g.fees += t.fees;
    m.set(k, g);
  }
  return [...m.values()].sort((a, b) => b.net - a.net);
}

export function buildReport({
  orders = {},
  equity = [],
  capitalById = {},
} = {}) {
  const trips = roundTrips(orders);
  const bots = [...new Set(trips.map((t) => t.bot))];
  const perBot = {};
  for (const bot of bots) {
    const list = trips.filter((t) => t.bot === bot);
    const eq = equity.filter((e) => e.bot === bot).map((e) => e.equity);
    const capital = Number(capitalById[bot]) || 100;
    perBot[bot] = {
      ...summarise(list),
      capital,
      netPct: (summarise(list).net / capital) * 100,
      maxDrawdownPct: eq.length ? maxDrawdownPct(eq) : null,
    };
  }
  return {
    overall: summarise(trips),
    perBot,
    generatedAt: Date.now(),
  };
}

export function loadState(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare("SELECT body FROM state WHERE id=1").get();
    const state = JSON.parse(row.body);
    const equity = db
      .prepare("SELECT ts, bot, equity FROM equity ORDER BY ts")
      .all();
    return { state, equity };
  } finally {
    db.close();
  }
}

const pct = (v) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`);
const num = (v, d = 2) =>
  v == null || !Number.isFinite(v) ? "—" : v.toFixed(d);

export function formatReport(report) {
  const L = [];
  L.push(
    `BeeBots per-exit P&L report  (${new Date(report.generatedAt).toISOString()})`,
  );
  L.push("");
  const rows = Object.entries(report.perBot);
  const header = [
    "bot".padEnd(10),
    "trades".padStart(6),
    "win%".padStart(6),
    "gross".padStart(9),
    "fees".padStart(8),
    "net".padStart(9),
    "net%".padStart(7),
    "PF".padStart(6),
    "avgW".padStart(7),
    "avgL".padStart(7),
    "MFE%".padStart(7),
    "MAE%".padStart(7),
    "DD%".padStart(6),
  ].join(" ");
  L.push(header);
  for (const [bot, b] of rows) {
    L.push(
      [
        bot.padEnd(10),
        String(b.trades).padStart(6),
        num(b.winRate, 1).padStart(6),
        num(b.gross).padStart(9),
        num(b.fees).padStart(8),
        num(b.net).padStart(9),
        pct(b.netPct).padStart(7),
        num(b.profitFactor).padStart(6),
        num(b.avgWin).padStart(7),
        num(b.avgLoss).padStart(7),
        num(b.avgMfe).padStart(7),
        num(b.avgMae).padStart(7),
        num(b.maxDrawdownPct, 1).padStart(6),
      ].join(" "),
    );
  }
  const o = report.overall;
  L.push(
    [
      "ALL".padEnd(10),
      String(o.trades).padStart(6),
      num(o.winRate, 1).padStart(6),
      num(o.gross).padStart(9),
      num(o.fees).padStart(8),
      num(o.net).padStart(9),
      "".padStart(7),
      num(o.profitFactor).padStart(6),
      num(o.avgWin).padStart(7),
      num(o.avgLoss).padStart(7),
      num(o.avgMfe).padStart(7),
      num(o.avgMae).padStart(7),
      "".padStart(6),
    ].join(" "),
  );
  for (const [bot, b] of rows) {
    L.push("");
    L.push(`-- ${bot}: by exit reason --`);
    for (const r of b.byReason)
      L.push(
        `   ${String(r.key).padEnd(22)} n=${String(r.trades).padStart(3)} wins=${String(
          r.wins,
        ).padStart(
          3,
        )} net=${num(r.net).padStart(9)} gross=${num(r.gross).padStart(9)} fees=${num(r.fees).padStart(7)}`,
      );
    L.push(`-- ${bot}: by config version --`);
    for (const r of b.byStrategyVersion)
      L.push(
        `   ${String(r.key).slice(0, 12).padEnd(14)} n=${String(r.trades).padStart(3)} net=${num(r.net).padStart(9)}`,
      );
  }
  return L.join("\n");
}

function main() {
  const dbPath =
    process.argv[2] ||
    process.env.BEEBOTS_DB ||
    "/var/lib/beebots/beebots.sqlite";
  const { state, equity } = loadState(dbPath);
  const capitalById = Object.fromEntries(
    Object.entries(state.bots ?? {}).map(([id, b]) => [id, b.capital]),
  );
  const report = buildReport({
    orders: state.orders ?? {},
    equity,
    capitalById,
  });
  process.stdout.write(formatReport(report) + "\n");
}

if (import.meta.url === `file://${process.argv[1]}`) main();
