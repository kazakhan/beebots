import test from "node:test";
import assert from "node:assert/strict";
import { executionPlan } from "../src/strategy-v2.mjs";
import { Refusal, isRefusal, refuse } from "../src/refusal.mjs";

test("isRefusal recognises a Refusal and nothing else", () => {
  assert.equal(isRefusal(refuse("nope")), true);
  assert.equal(isRefusal(new Refusal("nope")), true);
  assert.equal(isRefusal(new Error("boom")), false);
  assert.equal(isRefusal(null), false);
  assert.equal(isRefusal("string"), false);
});

test("executionPlan refusals are marked as refusals, not faults", () => {
  // A book too thin to fill the sized order makes walk() refuse.
  const q = {
    ask: 100,
    bid: 99,
    asks: [{ price: "100", size: "0.0001" }],
    bids: [{ price: "99", size: "0.0001" }],
  };
  const f = { stopPrice: 99.9 };
  const rules = { riskPct: 1, tradeFraction: 0.9, maxCostRisk: 0.4 };
  assert.throws(
    () => executionPlan(f, q, 100, 0.001, rules),
    (e) => isRefusal(e),
  );
});
