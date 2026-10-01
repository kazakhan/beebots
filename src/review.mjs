// Trade Review — hourly self-assessment of both the bots and Laya.
//
// Laya reads the previous hour as text and answers a set of classified heads;
// the decision model turns those answers into bounded proposals that may change
// a bot's written rubric or Laya's own question sets. Proposals are applied only
// when the evidence gate allows it, and applied changes live as overrides under
// the data directory (the service cannot write to the web root).
//
// Targets are prose only. Everything numeric - stops, sizing, riskPct,
// maxPositions, capital, mode - is out of scope by construction.
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
  ALLOWED_TARGETS,
  targetAllowed,
  overridePath,
  readOverride,
  readJsonOverride,
  validateOverride,
} from "./overrides.mjs";

export { ALLOWED_TARGETS, targetAllowed };

// Minimum closed round-trips before an EDGE change (a bot rubric or Laya's
// trading questions) may be applied. Structural changes - the review's own
// questions - are exempt because they cannot affect trading.
export const MIN_SAMPLE = 10;
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

// Build the hour as text for Laya. Bounded: the daemon's context is finite and
// the state is truncated server-side anyway.
export function buildHourState({ events, orders, coverage, since, until }) {
  const lines = [];
  const inWindow = (e) => e.ts >= since && e.ts < until;
  const decisions = events.filter((e) => e.kind === "decision" && inWindow(e));
  const analyses = events.filter((e) => e.kind === "analysis" && inWindow(e));
  lines.push(
    `HOUR ${new Date(since).toISOString()} to ${new Date(until).toISOString()}`,
  );
  lines.push(`DECISIONS (${decisions.length})`);
  for (const e of decisions)
    lines.push(
      `- ${e.bot} ${e.action}${e.product ? " " + e.product : ""}: ${String(e.reason ?? "").slice(0, 300)}`,
    );
  lines.push(`LAYA LABELS (${analyses.length})`);
  for (const e of analyses)
    lines.push(
      `- ${e.bot} ${e.product}: regime=${e.answers?.regime?.choice} fit=${e.answers?.fit?.score} quality=${e.answers?.quality?.choice}`,
    );
  if (coverage) {
    lines.push("ELIGIBLE SETUPS / REJECTIONS");
    lines.push(
      `- discovered ${coverage.total ?? "?"}, eligible ${coverage.eligible ?? "?"}, ready ${coverage.ready ?? "?"}, scout universe ${coverage.scout ?? "?"}`,
    );
    for (const [bot, b] of Object.entries(coverage.bots ?? {}))
      lines.push(
        `- ${bot}: evaluated ${b.evaluated}, eligible ${b.eligible}; ${b.shortlist
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
  return lines.join("\n");
}

const REVIEW_SYSTEM =
  "You review one hour of an automated spot-trading system and propose " +
  "improvements to EITHER the bots' written rubrics OR Laya's own question " +
  "sets. Two jobs: (1) judge the bots against the hour's decisions and " +
  "outcomes; (2) judge Laya itself - do its classifications track outcomes, " +
  "and is it being asked the right questions? You are given the decisions, " +
  "Laya's classifications and a Laya performance table, the eligible setups, " +
  "the fills, Laya's answers, and the CURRENT full text of every editable " +
  "target. Propose AT MOST 3 changes. Each proposal's `proposed` field MUST be " +
  "the COMPLETE replacement document - the full rubric text (with its heading) " +
  "or the full question-set JSON - not a description or a diff; `current` must " +
  "be the exact current text you are replacing. A rubric must retain its safety " +
  "clauses: no shorts, Laya is uncalibrated evidence not a decision or " +
  "probability, code controls size and execution, do not alter stops, do not " +
  "force trades. You must never propose changes to numeric risk parameters, " +
  "stop levels, position sizing, capital, mode, or code. If nothing is worth " +
  "changing, return an empty proposals list. Return only JSON: " +
  '{"summary":"...","observations":[{"bot":"...","issue":"...","evidence":"..."}],' +
  '"proposals":[{"target":"laya.reviewQuestions|laya.analysisQuestions|rubric.breakout|rubric.trend|rubric.momentum",' +
  '"current":"...","proposed":"...","rationale":"...","risk":"..."}]}.';

export class TradeReview {
  constructor({ store, laya, model, config, dataDir }) {
    this.store = store;
    this.laya = laya;
    this.model = model;
    this.config = config;
    this.dataDir = dataDir;
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
  // The current text of every editable target, for the model to rewrite.
  currentTargets() {
    const out = {
      "laya.reviewQuestions": JSON.stringify(this.reviewQuestions(), null, 1),
    };
    for (const id of STRATEGY_ARMS) {
      const t = readOverride(this.dataDir, `rubric.${id}`);
      if (t) out[`rubric.${id}`] = t;
    }
    return out;
  }
  // One hourly pass: gather the hour, let Laya classify it, let the model propose
  // changes, gate each proposal, and apply only what the evidence supports.
  async run({ since, until, coverage, autoApply = true }) {
    const events = this.store
      .recent(2000)
      .filter((e) => e.ts >= since && e.ts < until);
    const s = this.store.read();
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
      );
    } catch (e) {
      laya = { error: e.message };
    }
    let summary = null,
      observations = [],
      proposals = [],
      error = null;
    if (!laya.error) {
      const targets = this.currentTargets();
      const user =
        state +
        "\n\nLAYA ANSWERS\n" +
        JSON.stringify(laya.answers, null, 1) +
        "\n\nCURRENT TARGETS\n" +
        JSON.stringify(targets, null, 1);
      try {
        const r = await this.model.review(REVIEW_SYSTEM, user);
        summary = typeof r.data?.summary === "string" ? r.data.summary : null;
        observations = Array.isArray(r.data?.observations)
          ? r.data.observations.slice(0, 6)
          : [];
        proposals = Array.isArray(r.data?.proposals)
          ? r.data.proposals.slice(0, 3)
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
    }
    const sample = closedTrades(s.orders);
    const reviewed = proposals.map((p) => {
      const gate = evaluateGate({
        proposal: p,
        sample,
        minSample: this.config?.review?.minSample,
      });
      let applied = false;
      if (gate.ok && autoApply) {
        try {
          this.apply(p);
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
      : null;
    const count = arm
      ? (sample?.[arm] ?? 0)
      : STRATEGY_ARMS.reduce((n, a) => n + (sample?.[a] ?? 0), 0);
    if (count < minSample)
      reasons.push(
        `Insufficient sample: ${count} closed trades ${arm ? `on ${arm}` : "across strategy arms"}, need ${minSample}`,
      );
    const control = sample?.[controlArm] ?? 0;
    if (control < minSample)
      reasons.push(
        `Control baseline immature: ${control}/${minSample} closed trades`,
      );
  }
  return { ok: reasons.length === 0, reasons, tier };
}
