import test from "node:test";
import assert from "node:assert/strict";
import { selfTune } from "../src/self-tune.mjs";

const current = (target) => {
  if (target === "params.momentum")
    return { minBreadth: 5, topFraction: 0.35, trailAtr: 2.5, riskPct: 1 };
  if (target === "params.breakout")
    return { rangeAtr: 8, relativeVolume: 1.5, maxExtensionAtr: 3 };
  return {};
};

test("a weak bottleneck bot is loosened by exactly one bounded step", () => {
  const changes = selfTune({
    answers: {
      primary_bottleneck: { choice: "momentum" },
      momentum_quality: { score: 0 },
    },
    current,
  });
  const p = changes.find((c) => c.target === "params.momentum");
  assert.ok(p, "momentum params proposed");
  const obj = JSON.parse(p.proposed);
  assert.equal(obj.minBreadth, 4, "minBreadth -1");
  assert.equal(obj.topFraction, 0.4, "topFraction +0.05");
  // The rest of the effective params ride along, so the override is complete.
  assert.equal(obj.riskPct, 1);
});

test("a too-strict self-review selects the loose variant", () => {
  const changes = selfTune({
    answers: { laya_question_coverage: { choice: "too_strict" } },
    current,
  });
  const p = changes.find((c) => c.target === "laya.analysisPolicy");
  assert.ok(p);
  assert.equal(JSON.parse(p.proposed).variant, "loose");
});

test("an evidence focus selects the matching focus variant", () => {
  const changes = selfTune({
    answers: { laya_evidence_focus: { choice: "momentum" } },
    current,
  });
  assert.equal(
    JSON.parse(changes.find((c) => c.target === "laya.analysisPolicy").proposed)
      .variant,
    "momentum_focus",
  );
});

test("steps are clamped at the schema bounds and never leave the envelope", () => {
  const changes = selfTune({
    answers: {
      primary_bottleneck: { choice: "momentum" },
      momentum_quality: { score: 0 },
    },
    // minBreadth already at the floor of 1: -1 must clamp to 1, not 0.
    current: (t) =>
      t === "params.momentum" ? { minBreadth: 1, topFraction: 0.35 } : {},
  });
  const obj = JSON.parse(
    changes.find((c) => c.target === "params.momentum").proposed,
  );
  assert.equal(obj.minBreadth, 1, "clamped to floor");
  assert.ok(obj.topFraction <= 1);
});

test("a clean review proposes nothing", () => {
  assert.deepEqual(
    selfTune({ answers: { primary_bottleneck: { choice: "none" } }, current }),
    [],
  );
});
