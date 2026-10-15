// The no-LLM self-tuner (4.0.4): WEIGHTS ONLY.
//
// Trading is a weighted model, so the only thing worth tuning is the weights.
// When no LLM is enabled this deterministic table reads Laya's self-review
// answers and moves ONE weight by ONE bounded step for a bot that is the
// bottleneck or is losing money. Everything it emits is validated by the same
// override schema the LLM uses and is applied by the same code, and a weight
// change is applied only if the review's backtest shows net P&L improves.
import { clampParam } from "./overrides.mjs";

const BOTS = ["breakout", "trend", "momentum"];

// The weight key each bot nudges (its defining feature): Keeper = 7d momentum,
// Spark = RSI, Scout = breakout.
const WEIGHT_NUDGE = {
  trend: "wM7",
  momentum: "wRsiLow",
  breakout: "wBreakout",
};

export function selfTune({
  answers = {},
  current = () => ({}),
  due = null,
} = {}) {
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
  const nudge = (arm, why) => {
    const wk = WEIGHT_NUDGE[arm];
    if (!wk) return;
    const v = step(`params.${arm}`, wk, 0.5);
    if (v !== null) merge(`params.${arm}`, { [wk]: v }, why);
  };

  const bottleneck = BOTS.includes(answers?.primary_bottleneck?.choice)
    ? answers.primary_bottleneck.choice
    : null;
  const quality = (b) => Number(answers?.[`${b}_quality`]?.score);
  const missed = Number(answers?.missed_opportunity?.noul) >= 0.5;

  // A weak bottleneck bot, or a missed opportunity, gets one weight step.
  if (bottleneck && (quality(bottleneck) <= 1 || missed))
    nudge(
      bottleneck,
      `Laya: ${bottleneck} bottleneck (quality ${quality(bottleneck)}, missed=${missed})`,
    );

  // Any arm flagged losing gets one weight step. The review's backtest gate
  // accepts it only when net P&L improves, so an unhelpful nudge is refused.
  for (const arm of BOTS)
    if (due?.[arm]?.due) nudge(arm, `Laya: ${arm} losing (one weight step)`);

  return [...byTarget.entries()].map(([target, e]) => ({
    target,
    proposed: JSON.stringify({ ...e.base, ...e.patch }),
    rationale: e.why.join("; "),
  }));
}
