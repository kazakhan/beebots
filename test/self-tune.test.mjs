import test from "node:test";
import assert from "node:assert/strict";
import { selfTune } from "../src/self-tune.mjs";

const current = (target) => {
  if (target === "params.momentum")
    return {
      rsiOversold: 30,
      maxExtensionAtr: 0.75,
      trailAtr: 2.5,
      riskPct: 1.5,
    };
  if (target === "params.breakout")
    return { relativeVolume: 1.5, maxExtensionAtr: 1 };
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
  assert.equal(obj.rsiOversold, 35, "rsiOversold +5");
  assert.equal(obj.maxExtensionAtr, 1, "maxExtensionAtr +0.25");
  // The rest of the effective params ride along, so the override is complete.
  assert.equal(obj.riskPct, 1.5);
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
    // rsiOversold at its ceiling (50): +5 must clamp to 50, not 55.
    current: (t) =>
      t === "params.momentum" ? { rsiOversold: 48, maxExtensionAtr: 1 } : {},
  });
  const obj = JSON.parse(
    changes.find((c) => c.target === "params.momentum").proposed,
  );
  assert.equal(obj.rsiOversold, 50, "clamped to ceiling");
  assert.ok(obj.maxExtensionAtr <= 10);
});

test("a clean review proposes nothing", () => {
  assert.deepEqual(
    selfTune({ answers: { primary_bottleneck: { choice: "none" } }, current }),
    [],
  );
});
