// The no-LLM self-tuner: turn Laya's rubric answers into bounded changes.
//
// A System One model cannot author text, so when no LLM is enabled this
// deterministic table reads Laya's self-review answers and moves a whitelisted
// set of numbers by ONE bounded step, or selects a pre-authored analysis
// variant. Everything it emits is validated by the same override schema the LLM
// uses, applied by the same code, and auto-reverted if it loses to Dice.
import { clampParam } from "./overrides.mjs";
import { VARIANT_NAMES } from "./analysis-variants.mjs";

const BOTS = ["breakout", "trend", "momentum"];

// Loosening direction per bot (one step): make the gates easier to pass.
const LOOSEN = {
  breakout: { rangeAtr: 0.5, relativeVolume: -0.25, maxExtensionAtr: 0.25 },
  trend: { maxExtensionAtr: 0.25, pullbackBars: -1 },
  momentum: { minBreadth: -1, topFraction: 0.05 },
};

export function selfTune({ answers = {}, current = () => ({}) } = {}) {
  const byTarget = new Map();
  const merge = (target, patch, why) => {
    const entry = byTarget.get(target) ?? {
      base: current(target),
      patch: {},
      why: [],
    };
    Object.assign(entry.patch, patch);
    entry.why.push(why);
    byTarget.set(target, entry);
  };
  const step = (target, key, delta) => {
    const base = Number(current(target)?.[key]);
    if (!Number.isFinite(base)) return null;
    return clampParam(target, key, base + delta);
  };

  const bottleneck = BOTS.includes(answers?.primary_bottleneck?.choice)
    ? answers.primary_bottleneck.choice
    : null;
  const quality = (b) => Number(answers?.[`${b}_quality`]?.score);
  const missed = Number(answers?.missed_opportunity?.noul) >= 0.5;

  // A weak bottleneck bot, or missed opportunity, loosens its gates one step.
  if (bottleneck && (quality(bottleneck) <= 1 || missed)) {
    const patch = {};
    for (const [key, delta] of Object.entries(LOOSEN[bottleneck])) {
      const v = step(`params.${bottleneck}`, key, delta);
      if (v !== null) patch[key] = v;
    }
    if (Object.keys(patch).length)
      merge(
        `params.${bottleneck}`,
        patch,
        `Laya: ${bottleneck} bottleneck (quality ${quality(bottleneck)}, missed=${missed})`,
      );
  }

  // Exit timing tunes the trail on the implicated bot, one step.
  const exit = answers?.exit_timing?.choice;
  if (bottleneck && (exit === "late" || exit === "early")) {
    const v = step(
      `params.${bottleneck}`,
      "trailAtr",
      exit === "late" ? 0.25 : -0.25,
    );
    if (v !== null)
      merge(`params.${bottleneck}`, { trailAtr: v }, `Laya: exits ${exit}`);
  }

  // Analysis variant from Laya's self-review of its own questions.
  let variant = null;
  if (answers?.laya_question_coverage?.choice === "too_strict")
    variant = "loose";
  else if (answers?.laya_question_coverage?.choice === "too_loose")
    variant = "strict";
  const focus = answers?.laya_evidence_focus?.choice;
  if (focus && VARIANT_NAMES.includes(`${focus}_focus`))
    variant = `${focus}_focus`;
  if (variant)
    merge(
      "laya.analysisPolicy",
      { variant },
      `Laya: analysis variant ${variant}`,
    );

  return [...byTarget.entries()].map(([target, e]) => ({
    target,
    proposed: JSON.stringify({ ...e.base, ...e.patch }),
    rationale: e.why.join("; "),
  }));
}
