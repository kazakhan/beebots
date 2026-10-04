import test from "node:test";
import assert from "node:assert/strict";
import {
  validateParams,
  validateOverride,
  validatePolicy,
  clampParam,
  targetAllowed,
  PARAM_SCHEMA,
  PARAM_KEYS,
  RUNTIME_KEYS,
} from "../src/overrides.mjs";

test("the numeric registry covers each bot and the runtime", () => {
  for (const t of [
    "params.breakout",
    "params.trend",
    "params.momentum",
    "params.control",
    "runtime",
  ])
    assert.ok(targetAllowed(t), `${t} must be a target`);
});

test("a numeric override inside its bounds is accepted", () => {
  assert.equal(
    validateParams("params.breakout", {
      rangeAtr: 8,
      relativeVolume: 1.5,
      maxExtensionAtr: 3,
      cadenceMs: 300000,
      maxCandidates: 25,
      timeframe: "15m",
      categories: ["meme", "speculative"],
    }),
    null,
  );
  assert.equal(validateParams("runtime", { cadenceMs: 60000 }), null);
});

test("an out-of-bounds or unknown numeric key is refused", () => {
  assert.match(
    validateParams("params.trend", { riskPct: 99 }),
    /riskPct must be between/,
  );
  assert.match(
    validateParams("params.trend", { maxCandidates: 1.5 }),
    /must be an integer/,
  );
  assert.match(
    validateParams("params.trend", { timeframe: "2m" }),
    /timeframe must be one of/,
  );
  // Capital, mode and leverage are not tunable: unknown keys are refused.
  assert.match(
    validateParams("params.trend", { capital: 1000 }),
    /not a tunable/,
  );
  assert.match(validateParams("runtime", { mode: "live" }), /not a tunable/);
});

test("validateOverride routes numeric targets through the schema", () => {
  assert.equal(
    validateOverride("params.momentum", JSON.stringify({ minBreadth: 5 })),
    null,
  );
  assert.match(
    validateOverride("params.momentum", JSON.stringify({ minBreadth: 0 })),
    /minBreadth must be between/,
  );
  assert.match(
    validateOverride("params.momentum", "{not json"),
    /must be valid JSON/,
  );
});

test("the schema bounds are sane", () => {
  for (const [k, r] of Object.entries(PARAM_SCHEMA))
    if (r.min !== undefined) assert.ok(r.min <= r.max, `${k} min<=max`);
});

test("the analysis policy accepts a known variant and rejects unknown fields", () => {
  assert.equal(
    validateOverride(
      "laya.analysisPolicy",
      JSON.stringify({ variant: "strict" }),
    ),
    null,
  );
  assert.match(
    validateOverride(
      "laya.analysisPolicy",
      JSON.stringify({ variant: "nope" }),
    ),
    /variant must be one of/,
  );
  assert.match(
    validateOverride(
      "laya.analysisPolicy",
      JSON.stringify({ variant: "balanced", capital: 1 }),
    ),
    /not a tunable policy field/,
  );
  assert.ok(targetAllowed("laya.analysisPolicy"));
});

test("clampParam keeps stepped values inside the schema", () => {
  assert.equal(clampParam("params.trend", "minBreadth", 0), 1);
  assert.equal(clampParam("params.trend", "minBreadth", 999), 100);
  assert.equal(clampParam("params.trend", "riskPct", 99), 3);
  assert.equal(clampParam("params.trend", "minBreadth", 5.4), 5); // int rounds
  assert.equal(clampParam("runtime", "maxCandidates", 999), 50);
});

test("maxCandidates is fixed: out of the tunables and refused as a proposal", () => {
  // Absent from the keys the model is offered or may set.
  assert.ok(!PARAM_KEYS.includes("maxCandidates"));
  assert.ok(!RUNTIME_KEYS.includes("maxCandidates"));
  // A proposal that changes it is refused...
  assert.match(
    validateOverride("params.momentum", '{"maxCandidates":6}'),
    /fixed parameter/,
  );
  assert.match(
    validateOverride("runtime", '{"maxCandidates":6}'),
    /fixed parameter/,
  );
  // ...but a stored override still parses, so other values are not lost.
  assert.equal(
    validateParams("params.momentum", { maxCandidates: 6, riskPct: 1 }),
    null,
  );
});

test("strategy is a tunable enum of the pool", () => {
  assert.ok(PARAM_KEYS.includes("strategy"));
  assert.equal(
    validateParams("params.trend", { strategy: "mean_reversion" }),
    null,
  );
  assert.match(validateParams("params.trend", { strategy: "nope" }), /one of/);
});

test("a pinned bot's strategy cannot be proposed", () => {
  assert.match(
    validateOverride("params.breakout", '{"strategy":"breakout_retest"}'),
    /strategy is fixed/,
  );
  assert.match(
    validateOverride("params.momentum", '{"strategy":"mean_reversion"}'),
    /strategy is fixed/,
  );
  // trend is not pinned.
  assert.equal(
    validateOverride("params.trend", '{"strategy":"mean_reversion"}'),
    null,
  );
});
