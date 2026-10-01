import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.mjs";
import { config, addControl } from "./helpers.mjs";
import { resetControl } from "../src/control-reset.mjs";

function fixture() {
  const c = addControl(config(), { paper: true });
  const s = new Store(":memory:", c);
  return { c, s };
}

test("resetting a paper control refunds positions at cost and empties the book", () => {
  const { s } = fixture();
  try {
    s.change((st) => {
      st.bots.control.cash = "40";
      st.bots.control.reserved = "5";
      st.bots.control.positions = [
        { product: "A-USDC", quantity: "1", cost: "30", opened: Date.now() },
        { product: "B-USDC", quantity: "2", cost: "30", opened: Date.now() },
      ];
    });
    const r = resetControl(s);
    assert.equal(r.cleared, 2);
    assert.equal(s.read().bots.control.positions.length, 0);
    assert.equal(s.read().bots.control.reserved, "0");
    // 40 in cash + the 60 refunded at cost, no equity invented or destroyed.
    assert.equal(s.read().bots.control.cash, "100");
  } finally {
    s.close();
  }
});

test("resetting a clean control arm is a no-op", () => {
  const { s } = fixture();
  try {
    const r = resetControl(s);
    assert.equal(r.cleared, 0);
    assert.equal(s.read().bots.control.cash, "100");
  } finally {
    s.close();
  }
});
