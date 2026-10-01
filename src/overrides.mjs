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
};

export const ALLOWED_TARGETS = Object.keys(OVERRIDES);

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
