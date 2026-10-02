// Trade Review — hourly self-assessment of the bots and Laya.
//
// Laya reads the previous hour as text and answers a set of classified heads;
// the decision model turns those answers into proposals that change a bot's
// rubric, Laya's question sets, OR the numeric strategy parameters (gates,
// cadence, candidate cap, timeframe, universe). The objective is to beat the
// control arm (Dice): more wins, fewer losses. Proposals are applied
// automatically within hard numeric bounds, and a change that later
// underperforms Dice is auto-reverted. Everything applied lives as an override
// under the data directory.
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
import { defaults as STRATEGY_DEFAULTS } from "./strategy-v2.mjs";
import { engineUses } from "./engines.mjs";
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
} from "./overrides.mjs";

export { ALLOWED_TARGETS, targetAllowed };

// Minimum closed round-trips before an EDGE change may be applied. Lowered for a
// faster self-improvement loop; the review runs hourly.
export const MIN_SAMPLE = 5;
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
      "What single thing most limited results this hour? Judge against the " +
      "scoreboard versus Dice.",
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
      });
      p.quantity -= q;
      p.cost -= basis;
      positions.set(key, p);
    }
  }
  return trips;
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

// Per-arm realised P&L and win/loss, with each strategy bot's gap to Dice. This
// is the objective the review tunes against.
export function scoreboardLines(orders) {
  const trips = closedRoundTrips(orders);
  const bots = [...STRATEGY_ARMS, CONTROL_ARM];
  const row = (bot) => {
    const list = trips[bot] ?? [];
    const pnl = list.reduce((n, t) => n + Number(t.pnl) / 1e18, 0);
    const wins = list.filter((t) => t.pnl > 0n).length;
    return { bot, n: list.length, wins, loss: list.length - wins, pnl };
  };
  const rows = bots.map(row);
  const dice = rows.find((r) => r.bot === CONTROL_ARM) ?? { pnl: 0 };
  const out = ["SCOREBOARD (realised P&L, all-time)"];
  for (const r of rows)
    out.push(
      `- ${r.bot}: ${r.n} trades ${r.wins}W/${r.loss}L pnl=${r.pnl.toFixed(2)}` +
        (r.bot === CONTROL_ARM
          ? " (Dice, the baseline to beat)"
          : ` (vs Dice ${(r.pnl - dice.pnl >= 0 ? "+" : "") + (r.pnl - dice.pnl).toFixed(2)})`),
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
  "random control arm named Dice. Your objective: make each bot BEAT Dice - " +
  "more wins, fewer losses, higher realised P&L. You may change ANY editable " +
  "target: a bot's written rubric, Laya's question sets, and the numeric " +
  "strategy parameters (entry gates, risk, cadence, candidate cap, signal " +
  "timeframe, Scout's universe categories) and the runtime knobs. Two jobs: " +
  "(1) judge the bots against Laya's rubric-based review of the hour and the " +
  "per-arm scoreboard versus Dice; (2) judge Laya itself - do its classifications " +
  "track outcomes, and is it being asked the right questions? You are given " +
  "Laya's review of the hour and the per-arm scoreboard, the allowed numeric " +
  "ranges, and the CURRENT value of every editable target. Propose at most 2 " +
  "changes. Each proposal's " +
  "`proposed` field MUST be the COMPLETE replacement - the full rubric text " +
  "(with heading), the full question-set JSON, or the full numeric JSON - the " +
  "exact shape of `current`; `current` must be the exact value you are " +
  "replacing. Numeric values must stay within the allowed ranges; anything " +
  "outside is refused. Rubrics must retain their safety clauses: no shorts, " +
  "Laya is uncalibrated evidence not a decision or probability, code controls " +
  "size and execution, do not alter stops, do not force trades. Capital, mode, " +
  "leverage and disabling stops are never changeable. If nothing is worth " +
  "changing, return an empty proposals list. Return only JSON: " +
  '{"summary":"...","observations":[{"bot":"...","issue":"...","evidence":"..."}],' +
  '"proposals":[{"target":"...","current":"...","proposed":"...","rationale":"...","risk":"..."}]}.';

export class TradeReview {
  constructor({ store, laya, model, config, dataDir, engineId = null }) {
    this.store = store;
    this.laya = laya;
    this.model = model;
    this.config = config;
    this.dataDir = dataDir;
    this.engineId = engineId;
  }
  // Whether the selected engine includes an LLM. The LLM is the only component
  // that can author new text; without it, Laya self-tunes by selection.
  llmEnabled() {
    const id = this.engineId?.();
    return id ? engineUses(id, "llm") : true;
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
    };
    const over = readJsonOverride(this.dataDir, "runtime", null);
    if (over && !validateParams("runtime", over)) Object.assign(base, over);
    return base;
  }
  // Only the tunable keys, so the model sees the shape it may rewrite.
  paramView(id) {
    const eff = this.effectiveParams(id);
    return Object.fromEntries(
      PARAM_KEYS.filter((k) => eff[k] !== undefined).map((k) => [k, eff[k]]),
    );
  }
  runtimeView() {
    const eff = this.effectiveRuntime();
    return Object.fromEntries(RUNTIME_KEYS.map((k) => [k, eff[k]]));
  }
  // The current value of every editable target, for the model to rewrite.
  currentTargets() {
    const out = {
      "laya.reviewQuestions": JSON.stringify(this.reviewQuestions(), null, 1),
    };
    for (const id of STRATEGY_ARMS) {
      const t = readOverride(this.dataDir, `rubric.${id}`);
      if (t) out[`rubric.${id}`] = t;
    }
    for (const id of [...STRATEGY_ARMS, CONTROL_ARM])
      out[`params.${id}`] = JSON.stringify(this.paramView(id), null, 1);
    out.runtime = JSON.stringify(this.runtimeView(), null, 1);
    out["laya.analysisPolicy"] = JSON.stringify(
      this.currentValue("laya.analysisPolicy"),
      null,
      1,
    );
    return out;
  }
  // The allowed numeric ranges, so the model proposes in-bounds values.
  schemaText() {
    const fmt = (schema) =>
      Object.entries(schema)
        .map(([k, r]) =>
          r.enum
            ? `${k}: one of ${r.enum.join("|")}`
            : r.list
              ? `${k}: any of ${r.list.join("|")}`
              : `${k}: ${r.min}..${r.max}${r.int ? " (int)" : ""}`,
        )
        .join("; ");
    return (
      "ALLOWED NUMERIC RANGES\nparams.<bot>: " +
      fmt(PARAM_SCHEMA) +
      "\nruntime: " +
      fmt(RUNTIME_SCHEMA) +
      "\nlaya.analysisPolicy.variant: one of " +
      VARIANT_NAMES.join(", ")
    );
  }
  // One hourly pass: gather the hour, let Laya classify it, let the model propose
  // changes, gate each proposal, and apply only what the evidence supports.
  async run({ since, until, coverage, autoApply = true }) {
    const events = this.store
      .recent(2000)
      .filter((e) => e.ts >= since && e.ts < until);
    const s = this.store.read();
    // Close the loop first: any earlier change that is now losing to Dice is
    // reverted before we consider new proposals.
    this.revertLosers(s.orders, until);
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
    let summary = null,
      observations = [],
      proposals = [],
      error = null;
    if (!laya.error) {
      if (this.llmEnabled()) {
        // The LLM authors changes, but sees only Laya's verdict - never the raw
        // hour. Laya digests; the LLM decides and writes text.
        const user =
          "LAYA'S REVIEW\n" +
          JSON.stringify(laya.answers, null, 1) +
          "\n\nSCOREBOARD\n" +
          scoreboardLines(s.orders).join("\n") +
          "\n\nCURRENT TARGETS\n" +
          JSON.stringify(this.currentTargets(), null, 1) +
          "\n\n" +
          this.schemaText();
        try {
          const r = await this.model.review(
            REVIEW_SYSTEM,
            user,
            this.config?.review?.timeoutMs ?? 300000,
          );
          summary = typeof r.data?.summary === "string" ? r.data.summary : null;
          observations = Array.isArray(r.data?.observations)
            ? r.data.observations.slice(0, 6)
            : [];
          proposals = Array.isArray(r.data?.proposals)
            ? r.data.proposals.slice(
                0,
                Math.max(1, Number(this.config?.review?.maxProposals) || 2),
              )
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
          error = e.message;
        }
      } else {
        // No LLM: Laya self-tunes - it selects a pre-authored analysis variant
        // and steps a whitelisted number by one bounded step.
        try {
          proposals = selfTune({
            answers: laya.answers,
            current: (t) => this.currentValue(t),
          });
          summary = proposals.length
            ? `Laya self-tune: ${proposals.length} bounded change(s)`
            : "Laya self-tune: no change needed";
        } catch (e) {
          error = e.message;
        }
      }
    }
    const sample = closedTrades(s.orders);
    const reviewed = proposals.map((p) => {
      const gate = evaluateGate({
        proposal: p,
        sample,
        minSample: this.config?.review?.minSample,
        requireControl: this.config?.review?.requireControl,
      });
      let applied = false;
      if (gate.ok && autoApply) {
        try {
          this.apply(p);
          applied = true;
          this.recordChange(p);
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
      laya: laya.error
        ? { error: laya.error }
        : { answers: laya.answers, elapsed_s: laya.elapsed_s ?? null },
      error,
    };
    this.store.change(
      (st) => {
        st.lastReview = record;
      },
      "review",
      {
        summary,
        proposals: reviewed.length,
        applied: reviewed.filter((d) => d.applied).length,
        error,
      },
    );
    return record;
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
  // Remember an applied change so its effect can be measured against Dice and
  // reverted if it underperforms. Only arm-scoped targets are tracked.
  recordChange(proposal) {
    const arm =
      proposal.target.startsWith("params.") ||
      proposal.target.startsWith("rubric.")
        ? proposal.target.split(".")[1]
        : null;
    if (!arm) return;
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
      },
      "change",
      { message: `Tracking applied change ${proposal.target}`, arm },
    );
  }
  // Auto-revert an applied change that has had time to prove itself and is
  // losing to Dice. The safety bound is always Dice, not an arbitrary threshold.
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
      const diceTrips = (trips[CONTROL_ARM] ?? []).filter(
        (t) => t.closed >= c.appliedAt,
      );
      const pnl = armTrips.reduce((n, t) => n + Number(t.pnl) / 1e18, 0);
      const dice = diceTrips.reduce((n, t) => n + Number(t.pnl) / 1e18, 0);
      if (armTrips.length >= 3 && pnl < dice - MIN_MARGIN) {
        try {
          this.revert(c.target);
          this.store.event("change", {
            target: c.target,
            message: `Auto-reverted ${c.target}: ${c.arm} P&L ${pnl.toFixed(2)} vs Dice ${dice.toFixed(2)}`,
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
