import test from "node:test";
import assert from "node:assert/strict";
import {
  ANALYSIS_VARIANTS,
  VARIANT_NAMES,
  isVariant,
  variantQuestions,
} from "../src/analysis-variants.mjs";
import { resolveAnalysisQuestions } from "../src/laya.mjs";

test("the variant library exposes full, well-typed question sets", () => {
  assert.ok(VARIANT_NAMES.includes("balanced"));
  assert.ok(VARIANT_NAMES.includes("strict"));
  for (const name of VARIANT_NAMES) {
    const q = variantQuestions("breakout", name);
    assert.equal(q.regime.type, "choice");
    assert.ok(Object.keys(q.regime.criteria).length >= 2);
    assert.equal(q.fit.type, "score");
    assert.ok(Array.isArray(q.fit.criteria) && q.fit.criteria.length >= 2);
    assert.equal(q.quality.type, "choice");
    assert.ok(typeof q.fit.instructions === "string" && q.fit.instructions);
  }
  assert.equal(isVariant("nope"), false);
  assert.equal(isVariant(undefined), false);
});

test("a named variant becomes the base the override merges onto", () => {
  const strict = resolveAnalysisQuestions("breakout", null, "strict");
  const base = resolveAnalysisQuestions("breakout", null);
  assert.notEqual(strict.fit.instructions, base.fit.instructions);
  // A partial override still merges on top of the variant.
  const merged = resolveAnalysisQuestions(
    "breakout",
    { quality: { instructions: "OVERRIDDEN" } },
    "trend_focus",
  );
  assert.equal(merged.quality.instructions, "OVERRIDDEN");
  assert.match(merged.fit.instructions, /trend structure/i);
  // An unknown variant falls back to the bundled default.
  const fallback = resolveAnalysisQuestions("breakout", null, "nonsense");
  assert.deepEqual(fallback, base);
  assert.ok(Object.keys(ANALYSIS_VARIANTS).length >= 3);
});
