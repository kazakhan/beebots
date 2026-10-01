// Editable overrides written by the Trade Review and read by the runtime.
//
// One registry, one directory: every applied change is a file under
// `<dataDir>/overrides/`, keyed by its target. The service can only write below
// its StateDirectory (ProtectSystem=strict), which is why these never live in
// the web root. Reading is best-effort: a missing or corrupt override falls back
// to the bundled default rather than breaking the runtime.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const OVERRIDES = {
  "laya.reviewQuestions": "laya-review-questions.json",
  "laya.analysisQuestions": "laya-analysis-questions.json",
  "rubric.breakout": "breakout.md",
  "rubric.trend": "trend.md",
  "rubric.momentum": "momentum.md",
  "params.breakout": "params-breakout.json",
  "params.trend": "params-trend.json",
  "params.momentum": "params-momentum.json",
  "params.control": "params-control.json",
  runtime: "runtime.json",
};

export const ALLOWED_TARGETS = Object.keys(OVERRIDES);

// Numeric tuning the self-improvement loop may write. Each key has a hard bound:
// the model proposes, but it can never leave this envelope. Capital, mode,
// leverage, maxPositions and turning stops off are deliberately absent - they
// are not tunable.
export const PARAM_SCHEMA = {
  rangeBars: { min: 5, max: 200, int: true },
  rangeAtr: { min: 0.5, max: 20 },
  relativeVolume: { min: 0.5, max: 10 },
  maxExtensionAtr: { min: 0, max: 10 },
  pullbackBars: { min: 1, max: 20, int: true },
  topFraction: { min: 0.05, max: 1 },
  minBreadth: { min: 1, max: 100, int: true },
  riskPct: { min: 0.1, max: 3 },
  maxCostRisk: { min: 0.05, max: 0.6 },
  trailAtr: { min: 0.5, max: 10 },
  trailR: { min: 0.5, max: 10 },
  tradeFraction: { min: 0.05, max: 0.95 },
  stopPct: { min: 0.5, max: 15 },
  trailPct: { min: 0.5, max: 15 },
  trailActivationPct: { min: 0.5, max: 30 },
  maxHoldHours: { min: 0, max: 168, int: true },
  cadenceMs: { min: 30000, max: 3600000, int: true },
  maxCandidates: { min: 1, max: 50, int: true },
  timeframe: { enum: ["5m", "15m", "1h"] },
  categories: { list: ["meme", "speculative", "unclassified"] },
};

export const RUNTIME_SCHEMA = {
  cadenceMs: { min: 30000, max: 3600000, int: true },
  maxCandidates: { min: 1, max: 50, int: true },
  modelMaxCallsPerDay: { min: 1, max: 100000, int: true },
  scoutCategories: { list: ["meme", "speculative", "unclassified"] },
};

export const PARAM_KEYS = Object.keys(PARAM_SCHEMA);
export const RUNTIME_KEYS = Object.keys(RUNTIME_SCHEMA);

function boundError(key, value, rule) {
  if (rule.enum)
    return rule.enum.includes(value)
      ? null
      : `${key} must be one of ${rule.enum.join(", ")}`;
  if (rule.list) {
    if (!Array.isArray(value) || !value.length)
      return `${key} must be a non-empty list`;
    const bad = value.filter((v) => !rule.list.includes(v));
    return bad.length ? `${key} has unknown entries: ${bad.join(", ")}` : null;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) return `${key} must be a number`;
  if (rule.int && !Number.isInteger(n)) return `${key} must be an integer`;
  if (n < rule.min || n > rule.max)
    return `${key} must be between ${rule.min} and ${rule.max}`;
  return null;
}

// Validate a numeric params/runtime object against its schema. Unknown keys are
// refused so the model cannot smuggle in capital, mode, leverage or anything
// else that is not explicitly tunable.
export function validateParams(target, value) {
  const schema = target === "runtime" ? RUNTIME_SCHEMA : PARAM_SCHEMA;
  if (!value || typeof value !== "object" || Array.isArray(value))
    return "A numeric override must be a JSON object";
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(schema, key)) return `${key} is not a tunable parameter`;
    const e = boundError(key, value[key], schema[key]);
    if (e) return e;
  }
  return null;
}

export function targetAllowed(target) {
  return Object.hasOwn(OVERRIDES, target);
}

export function overridePath(dataDir, target) {
  if (!targetAllowed(target)) throw Error("Target is out of scope");
  return join(dataDir, "overrides", OVERRIDES[target]);
}

// Raw override text, or null when absent/unreadable.
export function readOverride(dataDir, target) {
  if (!targetAllowed(target)) return null;
  try {
    const p = overridePath(dataDir, target);
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  } catch {
    return null;
  }
}

// Parse a JSON override for one of the Laya question sets, falling back to the
// bundled default. A corrupt file falls back rather than throwing.
export function readJsonOverride(dataDir, target, fallback) {
  const raw = readOverride(dataDir, target);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

// Validate a proposed override before it is written. Returns an error string, or
// null when acceptable. This is the structural gate: a fragment, a truncated
// document, or a question set missing a head is refused outright.
export function validateOverride(target, text, { invariantsHold } = {}) {
  if (!targetAllowed(target)) return "Target is out of scope";
  if (typeof text !== "string" || !text.trim()) return "Proposed text is empty";
  // Numeric overrides: a full JSON object validated against the hard bounds.
  if (target === "runtime" || target.startsWith("params.")) {
    let d;
    try {
      d = JSON.parse(text);
    } catch {
      return "A numeric override must be valid JSON";
    }
    return validateParams(target, d);
  }
  if (target.startsWith("rubric.")) {
    if (!/^\s*#/.test(text))
      return "A rubric must be a full document with a heading";
    if (text.trim().length < 200)
      return "A rubric proposal is too short to be a full document";
    if (invariantsHold && !invariantsHold(text))
      return "Proposed rubric drops a protected safety clause";
    return null;
  }
  // Laya question sets are JSON with a fixed set of heads.
  let d;
  try {
    d = JSON.parse(text);
  } catch {
    return "A question set must be valid JSON";
  }
  return validateQuestions(target, d);
}

function isChoice(q) {
  return q?.type === "choice" && q.criteria && !Array.isArray(q.criteria)
    ? Object.keys(q.criteria).length >= 2
    : false;
}
function isScore(q) {
  return (
    q?.type === "score" &&
    Array.isArray(q.criteria) &&
    q.criteria.length >= 2 &&
    q.criteria.every((c) => typeof c === "string" && c)
  );
}
function isNoul(q) {
  return q?.type === "noul";
}
function okHead(q) {
  return typeof q?.instructions === "string" && q.instructions.length >= 20;
}

function validateQuestions(target, d) {
  const head = (name, predicate) => {
    if (!okHead(d?.[name])) return `Head "${name}" is missing instructions`;
    if (!predicate(d[name])) return `Head "${name}" has the wrong answer type`;
    return null;
  };
  if (!d || typeof d !== "object" || Array.isArray(d))
    return "A question set must be an object";
  if (target === "laya.analysisQuestions") {
    for (const [name, pred] of [
      ["regime", isChoice],
      ["fit", isScore],
      ["quality", isChoice],
    ]) {
      const e = head(name, pred);
      if (e) return e;
    }
    return null;
  }
  // Review heads: at least the four required, plus laya_value.
  for (const [name, pred] of [
    ["missed_opportunity", isNoul],
    ["exit_timing", isChoice],
    ["failing_rubric", isChoice],
    ["evidence_quality", isScore],
    ["laya_value", isChoice],
  ]) {
    const e = head(name, pred);
    if (e) return e;
  }
  return null;
}
