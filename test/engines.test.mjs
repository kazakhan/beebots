import test from "node:test";
import assert from "node:assert/strict";
import {
  ENGINES,
  DEFAULT_ENGINE,
  isEngine,
  engineLabel,
  engineUses,
  engineDecides,
  engineCatalog,
  buildMenu,
  parseMove,
} from "../src/engines.mjs";

test("the engine catalogue is complete and ordered for the dashboard", () => {
  const ids = engineCatalog().map((e) => e.id);
  assert.deepEqual(ids, ["jev", "laya", "llm", "jev+llm", "laya+llm"]);
  assert.ok(isEngine(DEFAULT_ENGINE));
  assert.equal(engineLabel("jev+llm"), "Jev + LLM");
  // Every catalogue entry carries the flags the browser uses to shape the form.
  for (const e of engineCatalog())
    for (const k of ["jev", "laya", "llm"])
      assert.equal(typeof e[k], "boolean", `${e.id}.${k}`);
});

test("component usage matches the selection semantics", () => {
  assert.equal(engineUses("jev", "jev"), true);
  assert.equal(engineUses("jev", "llm"), false);
  assert.equal(engineUses("laya", "laya"), true);
  assert.equal(engineUses("llm", "llm"), true);
  assert.equal(engineUses("llm", "laya"), false);
  assert.equal(engineUses("jev+llm", "jev"), true);
  assert.equal(engineUses("jev+llm", "llm"), true);
  assert.equal(engineUses("laya+llm", "laya"), true);
  assert.equal(engineUses("laya+llm", "llm"), true);
  // Only the no-LLM engines make the final call themselves. The LLM engine's
  // decision comes from the LLM, not from a System One model.
  assert.equal(engineDecides("jev"), true);
  assert.equal(engineDecides("laya"), true);
  assert.equal(engineDecides("llm"), false);
  assert.equal(engineDecides("jev+llm"), false);
  assert.equal(engineDecides("laya+llm"), false);
  assert.equal(isEngine("nope"), false);
  assert.equal(engineUses("nope", "jev"), false);
  assert.equal(engineDecides("nope"), false);
  assert.ok(Object.hasOwn(ENGINES, DEFAULT_ENGINE));
});

test("the menu offers a buy per fresh product and sell/hold per held one", () => {
  const menu = buildMenu({
    candidates: [{ product: "BTC-USDC" }, { product: "ETH-USDC" }],
    positions: [],
    maxPositions: 2,
  });
  assert.deepEqual(Object.keys(menu).sort(), [
    "BUY BTC-USDC",
    "BUY ETH-USDC",
    "SKIP",
  ]);
  assert.equal(parseMove("BUY BTC-USDC").action, "BUY");
});

test("a held product yields SELL and HOLD and is never a BUY", () => {
  const menu = buildMenu({
    candidates: [{ product: "BTC-USDC", held: true }, { product: "ETH-USDC" }],
    positions: [{ product: "BTC-USDC" }],
    maxPositions: 3,
  });
  assert.ok(Object.hasOwn(menu, "SELL BTC-USDC"));
  assert.ok(Object.hasOwn(menu, "HOLD BTC-USDC"));
  assert.ok(!Object.hasOwn(menu, "BUY BTC-USDC"));
  assert.ok(Object.hasOwn(menu, "BUY ETH-USDC"));
  assert.ok(Object.hasOwn(menu, "SKIP"));
});

test("at the position limit only SKIP, SELL and HOLD remain", () => {
  const menu = buildMenu({
    candidates: [
      { product: "BTC-USDC", held: true },
      { product: "ETH-USDC", held: true },
      { product: "SOL-USDC" },
    ],
    positions: [{ product: "BTC-USDC" }, { product: "ETH-USDC" }],
    maxPositions: 2,
  });
  assert.ok(Object.hasOwn(menu, "SELL BTC-USDC"));
  assert.ok(Object.hasOwn(menu, "SELL ETH-USDC"));
  assert.ok(!Object.hasOwn(menu, "BUY SOL-USDC"));
  assert.ok(Object.hasOwn(menu, "SKIP"));
});

test("an empty candidate list still yields a SKIP move", () => {
  const menu = buildMenu({ candidates: [], positions: [] });
  assert.deepEqual(menu, { SKIP: "No trade this cycle" });
});

test("an off-menu or malformed choice is refused, not guessed at", () => {
  assert.deepEqual(parseMove("SKIP"), { action: "SKIP", product: null });
  assert.deepEqual(parseMove("BUY BTC-USDC"), {
    action: "BUY",
    product: "BTC-USDC",
  });
  assert.equal(parseMove("buy btc-usdc"), null);
  assert.equal(parseMove("FROBNICATE BTC-USDC"), null);
  assert.equal(parseMove("BUY"), null);
  assert.equal(parseMove(""), null);
  assert.equal(parseMove(null), null);
});

test("the menu offers BUY only for eligible candidates", () => {
  const menu = buildMenu({
    candidates: [
      { product: "AAA-USDC", setupEligible: true },
      { product: "BBB-USDC", setupEligible: false },
      { product: "CCC-USDC" },
    ],
    positions: [],
    maxPositions: 3,
  });
  assert.ok(Object.hasOwn(menu, "BUY AAA-USDC"), "eligible is offered");
  assert.ok(!Object.hasOwn(menu, "BUY BBB-USDC"), "near-miss is not offered");
  assert.ok(
    Object.hasOwn(menu, "BUY CCC-USDC"),
    "a candidate with no flag is offered",
  );
});

test("with an id the menu offers BUY only for entry-eligible candidates", () => {
  const base = {
    setupEligible: true,
    ask: 100,
    maxEntry: 101,
    stopPrice: 95,
    bid: 100.5,
    channelHigh: 99,
  };
  const eligible = { product: "AAA-USDC", ...base };
  const extended = { product: "BBB-USDC", ...base, ask: 102 };
  const lostChannel = { product: "CCC-USDC", ...base, bid: 98 };
  const menu = buildMenu({
    id: "breakout",
    candidates: [eligible, extended, lostChannel],
    positions: [],
    maxPositions: 3,
  });
  assert.ok(Object.hasOwn(menu, "BUY AAA-USDC"));
  assert.ok(!Object.hasOwn(menu, "BUY BBB-USDC"), "extended excluded");
  assert.ok(!Object.hasOwn(menu, "BUY CCC-USDC"), "lost channel excluded");
  assert.ok(Object.hasOwn(menu, "SKIP"));
});
