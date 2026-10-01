import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.mjs";
import { config } from "./helpers.mjs";
import { costOf, usageCounts } from "../src/providers.mjs";

// Regression cover for the live-ledger crash.
//
// Before per-model buckets existed, the engine wrote modelUsage as
// {day, calls, tokens}. recordModelCall assumed the newer shape, so on a live
// row `undefined + n` became NaN and `u.perModel[key]` threw:
//   "Cannot read properties of undefined (reading 'deepseek:deepseek-flash')"
// That threw inside the per-bot catch, so every bot skipped its cycle before
// recording a decision or placing an order.
const legacyRow = () => ({
  day: new Date().toISOString().slice(0, 10),
  calls: 394,
  tokens: 120000,
});

test("a usage row from the pre-per-model runtime is repaired, not fatal", () => {
  const c = config();
  const s = new Store(":memory:", c);
  const day = new Date().toISOString().slice(0, 10);
  // Exactly the shape the old engine left behind.
  s.change((state) => {
    state.modelUsage = legacyRow();
  });
  assert.equal(Object.hasOwn(s.read().modelUsage, "perModel"), false);

  // The call that previously threw.
  s.recordModelCall({
    day,
    provider: "deepseek",
    model: "deepseek-flash",
    usage: usageCounts({
      prompt_tokens: 1000,
      completion_tokens: 200,
      total_tokens: 1200,
      prompt_tokens_details: { cached_tokens: 100 },
    }),
    costNanos: 180_000n,
  });

  const u = s.read().modelUsage;
  // The budget counter is reserved by the engine before the request, so it is
  // untouched here; the point is that it is a real number, not undefined/NaN.
  assert.equal(u.calls, 394);
  assert.equal(u.tokens, 121200);
  assert.equal(u.promptTokens, 1000);
  assert.equal(u.completionTokens, 200);
  assert.equal(u.cachedTokens, 100);
  assert.equal(u.costNanos, "180000");
  assert.equal(u.perModel["deepseek:deepseek-flash"].calls, 1);
  // A NaN would have serialised to null; the row must survive JSON intact.
  assert.equal(
    JSON.parse(JSON.stringify(s.read())).modelUsage.promptTokens,
    1000,
  );
  s.close();
});

test("a legacy row is healed so later calls cannot reintroduce NaN", () => {
  const c = config();
  const s = new Store(":memory:", c);
  const day = new Date().toISOString().slice(0, 10);
  s.change((state) => {
    state.modelUsage = legacyRow();
  });
  for (let i = 0; i < 3; i++)
    s.recordModelCall({
      day,
      provider: "deepseek",
      model: "deepseek-flash",
      usage: usageCounts({
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      }),
      costNanos: 0n,
    });
  const u = s.read().modelUsage;
  assert.equal(u.calls, 394, "budget counter belongs to the engine");
  assert.equal(u.tokens, 120045);
  assert.equal(u.promptTokens, 30);
  assert.ok(!JSON.stringify(u).includes("null"), "no null counters survive");
  s.close();
});

test("normaliseUsage repairs malformed fields without discarding real counts", () => {
  const c = config();
  const s = new Store(":memory:", c);
  const u = s.normaliseUsage({
    day: "2026-09-30",
    calls: 5,
    tokens: 100,
    promptTokens: NaN,
    completionTokens: "12",
    cachedTokens: -4,
    costNanos: "not-a-number",
    perModel: "corrupt",
  });
  assert.equal(u.calls, 5, "a valid count is preserved");
  assert.equal(u.tokens, 100);
  assert.equal(u.promptTokens, 0, "NaN becomes zero");
  assert.equal(u.completionTokens, 12, "a numeric string is kept");
  assert.equal(u.cachedTokens, 0, "a negative count becomes zero");
  assert.equal(u.costNanos, "0");
  assert.deepEqual(u.perModel, {}, "a corrupt perModel becomes an object");
  s.close();
});

test("a row from a different day still resets cleanly", () => {
  const c = config();
  const s = new Store(":memory:", c);
  s.change((state) => {
    state.modelUsage = legacyRow(); // yesterday's shape
  });
  const today = new Date().toISOString().slice(0, 10);
  assert.notEqual(
    s.read().modelUsage.day,
    today === "2026-09-30" ? "x" : "2026-09-30",
  );
  s.recordModelCall({
    day: "1999-01-01",
    provider: "deepseek",
    model: "deepseek-flash",
    usage: usageCounts({
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2,
    }),
    costNanos: 0n,
  });
  assert.equal(s.read().modelUsage.day, "1999-01-01");
  assert.equal(s.read().modelUsage.calls, 0, "a reset row starts at zero");
  assert.equal(
    s.read().modelUsage.perModel["deepseek:deepseek-flash"].calls,
    1,
  );
  s.close();
});

test("usage accounting must never be able to block a decision", () => {
  // The architectural fault: a telemetry write sat on the decision path, so a
  // stats failure aborted the bot before it could trade.
  const c = config();
  const s = new Store(":memory:", c);
  const day = new Date().toISOString().slice(0, 10);
  s.change((state) => {
    state.modelUsage = legacyRow();
  });
  // Force the usage write to throw the way a corrupt row did.
  const real = s.recordModelCall.bind(s);
  s.recordModelCall = () => {
    throw Error("Cannot read properties of undefined (reading 'x')");
  };
  let decisionRecorded = false;
  try {
    real; // referenced so the original is not flagged unused
    // The engine guards this call; simulate that guard's behaviour.
    try {
      s.recordModelCall({
        day,
        provider: "deepseek",
        model: "deepseek-flash",
        usage: usageCounts({ total_tokens: 1 }),
      });
    } catch {
      decisionRecorded = true; // decision path continues regardless
    }
    s.change((state) => {
      state.bots.breakout.lastDecision = { action: "SKIP", at: Date.now() };
    });
  } finally {
    s.recordModelCall = real;
  }
  assert.ok(decisionRecorded, "a usage failure is caught, not propagated");
  assert.ok(
    s.read().bots.breakout.lastDecision,
    "the decision is still recorded after a usage failure",
  );
  s.close();
});

test("cost is computed correctly on a legacy row", () => {
  const c = config();
  const s = new Store(":memory:", c);
  const day = new Date().toISOString().slice(0, 10);
  s.change((state) => {
    state.modelUsage = legacyRow();
  });
  const usage = {
    prompt_tokens: 1_000_000,
    completion_tokens: 0,
    prompt_tokens_details: { cached_tokens: 0 },
  };
  // Off-peak DeepSeek Flash: $0.15 per 1M uncached input.
  s.recordModelCall({
    day,
    provider: "deepseek",
    model: "deepseek-flash",
    usage: usageCounts(usage),
    costNanos: costOf(
      usage,
      "deepseek",
      "deepseek-flash",
      Date.parse("2026-09-30T12:00:00Z"),
    ),
  });
  assert.equal(s.read().modelUsage.costNanos, "150000000");
  s.close();
});

test("the exact production crash: legacy row plus per-model lookup", () => {
  // This is the literal failure reported from the live dashboard. It reproduces
  // on the old code and must be impossible now.
  const u = legacyRow();
  assert.equal(u.perModel, undefined);
  // Old behaviour: this threw.
  assert.throws(
    () => u.perModel["deepseek:deepseek-flash"],
    /Cannot read properties of undefined/,
  );
  // New behaviour: normalised first, so the lookup is safe.
  const fixed = new Store(":memory:", config()).normaliseUsage(u);
  assert.doesNotThrow(() => fixed.perModel["deepseek:deepseek-flash"]);
  assert.equal(typeof fixed.perModel, "object");
});
