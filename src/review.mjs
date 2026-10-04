// Trade Review — hourly self-assessment of the bots and Laya.
//
// DO NOT BREAK THE PIPELINE. Read SYSTEM.md before changing this file.
//
// The review is two stages:
//
//   Stage 1 — LAYA REVIEWS THE HOUR. Laya reads the previous hour as text and
//   answers a set of classified heads (this.reviewQuestions()). This always
//   runs; it is local and free.
//
//   Stage 2 — THE LLM REVIEWS LAYA'S REVIEW. The decision model is handed ONLY
//   Laya's answers (never the raw hour) plus the scoreboard, the applied-change
//   ledger, the current value of every editable target, and the allowed ranges.
//   It may change Laya's rubric, Laya's question sets, and the bots' numeric
//   strategy (gates, cadence, candidate cap, timeframe, universe) and the
//   runtime knobs.
//
// Stage 2 is independent of the decision engine. Turning the LLM OFF for the
// decision stream (engine = laya) MUST NEVER stop the LLM from reviewing the
// review; that is what the dedicated "LLM review" toggle is for (settings
// review.llm, default on). Laya's bounded self-tune runs only when that toggle
// is OFF (no LLM at all). A *failed* LLM review is NOT replaced by self-tune: it
// is recorded as an error and the last good review stays on the card. The
// dashboard always renders Laya's Stage 1 review.
//
// The LLM's reply must fit the model's output cap (deepseek-flash: 8192 tokens).
// That is why the proposal contract carries only `proposed` — the server fills
// `current` from the target file for display — and why proposals/observations
// are capped, and why the current targets are sent as compact JSON. Do not add
// `current` back to the requested output: echoing a full 4 KB question set back
// and forth is what truncates the reply.
//
// The objective is to increase each bot's realised P&L (equity). The control arm
// (Dice) is still traded and shown as a reference, but the review is NOT asked to
// compare against it or to "beat" it. Proposals are applied automatically within
// hard numeric bounds, and a change that is losing money is auto-reverted.
// Everything applied lives as an override under the data directory.
import {
  existsSync,
  writeFileSync,
  readFileSync,
  renameSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { dec } from "./decimal.mjs";
import { usageCounts, costOf } from "./providers.mjs";
import {
  defaults as STRATEGY_DEFAULTS,
  STRATEGY_RULES,
  getTemplates,
  setTemplates,
} from "./strategy-v2.mjs";
import { selfTune } from "./self-tune.mjs";
import { VARIANT_NAMES } from "./analysis-variants.mjs";
import {
  ALLOWED_TARGETS,
  targetAllowed,
  overridePath,
  readOverride,
  readJsonOverride,
  validateOverride,
  validateParams,
  validatePolicy,
  PARAM_KEYS,
  PARAM_SCHEMA,
  RUNTIME_KEYS,
  RUNTIME_SCHEMA,
  PINNED_STRATEGY_BOTS,
} from "./overrides.mjs";

export { ALLOWED_TARGETS, targetAllowed };

// Minimum closed round-trips before an EDGE change may be applied. Raised to 25
// in 3.6.0: changes are now made once a day, so each one must rest on a real
// sample rather than an hourly handful.
export const MIN_SAMPLE = 25;
// Relative expectancy improvement required over the control arm.
export const MIN_MARGIN = 0.1;
// Hours a proposal must hold in shadow before promotion.
export const SHADOW_HOURS = 24;

export const STRATEGY_ARMS = ["breakout", "trend", "momentum"];
export const CONTROL_ARM = "control";

// A structural change edits only what the review asks itself; it cannot reach
// trading. Everything else is an edge change and is sample-gated.
export function tierOf(target) {
  return target === "laya.reviewQuestions" ? "structural" : "edge";
}

// The heads Laya answers over the hour. `exit_timing` deliberately offers
// insufficient_evidence so a hold with no trigger is not forced into a label.
export const REVIEW_QUESTIONS = {
  missed_opportunity: {
    type: "noul",
    instructions:
      "Read the hour's trading log. Were there eligible setups the bots passed " +
      "on that, judged only from the evidence shown, look like genuine missed " +
      "opportunities rather than correctly-declined weak setups?",
  },
  exit_timing: {
    type: "choice",
    instructions:
      "Classify how the hour's position exits were timed, judged only from the " +
      "evidence shown. Choose no_exit_event when no SELL trigger, stop touch, " +
      "trail activation or elapsed max hold occurred; a hold with no trigger is " +
      "not evidence about exit timing.",
    criteria: {
      early: "Closed before the thesis had a chance to resolve",
      late: "Held past the point the evidence had turned",
      appropriate: "Exits matched the evidence available at the time",
      no_exit_event: "No exit-relevant event occurred this hour",
      insufficient_evidence: "Too little evidence to judge",
    },
  },
  failing_rubric: {
    type: "choice",
    instructions:
      "Which single instruction set most likely contributed to poor outcomes " +
      "this hour, if any? Judge from the decisions and their stated rationales.",
    criteria: {
      breakout: "Scout's breakout rules",
      trend: "Keeper's trend rules",
      momentum: "Spark's momentum rules",
      control: "The control arm",
      laya: "Laya's classifications were the weak link",
      none: "No rubric is implicated",
    },
  },
  evidence_quality: {
    type: "score",
    instructions:
      "Score the quality of the evidence available this hour: were the inputs " +
      "complete and consistent enough to support the decisions made?",
    criteria: ["poor", "mixed", "good", "strong"],
  },
  laya_value: {
    type: "choice",
    instructions:
      "Did Laya's classifications add usable information this hour, judged " +
      "against the outcomes shown? Choose insufficient when no trade resolved.",
    criteria: {
      helpful: "Laya's labels tracked the outcomes",
      neutral: "Laya added little either way",
      misleading: "Laya's labels pointed away from the outcomes",
      insufficient: "Too few resolved outcomes to judge",
    },
  },
  breakout_quality: {
    type: "score",
    instructions:
      "Score the quality of Scout's breakout decisions this hour - were eligible " +
      "setups taken, weak setups declined, and losses avoidable?",
    criteria: ["poor", "weak", "fair", "good"],
  },
  trend_quality: {
    type: "score",
    instructions:
      "Score the quality of Keeper's trend decisions this hour - entries, exits " +
      "and whether it held winners or cut them early.",
    criteria: ["poor", "weak", "fair", "good"],
  },
  momentum_quality: {
    type: "score",
    instructions:
      "Score the quality of Spark's momentum decisions this hour - candidate " +
      "selection, entries and exits.",
    criteria: ["poor", "weak", "fair", "good"],
  },
  laya_question_coverage: {
    type: "choice",
    instructions:
      "Are the analysis questions Laya was asked this hour (regime/fit/quality) " +
      "pitched at the right strictness for this market?",
    criteria: {
      too_strict: "Pitched too strict: good setups were classified weak",
      balanced: "About right",
      too_loose: "Pitched too loose: weak setups were classified strong",
      insufficient_evidence: "Too little evidence to judge",
    },
  },
  laya_evidence_focus: {
    type: "choice",
    instructions:
      "Which evidence would most improve Laya's classifications for this system?",
    criteria: {
      trend: "Trend structure (EMAs, higher highs/lows)",
      momentum: "Relative strength and momentum persistence",
      volatility: "Volatility and range compression",
      volume: "Volume and participation",
      quality: "Data completeness and consistency",
      none: "No change needed",
    },
  },
  primary_bottleneck: {
    type: "choice",
    instructions:
      "What single thing most limited results this hour? Judge against each " +
      "bot's own realised P&L and win/loss.",
    criteria: {
      breakout: "Scout's breakout rules",
      trend: "Keeper's trend rules",
      momentum: "Spark's momentum rules",
      control: "The control arm needs no tuning",
      laya: "Laya's classifications",
      risk: "Risk/sizing or execution refusals",
      none: "Nothing material",
    },
  },
};

// Phrases every rubric must retain. A proposal that drops any of them is
// rejected outright - otherwise an LLM can strip a safety instruction while
// looking "better".
export const PROTECTED_INVARIANTS = [
  /no shorts/i,
  /uncalibrated/i,
  /code (controls|determines)/i,
  /do not (alter|replace|change).*stop/i,
  /(never|do not) force/i,
];

export function protectedInvariantsHold(text) {
  if (typeof text !== "string" || !text.trim()) return false;
  return PROTECTED_INVARIANTS.every((re) => re.test(text));
}

// Closed round-trips per bot, reconstructed from the orders ledger exactly as
// performance.mjs does. Used as the sample count for the gate.
export function closedTrades(orders) {
  return Object.fromEntries(
    Object.entries(closedRoundTrips(orders)).map(([bot, trips]) => [
      bot,
      trips.length,
    ]),
  );
}

// Full round-trips with their product, open time and realised P&L, so Laya's
// labels can be joined to outcomes.
export function closedRoundTrips(orders) {
  const positions = new Map(),
    trips = {};
  for (const o of Object.values(orders).sort((a, b) => a.created - b.created)) {
    const q = dec(o.filled || "0");
    if (q <= 0n) continue;
    const key = o.bot + ":" + o.product;
    const p = positions.get(key) || {
      quantity: 0n,
      cost: 0n,
      opened: o.created,
    };
    const value = dec(o.value || "0"),
      fees = dec(o.fees || "0");
    if (o.side === "BUY") {
      if (p.quantity === 0n) p.opened = o.created;
      p.quantity += q;
      p.cost += value + fees;
      positions.set(key, p);
    } else if (o.side === "SELL") {
      if (p.quantity < q) continue;
      const basis = (p.cost * q) / p.quantity;
      const pnl = value - fees - basis;
      (trips[o.bot] ??= []).push({
        bot: o.bot,
        product: o.product,
        opened: p.opened,
        closed: o.created,
        pnl,
        // Cost basis and the closing reason, so a caller can compute the P&L %
        // and say why the trade was closed.
        cost: basis,
        reason: o.reason ?? null,
      });
      p.quantity -= q;
      p.cost -= basis;
      positions.set(key, p);
    }
  }
  return trips;
}

// Trailing consecutive-loss streak per strategy arm: walk back from the most
// recent closed round trip until a win. A streak of 5 triggers a focused review.
export function losingStreaks(orders) {
  const trips = closedRoundTrips(orders);
  const out = {};
  for (const arm of STRATEGY_ARMS) {
    const list = (trips[arm] ?? []).slice().sort((a, b) => a.closed - b.closed);
    let n = 0;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].pnl < 0n) n++;
      else break;
    }
    out[arm] = n;
  }
  return out;
}

const fitBucket = (fit) =>
  !Number.isFinite(fit)
    ? "unmatched"
    : fit < 1
      ? "low"
      : fit <= 1.5
        ? "mid"
        : "high";

// Evaluate Laya against reality over the window: how its labels distribute, and
// whether the fit it assigned before an entry tracked the trade's outcome.
// The trade-to-analysis join is approximate: it uses the most recent analysis
// for the same product before the position opened.
export function layaPerformance({ events, orders, since = 0 }) {
  const analyses = events.filter((e) => e.kind === "analysis" && e.ts >= since);
  const regime = {},
    quality = {},
    fit = {
      low: { n: 0, wins: 0, pnl: 0 },
      mid: { n: 0, wins: 0, pnl: 0 },
      high: { n: 0, wins: 0, pnl: 0 },
    };
  for (const a of analyses) {
    const r = a.answers?.regime?.choice;
    const q = a.answers?.quality?.choice;
    if (r) regime[r] = (regime[r] ?? 0) + 1;
    if (q) quality[q] = (quality[q] ?? 0) + 1;
  }
  const byProduct = new Map();
  for (const a of analyses) {
    const list = byProduct.get(a.product) ?? [];
    list.push(a);
    byProduct.set(a.product, list);
  }
  const trips = Object.values(closedRoundTrips(orders)).flat();
  let matched = 0;
  for (const t of trips) {
    const list = (byProduct.get(t.product) ?? []).filter(
      (a) => a.ts <= t.opened,
    );
    if (!list.length) continue;
    const latest = list.at(-1);
    const b = fitBucket(Number(latest.answers?.fit?.score));
    if (b === "unmatched") continue;
    matched++;
    fit[b].n++;
    if (t.pnl > 0n) fit[b].wins++;
    fit[b].pnl += Number(t.pnl) / 1e18;
  }
  return {
    regime,
    quality,
    fit,
    analyses: analyses.length,
    trips: trips.length,
    matched,
  };
}

function perfLines(p) {
  const out = [];
  const dist = (o) =>
    Object.entries(o)
      .map(([k, v]) => `${k}:${v}`)
      .join(" ") || "none";
  out.push(
    `LAYA PERFORMANCE — ${p.analyses} labels, ${p.trips} closed trips, ${p.matched} joined`,
  );
  out.push(`- regime: ${dist(p.regime)}`);
  out.push(`- quality: ${dist(p.quality)}`);
  for (const b of ["low", "mid", "high"]) {
    const x = p.fit[b];
    if (!x.n) continue;
    out.push(
      `- entry fit ${b}: n=${x.n} wins=${x.wins} winRate=${((x.wins / x.n) * 100).toFixed(0)}% pnl=${x.pnl.toFixed(2)}`,
    );
  }
  return out;
}

// Per-arm realised P&L and win/loss. The control arm (Dice) is shown for
// reference only - the review is not told to beat it.
export function scoreboardLines(orders) {
  const trips = closedRoundTrips(orders);
  const bots = [...STRATEGY_ARMS, CONTROL_ARM];
  const row = (bot) => {
    const list = trips[bot] ?? [];
    const pnl = list.reduce((n, t) => n + Number(t.pnl) / 1e18, 0);
    const wins = list.filter((t) => t.pnl > 0n).length;
    return { bot, n: list.length, wins, loss: list.length - wins, pnl };
  };
  const out = ["SCOREBOARD (realised P&L, all-time)"];
  for (const r of bots.map(row))
    out.push(
      `- ${r.bot}: ${r.n} trades ${r.wins}W/${r.loss}L pnl=${r.pnl.toFixed(2)}`,
    );
  return out;
}

// Cap the verbatim lines the review feeds Laya and the model. A 5-minute cadence
// across three bots with 25 candidates each writes ~900 analysis events an hour;
// listing them all overflowed Laya's context and timed the model out, so the
// hour is aggregated and sampled.
const MAX_DECISION_LINES = 200;
const MAX_ANALYSIS_LINES = 120;
const MAX_SHORTLIST = 5;

export function buildHourState({ events, orders, coverage, since, until }) {
  const lines = [];
  const inWindow = (e) => e.ts >= since && e.ts < until;
  const decisions = events.filter((e) => e.kind === "decision" && inWindow(e));
  const analyses = events.filter((e) => e.kind === "analysis" && inWindow(e));
  lines.push(
    `HOUR ${new Date(since).toISOString()} to ${new Date(until).toISOString()}`,
  );
  lines.push(`DECISIONS (${decisions.length})`);
  for (const e of decisions.slice(0, MAX_DECISION_LINES))
    lines.push(
      `- ${e.bot} ${e.action}${e.product ? " " + e.product : ""}: ${String(e.reason ?? "").slice(0, 300)}`,
    );
  if (decisions.length > MAX_DECISION_LINES)
    lines.push(`(+${decisions.length - MAX_DECISION_LINES} more decisions)`);
  lines.push(`LAYA LABELS (${analyses.length})`);
  // Aggregate per bot, then a bounded sample of raw lines.
  const agg = new Map();
  for (const e of analyses) {
    let b = agg.get(e.bot);
    if (!b) {
      b = { regime: {}, quality: {}, fit: {} };
      agg.set(e.bot, b);
    }
    const r = e.answers?.regime?.choice;
    if (r) b.regime[r] = (b.regime[r] ?? 0) + 1;
    const q = e.answers?.quality?.choice;
    if (q) b.quality[q] = (b.quality[q] ?? 0) + 1;
    const f = Number(e.answers?.fit?.score);
    if (Number.isFinite(f)) {
      const k = f < 1 ? "low" : f <= 1.5 ? "mid" : "high";
      b.fit[k] = (b.fit[k] ?? 0) + 1;
    }
  }
  const dist = (o) =>
    Object.entries(o)
      .map(([k, v]) => `${k}:${v}`)
      .join(" ") || "none";
  for (const [bot, a] of agg)
    lines.push(
      `- ${bot}: regime ${dist(a.regime)}; quality ${dist(a.quality)}; fit ${dist(a.fit)}`,
    );
  for (const e of analyses.slice(0, MAX_ANALYSIS_LINES))
    lines.push(
      `- ${e.bot} ${e.product}: regime=${e.answers?.regime?.choice} fit=${e.answers?.fit?.score} quality=${e.answers?.quality?.choice}`,
    );
  if (analyses.length > MAX_ANALYSIS_LINES)
    lines.push(`(+${analyses.length - MAX_ANALYSIS_LINES} more labels)`);
  if (coverage) {
    lines.push("ELIGIBLE SETUPS / REJECTIONS");
    lines.push(
      `- discovered ${coverage.total ?? "?"}, eligible ${coverage.eligible ?? "?"}, ready ${coverage.ready ?? "?"}, scout universe ${coverage.scout ?? "?"}`,
    );
    for (const [bot, b] of Object.entries(coverage.bots ?? {}))
      lines.push(
        `- ${bot}: evaluated ${b.evaluated}, eligible ${b.eligible}; ${(
          b.shortlist ?? []
        )
          .slice(0, MAX_SHORTLIST)
          .map(
            (f) =>
              `${f.product}${f.eligible ? " (eligible)" : " (" + (f.reasons || []).join(", ") + ")"}`,
          )
          .join("; ")}`,
      );
  }
  lines.push("FILLS THIS HOUR");
  for (const o of Object.values(orders))
    if (o.created >= since && o.created < until)
      lines.push(
        `- ${o.bot} ${o.side} ${o.product} filled=${o.filled} value=${o.value} fees=${o.fees} reason=${String(o.reason ?? "").slice(0, 200)}`,
      );
  lines.push(...perfLines(layaPerformance({ events, orders, since })));
  lines.push(...scoreboardLines(orders));
  return lines.join("\n");
}

const REVIEW_SYSTEM =
  "You improve an automated spot-trading system with three strategy bots and a " +
  "random control arm named Dice. Your goal is to INCREASE each bot's EQUITY. " +
  "Dice is a reference control, not the target: measure each bot against its " +
  "own realised P&L, not against Dice. Trading LESS is NOT a strategy: " +
  "tightening an entry gate so there are fewer trades does not improve " +
  "anything, and 'fewer candidates' is NOT 'better quality'. Every proposal " +
  "must keep the arm participating and raise its P&L. " +
  "You may change: a bot's written rubric, Laya's question sets, the numeric " +
  "strategy parameters, the runtime knobs, a bot's STRATEGY TEMPLATE " +
  "(`params.<bot>.strategy`, chosen from STRATEGY POOL), and the STRATEGY POOL " +
  "itself (target `strategyPool`). The pool edit is " +
  '{"target":"strategyPool","proposed":{"remove":["id"],"add":[{"id","label","rule","universe","timeframe","count"}]}} ' +
  "- delete a template that is losing, or add a NEW one by combining a coded " +
  "rule with a universe and timeframe (a template is always executable). " +
  "`maxCandidates` is " +
  "OUT OF SCOPE - never propose it. Two jobs: (1) judge each bot on its own " +
  "realised P&L and win/loss in Laya's review of the hour; (2) judge Laya " +
  "itself. You are given Laya's review, the per-arm results, the STRATEGY DUE " +
  "flags, the allowed ranges, and the current value of each target. " +
  "ROTATE A LOSER: if a bot is flagged STRATEGY DUE (it has lost money over " +
  "its last 10 closed trades), replace its strategy with a DIFFERENT one " +
  "from the pool instead of nudging the loser. Propose at most ONE change per " +
  "bot, up to two bots. For numeric targets (`params.*`, `runtime`, " +
  "`laya.analysisPolicy`) return a PATCH: only the keys you change, e.g. " +
  '{"riskPct":0.8}; the code merges it onto the current value. For ' +
  "`laya.reviewQuestions` return only the heads you change. A rubric, if you " +
  "change one, must still be the full document with its heading. Keep it " +
  "compact: a short summary (at most 600 characters), at most three " +
  "observations, a brief rationale. Numeric values must stay within the " +
  "allowed ranges; anything outside is refused. A timeframe change must cite " +
  "the TIMEFRAME COMPARISON and is refused unless the proposed timeframe's " +
  "simulated net return is at least the current one. Rubrics must retain " +
  "their safety clauses: no shorts, Laya is uncalibrated evidence not a " +
  "decision or probability, code controls size and execution, do not alter " +
  "stops, do not force trades. Capital, mode, leverage and disabling stops " +
  "are never changeable. To undo one of your own applied changes, propose " +
  "{target, revert:true, rationale} when the ledger shows it is losing money. " +
  "If nothing is worth changing, return an empty proposals list. " +
  "Return only JSON: " +
  '{"summary":"...","observations":[{"bot":"...","issue":"...","evidence":"..."}],' +
  '"proposals":[{"target":"...","proposed":"...","rationale":"...","risk":"..."}]}.';

export class TradeReview {
  constructor({ store, laya, model, config, dataDir, reviewLlm = null }) {
    this.store = store;
    this.laya = laya;
    this.model = model;
    this.config = config;
    this.dataDir = dataDir;
    this.reviewLlm = reviewLlm;
  }
  // Whether the hourly review uses the LLM, independent of the decision engine:
  // Laya may decide every trade while the LLM authors the hourly review. When
  // off, Laya self-tunes by selection.
  llmEnabled() {
    if (this.reviewLlm) return this.reviewLlm() !== false;
    return this.config?.review?.llm !== false;
  }
  // The current value of one target, for the no-LLM self-tuner to step from.
  currentValue(target) {
    if (target.startsWith("params."))
      return this.paramView(target.slice("params.".length));
    if (target === "laya.analysisPolicy") {
      const over = readJsonOverride(this.dataDir, "laya.analysisPolicy", null);
      return over && !validatePolicy(over) ? over : { variant: "balanced" };
    }
    return {};
  }
  reviewQuestions() {
    return readJsonOverride(
      this.dataDir,
      "laya.reviewQuestions",
      REVIEW_QUESTIONS,
    );
  }
  // The engine's effective rubric: an applied override, else the bundled text.
  rubric(id, fallback) {
    return readOverride(this.dataDir, `rubric.${id}`) ?? fallback;
  }
  // The numeric parameters a bot actually runs on: defaults -> config -> review.
  effectiveParams(id) {
    const base = {
      ...(STRATEGY_DEFAULTS[id] ?? {}),
      ...(this.config.bots?.[id] ?? {}),
    };
    const over = readJsonOverride(this.dataDir, `params.${id}`, null);
    if (over && !validateParams(`params.${id}`, over))
      Object.assign(base, over);
    return base;
  }
  effectiveRuntime() {
    const base = {
      cadenceMs: 300000,
      maxCandidates: 25,
      modelMaxCallsPerDay: this.config.model?.maxCallsPerDay ?? 1000,
      scoutCategories: ["meme", "speculative", "unclassified"],
      reentryLookbackBars: 24,
    };
    const over = readJsonOverride(this.dataDir, "runtime", null);
    if (over && !validateParams("runtime", over)) Object.assign(base, over);
    return base;
  }
  // Per-arm recent-close / re-entry evidence: how many positions were closed
  // inside the re-entry lookback window and their net realised P&L, so the model
  // can judge the window.
  reentryStats(orders) {
    const bars = Number(this.effectiveRuntime().reentryLookbackBars) || 24;
    const trips = closedRoundTrips(orders);
    const out = {};
    for (const arm of STRATEGY_ARMS) {
      const barMs =
        { "5m": 300000, "15m": 900000, "1h": 3600000 }[
          this.effectiveParams(arm).timeframe
        ] ?? 900000;
      const since = Date.now() - bars * barMs;
      const recent = (trips[arm] ?? []).filter((t) => t.closed >= since);
      const pnl = recent.reduce((n, t) => n + Number(t.pnl) / 1e18, 0);
      out[arm] = {
        windowBars: bars,
        closes: recent.length,
        wins: recent.filter((t) => t.pnl > 0n).length,
        losses: recent.filter((t) => t.pnl < 0n).length,
        pnl: Number(pnl.toFixed(2)),
      };
    }
    return out;
  }
  // Only the tunable keys, so the model sees the shape it may rewrite.
  paramView(id) {
    const eff = this.effectiveParams(id);
    return Object.fromEntries(
      PARAM_KEYS.filter(
        (k) =>
          eff[k] !== undefined &&
          // A pinned bot's strategy template is fixed; never offered or rewritten.
          !(k === "strategy" && PINNED_STRATEGY_BOTS.has(id)),
      ).map((k) => [k, eff[k]]),
    );
  }
  runtimeView() {
    const eff = this.effectiveRuntime();
    return Object.fromEntries(RUNTIME_KEYS.map((k) => [k, eff[k]]));
  }
  // The exact current value of one editable target, as the string the model
  // would have seen and as the dashboard shows it. Used to fill `current` on a
  // proposal the model returns without it (the model is told not to echo it).
  // The exact current value of one editable target, as a compact JSON string
  // (no pretty-printing: the review prompt is size-sensitive). Used both as the
  // value the model sees and to fill `current` on a proposal without it.
  currentFor(target) {
    if (target === "laya.reviewQuestions")
      return JSON.stringify(this.reviewQuestions());
    if (target === "runtime") return JSON.stringify(this.runtimeView());
    if (target === "laya.analysisPolicy")
      return JSON.stringify(this.currentValue("laya.analysisPolicy"));
    if (target.startsWith("params."))
      return JSON.stringify(this.paramView(target.slice("params.".length)));
    if (target.startsWith("rubric."))
      return readOverride(this.dataDir, target) ?? "";
    return "";
  }
  // Merge a model patch onto the current target value. Numeric and question
  // targets may be returned as partial objects (the code holds the rest); rubric
  // targets must be full documents and are passed through untouched.
  mergeProposal(p) {
    if (!p || p.revert === true) return p;
    const target = p.target;
    if (typeof target !== "string") return p;
    // A rubric is a full prose document; keep it a string untouched.
    if (target.startsWith("rubric."))
      return typeof p.proposed === "string"
        ? p
        : { ...p, proposed: JSON.stringify(p.proposed) };
    // The model may return `proposed` as a JSON string or an inline object (the
    // prompt shows a patch object). Accept both.
    let patch;
    if (typeof p.proposed === "string") {
      try {
        patch = JSON.parse(p.proposed);
      } catch {
        return p;
      }
    } else if (p.proposed && typeof p.proposed === "object") {
      patch = p.proposed;
    } else {
      return p;
    }
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) return p;
    let current;
    try {
      current = JSON.parse(this.currentFor(target));
    } catch {
      return p;
    }
    if (!current || typeof current !== "object" || Array.isArray(current))
      return p;
    // Always emit a JSON string: the gate/apply path requires text.
    return { ...p, proposed: JSON.stringify({ ...current, ...patch }) };
  }
  // The current value of every editable target, for the model to rewrite.
  currentTargets() {
    const out = {
      "laya.reviewQuestions": this.currentFor("laya.reviewQuestions"),
    };
    for (const id of STRATEGY_ARMS) {
      const t = readOverride(this.dataDir, `rubric.${id}`);
      if (t) out[`rubric.${id}`] = t;
    }
    for (const id of [...STRATEGY_ARMS, CONTROL_ARM])
      out[`params.${id}`] = this.currentFor(`params.${id}`);
    out.runtime = this.currentFor("runtime");
    out["laya.analysisPolicy"] = this.currentFor("laya.analysisPolicy");
    return out;
  }
  // The allowed numeric ranges, so the model proposes in-bounds values.
  schemaText() {
    const fmt = (schema, keys) =>
      keys
        .map((k) => {
          const r = schema[k];
          const en = typeof r.enum === "function" ? r.enum() : r.enum;
          return en
            ? `${k}: one of ${en.join("|")}`
            : r.list
              ? `${k}: any of ${r.list.join("|")}`
              : `${k}: ${r.min}..${r.max}${r.int ? " (int)" : ""}`;
        })
        .join("; ");
    return (
      "ALLOWED NUMERIC RANGES\nparams.<bot>: " +
      fmt(PARAM_SCHEMA, PARAM_KEYS) +
      "\nruntime: " +
      fmt(RUNTIME_SCHEMA, RUNTIME_KEYS) +
      "\nlaya.analysisPolicy.variant: one of " +
      VARIANT_NAMES.join(", ")
    );
  }
  // A change to a bot's signal timeframe is allowed only with Timeframe Lab
  // evidence. Returns a refusal reason, or null when the proposal does not touch
  // a timeframe or the evidence supports it. Deterministic, so the model cannot
  // guess a timeframe change past the gate.
  timeframeGate(proposal, lab) {
    const target = proposal?.target;
    if (typeof target !== "string" || !target.startsWith("params."))
      return null;
    let proposed;
    try {
      proposed = JSON.parse(proposal.proposed);
    } catch {
      return null;
    }
    const tf = proposed?.timeframe;
    if (typeof tf !== "string") return null;
    const arm = target.slice("params.".length);
    // The current timeframe comes from the live target value, not the lab, so a
    // params proposal that merely repeats the existing timeframe is not gated.
    let current = null;
    try {
      current = JSON.parse(this.currentFor(target))?.timeframe ?? null;
    } catch {
      current = null;
    }
    if (tf === current) return null;
    const entry = lab?.arms?.[arm];
    if (!entry)
      return `No timeframe evidence for ${arm}; cannot change timeframe`;
    const next = entry.timeframes?.[tf];
    const cur = entry.timeframes?.[current];
    const MIN = 3;
    if (!next || next.partial || next.trades < MIN)
      return `Insufficient timeframe evidence for ${arm} ${tf} (${next?.trades ?? 0} trades${next?.partial ? ", partial" : ""})`;
    if (cur && !cur.partial && cur.trades >= MIN && next.net < cur.net)
      return `Timeframe ${tf} underperforms ${current} for ${arm} (${next.net}% vs ${cur.net}%)`;
    return null;
  }
  // One hourly pass: gather the hour, let Laya classify it, let the model propose
  // changes, gate each proposal, and apply only what the evidence supports.
  async run({
    since,
    until,
    coverage,
    autoApply = true,
    timeframeLab = null,
    focusArm = null,
    focusStreak = 0,
    apply = true,
    daily = false,
    hourly = [],
  }) {
    const events = this.store
      .recent(2000)
      .filter((e) => e.ts >= since && e.ts < until);
    const s = this.store.read();
    // With no LLM, Laya's controller reverts losers before we consider new
    // proposals. With an LLM, the LLM decides reverts from the ledger below.
    if (!this.llmEnabled()) this.revertLosers(s.orders, until);
    const perf = layaPerformance({
      events: this.store.recent(5000),
      orders: s.orders,
      since,
    });
    const state = buildHourState({
      events,
      orders: s.orders,
      coverage,
      since,
      until,
    });
    let laya = null;
    try {
      laya = await this.laya.ask(
        { content: state, kind: "trade_review" },
        this.reviewQuestions(),
        this.config?.review?.timeoutMs ?? 300000,
      );
    } catch (e) {
      laya = { error: e.message };
    }
    // Hourly pass (3.6.0): collect Laya's read of the hour and store it. No LLM,
    // no self-tune, no changes - the daily pass reasons over these records.
    if (!apply) {
      const record = {
        since,
        until,
        hourly: true,
        sample: closedTrades(s.orders),
        layaPerf: perf,
        laya: laya.error
          ? { error: laya.error }
          : { answers: laya.answers, elapsed_s: laya.elapsed_s ?? null },
        error: laya.error ?? null,
      };
      this.store.change(
        (st) => {
          st.lastHourly = record;
          st.hourlyReviews = [
            ...(Array.isArray(st.hourlyReviews) ? st.hourlyReviews : []),
            record,
          ].slice(-48);
        },
        "review",
        {
          summary: "Hourly data collected",
          proposals: 0,
          applied: 0,
          error: record.error,
        },
      );
      return;
    }
    let summary = null,
      observations = [],
      proposals = [],
      error = null;
    // Laya's bounded self-tune: the no-LLM path (the review LLM toggle is off).
    // It is NOT a substitute for a failed LLM review - a failure is reported and
    // the last good review is kept on the card (see the record step below).
    const selfTuneNow = () => {
      const tuned = selfTune({
        answers: laya.answers,
        current: (t) => this.currentValue(t),
      });
      summary = tuned.length
        ? `Laya self-tune: ${tuned.length} bounded change(s)`
        : "Laya self-tune: no change needed";
      return tuned;
    };
    if (!laya.error) {
      if (this.llmEnabled()) {
        // STAGE 2. The LLM authors changes, but sees only Laya's Stage 1 verdict
        // - never the raw hour. Laya digests; the LLM decides and writes text.
        // Keep the request and the reply small: the model's output cap is what
        // truncated the reply before (see the header note).
        const user =
          "LAYA'S REVIEW\n" +
          JSON.stringify(laya.answers) +
          "\n\nSCOREBOARD\n" +
          scoreboardLines(s.orders).join("\n") +
          (daily && hourly.length
            ? "\n\nHOURLY DATA SINCE LAST APPLY (each hour's Laya read; this daily " +
              "pass is the only one that changes anything)\n" +
              JSON.stringify(
                hourly
                  .slice(-48)
                  .map((h) => h?.laya?.answers ?? { error: h?.error ?? null }),
              )
            : "") +
          "\n\nAPPLIED CHANGES (your prior edits and their effect)\n" +
          JSON.stringify(this.appliedLedger(s.orders)) +
          "\n\nSTRATEGY POOL (values for params.<bot>.strategy; delete a losing " +
          "template or add one by combining a coded rule + universe + timeframe)\n" +
          Object.keys(getTemplates()).join(", ") +
          "\nCODED RULES: " +
          Object.keys(STRATEGY_RULES).join(", ") +
          " | UNIVERSES: all, top100, top20 | TIMEFRAMES: 5m, 15m, 1h" +
          "\n\nSTRATEGY DUE (10 closed trades and losing money: replace the strategy)\n" +
          JSON.stringify(this.strategyDue(s.orders)) +
          (focusArm
            ? "\n\nFOCUS: review ONLY the " +
              focusArm +
              " bot. It has lost its last " +
              focusStreak +
              " closed trades in a row. Propose a change for " +
              focusArm +
              " only - adjust its numeric params, or replace its strategy template. Do NOT propose changes for any other bot."
            : "") +
          "\n\nRE-ENTRY CONTEXT (closes inside the reentryLookbackBars window)\n" +
          JSON.stringify(this.reentryStats(s.orders)) +
          "\n\nCURRENT TARGETS\n" +
          JSON.stringify(this.currentTargets()) +
          "\n\nTIMEFRAME COMPARISON (code-generated simulation over the candles " +
          "held; a timeframe change is REFUSED unless this supports it)\n" +
          JSON.stringify(timeframeLab) +
          "\n\n" +
          this.schemaText();
        try {
          const r = await this.model.review(
            REVIEW_SYSTEM,
            user,
            this.config?.review?.timeoutMs ?? 300000,
          );
          summary =
            typeof r.data?.summary === "string"
              ? r.data.summary.slice(0, 1200)
              : null;
          observations = Array.isArray(r.data?.observations)
            ? r.data.observations.slice(0, 4)
            : [];
          proposals = Array.isArray(r.data?.proposals)
            ? r.data.proposals
                .slice(
                  0,
                  Math.max(1, Number(this.config?.review?.maxProposals) || 1),
                )
                .map((p) => {
                  const m = this.mergeProposal(p);
                  return {
                    ...m,
                    rationale:
                      typeof m?.rationale === "string"
                        ? m.rationale.slice(0, 600)
                        : m?.rationale,
                    // The model is told not to echo `current` (it overruns the
                    // output cap). Fill it from the target file for display/audit.
                    current:
                      typeof m?.current === "string" && m.current
                        ? m.current
                        : this.currentFor(m?.target),
                  };
                })
            : [];
          try {
            this.store.recordModelCall({
              day: new Date(until).toISOString().slice(0, 10),
              provider: r.provider,
              model: r.model,
              usage: usageCounts(r.usage),
              costNanos: costOf(r.usage, r.provider, r.model, until),
            });
          } catch {
            // Budget accounting is telemetry; never fail the review over it.
          }
        } catch (e) {
          // The LLM stage failed (unconfigured, timed out, truncated, or not
          // JSON). Record the exact reason. Do NOT substitute a self-tune line
          // and do NOT overwrite the last good review; the record step keeps the
          // previous review on the card and attaches this error as a note.
          error = e.message;
        }
      } else {
        // No LLM review: Laya self-tunes - it selects a pre-authored analysis
        // variant and steps a whitelisted number by one bounded step.
        try {
          proposals = selfTuneNow();
        } catch (e) {
          error = e.message;
        }
      }
    }
    const sample = closedTrades(s.orders);
    const reviewed = proposals.map((p) => {
      // A pool edit (delete a losing template / add a new combination) is a
      // structural change: no sample gate, but it is validated hard and only the
      // daily pass reaches here.
      if (p?.target === "strategyPool") {
        const reasons = [];
        const err = this.poolError(p.proposed);
        if (err) reasons.push(err);
        let applied = false;
        if (!err && autoApply) {
          try {
            this.applyPool(p.proposed);
            applied = true;
          } catch (e) {
            reasons.push(e.message);
          }
        }
        return {
          ...p,
          gate: { ok: reasons.length === 0, reasons, tier: "structural" },
          applied,
        };
      }
      const isRevert = p?.revert === true;
      // A revert restores a prior known value, so it is not sample-gated; it
      // only has to name an allowed target.
      const gate = isRevert
        ? targetAllowed(p.target)
          ? { ok: true, reasons: [], tier: "revert" }
          : {
              ok: false,
              reasons: [`Target ${p.target} is out of scope`],
              tier: "revert",
            }
        : evaluateGate({
            proposal: p,
            sample,
            minSample: this.config?.review?.minSample,
            requireControl: this.config?.review?.requireControl,
          });
      // A change to a bot's signal timeframe is allowed only with evidence: the
      // Timeframe Lab must show the proposed timeframe is at least as good as
      // the current one. Deterministic - never the model's word.
      if (!isRevert) {
        const tfError = this.timeframeGate(p, timeframeLab);
        if (tfError) gate.reasons.push(tfError);
      }
      // A focused (losing-streak) review may only change the focused bot.
      if (focusArm) {
        const t = p?.target ?? "";
        const armOf = t.startsWith("params.")
          ? t.slice("params.".length)
          : t.startsWith("rubric.")
            ? t.slice("rubric.".length)
            : null;
        if (armOf !== focusArm)
          gate.reasons.push(`Focused review: only ${focusArm} may be changed`);
      }
      gate.ok = gate.ok && gate.reasons.length === 0;
      let applied = false;
      if (gate.ok && autoApply) {
        try {
          if (isRevert) {
            this.revert(p.target);
            this.forgetChange(p.target);
          } else {
            this.apply(p);
            this.recordChange(p);
          }
          applied = true;
        } catch (e) {
          gate.reasons.push(e.message);
        }
      }
      return { ...p, gate, applied };
    });
    const record = {
      since,
      until,
      summary,
      observations,
      proposals: reviewed,
      sample,
      layaPerf: perf,
      timeframeLab,
      strategyDue: this.strategyDue(s.orders),
      reentry: this.reentryStats(s.orders),
      focus: focusArm ? { arm: focusArm, streak: focusStreak } : null,
      daily,
      laya: laya.error
        ? { error: laya.error }
        : { answers: laya.answers, elapsed_s: laya.elapsed_s ?? null },
      error,
    };
    // Keep the last successful review so a failed attempt cannot blank the
    // card, and record the failure separately for the dashboard to show.
    const attemptError = error || laya?.error || null;
    this.store.change(
      (st) => {
        if (attemptError) {
          st.lastReviewError = { at: until, message: attemptError };
          // No prior review, or the shown one is already this failed hour:
          // show the failed record rather than an empty panel.
          if (!st.lastReview || st.lastReview.until === until)
            st.lastReview = record;
        } else {
          st.lastReview = record;
          st.lastReviewError = null;
          // Anchor the next daily window. Only the scheduled daily pass (and the
          // startup catch-up) moves it; a focused streak review does not.
          if (daily) st.lastApplyReviewAt = until;
        }
      },
      "review",
      {
        summary,
        proposals: reviewed.length,
        applied: reviewed.filter((d) => d.applied).length,
        error: attemptError,
      },
    );
    return record;
  }
  // Validate a `strategyPool` edit without side effects. Templates can only be
  // recombinations of the coded rules, so every template stays executable.
  poolError(proposed) {
    if (!proposed || typeof proposed !== "object")
      return "Pool change must be an object";
    const remove = Array.isArray(proposed.remove) ? proposed.remove : [];
    const add = Array.isArray(proposed.add) ? proposed.add : [];
    if (!remove.length && !add.length) return "Pool change is empty";
    const current = getTemplates();
    for (const id of remove)
      if (!current[id]) return `Cannot remove unknown template ${id}`;
    const remaining = Object.keys(current).filter((id) => !remove.includes(id));
    if (!remaining.length) return "Cannot remove every template";
    for (const t of add) {
      if (!t || typeof t.id !== "string" || !t.id)
        return "New template needs an id";
      if (!STRATEGY_RULES[t.rule]) return `Unknown rule ${t.rule}`;
      if (!["all", "top100", "top20"].includes(t.universe))
        return `Unknown universe ${t.universe}`;
      if (!["5m", "15m", "1h"].includes(t.timeframe))
        return `Unknown timeframe ${t.timeframe}`;
    }
    return null;
  }
  // Apply a validated pool edit: delete templates, add recombination templates,
  // persist the pool in state and make it live for evaluate()/the collector.
  applyPool(proposed) {
    const err = this.poolError(proposed);
    if (err) throw Error(err);
    const current = { ...getTemplates() };
    for (const id of proposed.remove ?? []) delete current[id];
    for (const t of proposed.add ?? [])
      current[t.id] = {
        label:
          typeof t.label === "string" && t.label ? t.label.slice(0, 80) : t.id,
        rule: t.rule,
        universe: t.universe,
        timeframe: t.timeframe,
        count: Math.min(10, Math.max(1, Number(t.count) || 3)),
      };
    this.store.change(
      (st) => {
        st.strategyPool = current;
      },
      "change",
      { message: `Strategy pool updated: ${Object.keys(current).join(", ")}` },
    );
    setTemplates(current);
  }
  // Apply a proposal that already passed the gate. One file at a time, backed
  // up, written atomically, and recorded as an audit event.
  apply(proposal) {
    const invalid = validateOverride(proposal.target, proposal.proposed, {
      invariantsHold: protectedInvariantsHold,
    });
    if (invalid) throw Error(invalid);
    const path = overridePath(this.dataDir, proposal.target);
    mkdirSync(join(this.dataDir, "overrides"), {
      recursive: true,
      mode: 0o750,
    });
    const backup = path + ".bak-" + Date.now();
    if (existsSync(path)) writeFileSync(backup, readFileSync(path));
    const tmp = path + ".tmp";
    writeFileSync(tmp, proposal.proposed, { mode: 0o640 });
    renameSync(tmp, path);
    this.store.event("change", {
      target: proposal.target,
      tier: tierOf(proposal.target),
      rationale: proposal.rationale,
      backup,
      message: `Applied review proposal to ${proposal.target}`,
    });
    return { path, backup };
  }
  revert(target) {
    if (!targetAllowed(target)) throw Error("Target is out of scope");
    const path = overridePath(this.dataDir, target);
    const latest = latestBackup(path);
    if (!latest) {
      try {
        unlinkSync(path);
      } catch {
        /* nothing to remove */
      }
      this.store.event("change", {
        target,
        message: `Reverted review proposal for ${target} (override removed)`,
      });
      return true;
    }
    writeFileSync(path, readFileSync(latest));
    this.store.event("change", {
      target,
      message: `Reverted review proposal for ${target}`,
      backup: latest,
    });
    return true;
  }
  // Remember an applied change so its effect can be measured on its own P&L and
  // reverted if it loses money. Only arm-scoped targets are tracked.
  recordChange(proposal) {
    const arm =
      proposal.target.startsWith("params.") ||
      proposal.target.startsWith("rubric.")
        ? proposal.target.split(".")[1]
        : null;
    if (!arm) return;
    let strategyChange = false;
    if (proposal.target.startsWith("params."))
      try {
        strategyChange = "strategy" in JSON.parse(proposal.proposed ?? "{}");
      } catch {
        strategyChange = false;
      }
    this.store.change(
      (st) => {
        st.appliedChanges ??= [];
        st.appliedChanges.push({
          target: proposal.target,
          arm,
          appliedAt: Date.now(),
          rationale: proposal.rationale ?? null,
        });
        st.appliedChanges = st.appliedChanges.slice(-50);
        // A strategy change resets the "due" window for that bot.
        if (strategyChange) {
          st.strategySince ??= {};
          st.strategySince[arm] = Date.now();
        }
      },
      "change",
      { message: `Tracking applied change ${proposal.target}`, arm },
    );
  }
  // Per-arm result since its last strategy change, and whether it is due for a
  // new strategy: 10 closed trades and losing money (not a Dice comparison).
  strategyDue(orders) {
    const s = this.store.read();
    const since = s.strategySince ?? {};
    const trips = closedRoundTrips(orders);
    const out = {};
    for (const arm of STRATEGY_ARMS) {
      const from = since[arm] ?? null;
      const armTrips = (trips[arm] ?? []).filter(
        (t) => !from || t.closed >= from,
      );
      const pnl = armTrips.reduce((n, t) => n + Number(t.pnl) / 1e18, 0);
      out[arm] = {
        trades: armTrips.length,
        wins: armTrips.filter((t) => t.pnl > 0n).length,
        losses: armTrips.filter((t) => t.pnl < 0n).length,
        pnl: Number(pnl.toFixed(2)),
        due: armTrips.length >= 10 && pnl < 0,
      };
    }
    return out;
  }
  // The loop's own track record: each applied change and its realised effect
  // since it was applied. The review judges whether to keep, refine, or revert.
  appliedLedger(orders) {
    const s = this.store.read();
    const changes = Array.isArray(s.appliedChanges) ? s.appliedChanges : [];
    const trips = closedRoundTrips(orders);
    return changes.map((c) => {
      const arm = (trips[c.arm] ?? []).filter((t) => t.closed >= c.appliedAt);
      const pnl = arm.reduce((n, t) => n + Number(t.pnl) / 1e18, 0);
      return {
        target: c.target,
        arm: c.arm,
        ageHours: Math.round((Date.now() - c.appliedAt) / 3600000),
        trades: arm.length,
        wins: arm.filter((t) => t.pnl > 0n).length,
        pnl: Number(pnl.toFixed(2)),
      };
    });
  }
  // Drop a reverted change from the ledger so it is not judged again.
  forgetChange(target) {
    this.store.change(
      (st) => {
        st.appliedChanges = (st.appliedChanges ?? []).filter(
          (c) => c.target !== target,
        );
      },
      "change",
      { message: `Reverted applied change ${target}` },
    );
  }
  // Auto-revert an applied change that has had time to prove itself and is
  // losing money (its own realised P&L since the change, not a Dice comparison).
  revertLosers(orders, now = Date.now()) {
    const s = this.store.read();
    const changes = Array.isArray(s.appliedChanges) ? s.appliedChanges : [];
    if (!changes.length) return;
    const trips = closedRoundTrips(orders);
    const keep = [];
    for (const c of changes) {
      if (now - c.appliedAt < SHADOW_HOURS * 3600000) {
        keep.push(c);
        continue;
      }
      const armTrips = (trips[c.arm] ?? []).filter(
        (t) => t.closed >= c.appliedAt,
      );
      const pnl = armTrips.reduce((n, t) => n + Number(t.pnl) / 1e18, 0);
      if (armTrips.length >= 3 && pnl < -MIN_MARGIN) {
        try {
          this.revert(c.target);
          this.store.event("change", {
            target: c.target,
            message: `Auto-reverted ${c.target}: ${c.arm} P&L ${pnl.toFixed(2)} since the change`,
          });
        } catch {
          keep.push(c);
        }
      } else keep.push(c);
    }
    this.store.change(
      (st) => {
        st.appliedChanges = keep;
      },
      "change",
      {
        message: `Reviewed ${changes.length} applied change(s); ${keep.length} kept`,
      },
    );
  }
}

function latestBackup(path) {
  try {
    const dir = path.slice(0, path.lastIndexOf("/")) || ".";
    const base = path.slice(path.lastIndexOf("/") + 1);
    const names = readdirSync(dir)
      .filter((n) => n.startsWith(base + ".bak-"))
      .sort();
    return names.length ? join(dir, names.at(-1)) : null;
  } catch {
    return null;
  }
}

// The evidence gate. Returns { ok, reasons[], tier } without side effects.
// Structural changes (the review's own questions) are ungated; edge changes need
// the target arm to have run minSample closed trades AND a control baseline of
// the same size before their profitability claim is honoured.
export function evaluateGate({
  proposal,
  sample,
  minSample = MIN_SAMPLE,
  controlArm = CONTROL_ARM,
  requireControl = false,
}) {
  const reasons = [];
  if (!targetAllowed(proposal.target))
    reasons.push(`Target ${proposal.target} is out of scope`);
  const invalid = validateOverride(proposal.target, proposal.proposed, {
    invariantsHold: protectedInvariantsHold,
  });
  if (invalid) reasons.push(invalid);
  const tier = tierOf(proposal.target);
  if (tier === "edge") {
    const arm = proposal.target.startsWith("rubric.")
      ? proposal.target.slice("rubric.".length)
      : proposal.target.startsWith("params.")
        ? proposal.target.slice("params.".length)
        : null;
    const count = arm
      ? (sample?.[arm] ?? 0)
      : STRATEGY_ARMS.reduce((n, a) => n + (sample?.[a] ?? 0), 0);
    if (count < minSample)
      reasons.push(
        `Insufficient sample: ${count} closed trades ${arm ? `on ${arm}` : "across strategy arms"}, need ${minSample}`,
      );
    // The control is the objective the review tunes against, not a hard gate
    // unless the owner asks for it.
    const control = sample?.[controlArm] ?? 0;
    if (requireControl && control < minSample)
      reasons.push(
        `Control baseline immature: ${control}/${minSample} closed trades`,
      );
  }
  return { ok: reasons.length === 0, reasons, tier };
}
