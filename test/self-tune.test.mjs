import test from "node:test";
import assert from "node:assert/strict";
import { selfTune } from "../src/self-tune.mjs";

const current = (target) => {
  if (target === "params.trend") return { wM7: 2, scoreMin: 1 };
  if (target === "params.momentum") return { wRsiLow: 2, scoreMin: 1 };
  if (target === "params.breakout") return { wBreakout: 2, scoreMin: 1 };
  return {};
};

test("a weak bottleneck bot gets exactly one bounded weight step", () => {
  const changes = selfTune({
    answers: {
      primary_bottleneck: { choice: "momentum" },
      momentum_quality: { score: 0 },
    },
    current,
  });
  const p = changes.find((c) => c.target === "params.momentum");
  assert.ok(p, "momentum weights proposed");
  const obj = JSON.parse(p.proposed);
  assert.equal(obj.wRsiLow, 2.5, "wRsiLow +0.5");
  // Only weights move; the seed rides along untouched.
  assert.equal(obj.scoreMin, 1);
});

test("steps are clamped at the schema bounds and never leave the envelope", () => {
  const changes = selfTune({
    answers: {
      primary_bottleneck: { choice: "momentum" },
      momentum_quality: { score: 0 },
    },
    // wRsiLow at its ceiling (10): +0.5 must clamp to 10.
    current: (t) => (t === "params.momentum" ? { wRsiLow: 10 } : {}),
  });
  const obj = JSON.parse(
    changes.find((c) => c.target === "params.momentum").proposed,
  );
  assert.equal(obj.wRsiLow, 10, "clamped to ceiling");
});

test("a clean review proposes nothing", () => {
  assert.deepEqual(
    selfTune({ answers: { primary_bottleneck: { choice: "none" } }, current }),
    [],
  );
});

test("a losing arm gets one bounded weight step", () => {
  const changes = selfTune({
    answers: { primary_bottleneck: { choice: "none" } },
    current,
    due: { trend: { due: true }, momentum: { due: false } },
  });
  const p = changes.find((c) => c.target === "params.trend");
  assert.ok(p, "losing trend proposes a change");
  assert.equal(JSON.parse(p.proposed).wM7, 2.5, "one bounded weight step");
});

test("self-tune never proposes a non-weight target or key", () => {
  const changes = selfTune({
    answers: {
      primary_bottleneck: { choice: "breakout" },
      breakout_quality: { score: 0 },
      laya_question_coverage: { choice: "too_strict" },
    },
    current,
  });
  for (const c of changes) {
    assert.match(c.target, /^params\./);
    for (const k of Object.keys(JSON.parse(c.proposed))) {
      if (k === "scoreMin" || k.startsWith("w")) continue;
      assert.fail(`unexpected key ${k}`);
    }
  }
});
