// Trade Review — hourly self-assessment.
//
// Laya reads the previous hour as text and answers four structured heads; the
// decision model turns those answers into bounded proposals for changing either
// the questions Laya is asked or a bot's rubric. Proposals are only applied when
// the evidence gate allows it, and applied changes live as overrides under the
// data directory (the service cannot write to the web root).
//
// This module never touches risk parameters. Targets are prose only: the Laya
// question set and the per-bot rubric text. Everything numeric - stops, sizing,
// riskPct, maxPositions, capital, mode - is out of scope by construction.
import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { dec } from "./decimal.mjs";
import { usageCounts, costOf } from "./providers.mjs";

// Minimum closed round-trips per arm before a change may be applied at all. Set
// in advance, per the project's change protocol, so the bar cannot drift.
export const MIN_SAMPLE = 50;
// Relative expectancy improvement required over the control arm.
export const MIN_MARGIN = 0.1;
// Hours a proposal must hold in shadow before promotion.
export const SHADOW_HOURS = 24;

// The four heads Laya answers over the hour. Deliberately short, and phrased as
// classification (not decisions), matching the project's Laya usage elsewhere.
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
      "evidence shown. If there were no exits, choose insufficient_evidence.",
    criteria: {
      early: "Closed before the thesis had a chance to resolve",
      late: "Held past the point the evidence had turned",
      appropriate: "Exits matched the evidence available at the time",
      insufficient_evidence: "Too little closed activity to judge",
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
};

// Phrases every rubric must retain. A proposal that drops any of them is
// rejected outright - otherwise an LLM can strip a safety instruction while
// looking "better" on the score.
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

// Targets a proposal may name. Prose only.
export const ALLOWED_TARGETS = [
  "laya.questions",
  "laya.fields",
  "rubric.breakout",
  "rubric.trend",
  "rubric.momentum",
];
export function targetAllowed(target) {
  return ALLOWED_TARGETS.includes(target);
}

// Closed round-trips per bot, reconstructed from the orders ledger exactly as
// performance.mjs does. Used as the sample count for the gate.
export function closedTrades(orders) {
  const positions = new Map(),
    counts = {};
  for (const o of Object.values(orders).sort((a, b) => a.created - b.created)) {
    counts[o.bot] ??= 0;
    const q = dec(o.filled || "0");
    if (q <= 0n) continue;
    const key = o.bot + ":" + o.product;
    const p = positions.get(key) || { quantity: 0n, cost: 0n };
    const value = dec(o.value || "0"),
      fees = dec(o.fees || "0");
    if (o.side === "BUY") {
      p.quantity += q;
      p.cost += value + fees;
      positions.set(key, p);
    } else if (o.side === "SELL") {
      if (p.quantity < q) continue;
      const basis = (p.cost * q) / p.quantity;
      p.quantity -= q;
      p.cost -= basis;
      positions.set(key, p);
      counts[o.bot] += 1;
    }
  }
  return counts;
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
  return lines.join("\n");
}

const REVIEW_SYSTEM =
  "You review one hour of an automated spot-trading system to propose " +
  "improvements. You are given structured summaries of the decisions taken, " +
  "Laya's classifications, the eligible setups, and the fills, followed by " +
  "Laya's own answers about the hour. Propose AT MOST 3 changes. A change may " +
  "only target the exact text of Laya's questions or a bot's written rubric. " +
  "You must never propose changes to numeric risk parameters, stop levels, " +
  "position sizing, capital, mode, or code. Every proposed rubric must retain " +
  "its safety clauses: no shorts, Laya is uncalibrated evidence not a decision " +
  "or probability, code controls size and execution, do not alter stops, do not " +
  "force trades. If the hour shows no problem worth changing, return an empty " +
  "proposals list. Return only JSON: " +
  '{"summary":"...","observations":[{"bot":"...","issue":"...","evidence":"..."}],' +
  '"proposals":[{"target":"laya.questions|rubric.breakout|rubric.trend|rubric.momentum",' +
  '"current":"...","proposed":"...","rationale":"...","risk":"..."}]}.';

export class TradeReview {
  constructor({ store, laya, model, config, dataDir }) {
    this.store = store;
    this.laya = laya;
    this.model = model;
    this.config = config;
    this.dataDir = dataDir;
    this.dir = join(dataDir, "rubrics");
  }
  // Overrides live under the writable data directory: the service runs with
  // ProtectSystem=strict and cannot write to the web root.
  overridePath(id) {
    return join(this.dir, `${id}.md`);
  }
  rubric(id, fallback) {
    const p = this.overridePath(id);
    try {
      if (existsSync(p)) return readFileSync(p, "utf8");
    } catch {
      // fall through to the bundled rubric
    }
    return fallback;
  }
  questionsPath() {
    return join(this.dataDir, "laya-questions.json");
  }
  // One hourly pass: gather the hour, let Laya classify it, let the model propose
  // changes, gate each proposal, and apply only what the evidence supports.
  async run({ since, until, coverage, autoApply = true }) {
    const events = this.store
      .recent(2000)
      .filter((e) => e.ts >= since && e.ts < until);
    const s = this.store.read();
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
        REVIEW_QUESTIONS,
      );
    } catch (e) {
      laya = { error: e.message };
    }
    let summary = null,
      observations = [],
      proposals = [],
      error = null;
    if (!laya.error) {
      const user =
        state + "\n\nLAYA ANSWERS\n" + JSON.stringify(laya.answers, null, 1);
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
      const gate = evaluateGate({ proposal: p, sample });
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
      laya: laya.error
        ? { error: laya.error }
        : { answers: laya.answers, elapsed_s: laya.elapsed_s ?? null },
      error,
    };
    // The full record lives in state (bounded); the event carries only a summary
    // so the stream stays small.
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
  // Apply a proposal that already passed the gate. One file at a time, backed up,
  // written atomically, and recorded as an audit event.
  apply(proposal) {
    if (!targetAllowed(proposal.target))
      throw Error("Proposal target is out of scope");
    if (!protectedInvariantsHold(proposal.proposed))
      throw Error("Proposal drops a protected safety clause");
    let path, value;
    if (proposal.target.startsWith("rubric.")) {
      mkdirSync(this.dir, { recursive: true, mode: 0o750 });
      path = this.overridePath(proposal.target.slice("rubric.".length));
      value = proposal.proposed;
    } else {
      path = this.questionsPath();
      value = proposal.proposed;
    }
    const backup = path + ".bak-" + Date.now();
    if (existsSync(path)) writeFileSync(backup, readFileSync(path));
    const tmp = path + ".tmp";
    writeFileSync(tmp, value, { mode: 0o640 });
    renameSync(tmp, path);
    this.store.event("change", {
      target: proposal.target,
      rationale: proposal.rationale,
      backup,
      message: `Applied review proposal to ${proposal.target}`,
    });
    return { path, backup };
  }
  revert(target) {
    if (!targetAllowed(target)) throw Error("Proposal target is out of scope");
    const path = target.startsWith("rubric.")
      ? this.overridePath(target.slice("rubric.".length))
      : this.questionsPath();
    const latest = latestBackup(path);
    if (!latest) {
      // No backup means the override was created fresh by the review; removing
      // it restores the bundled rubric. That is the revert.
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

// The evidence gate. Returns { ok, reasons[] } without side effects, so the
// caller can log a rejection and the card can show why nothing was applied.
export function evaluateGate({ proposal, sample, minSample = MIN_SAMPLE }) {
  const reasons = [];
  if (!targetAllowed(proposal.target))
    reasons.push(`Target ${proposal.target} is out of scope`);
  if (!protectedInvariantsHold(proposal.proposed))
    reasons.push("Proposed text drops a protected safety clause");
  const arms = Object.values(sample ?? {});
  const floor = arms.length ? Math.min(...arms) : 0;
  if (floor < minSample)
    reasons.push(
      `Insufficient sample: ${floor} closed trades on the thinnest arm, need ${minSample}`,
    );
  return { ok: reasons.length === 0, reasons };
}
