import test from "node:test";
import assert from "node:assert/strict";
import { paperFill } from "../src/engine.mjs";

// A paper order size is full precision since 3.0.2 (no exchange-increment
// rounding). A fill computed with Number/toFixed could round up above the
// requested size, which applyOrder halts on. These guard the exact-fixed-point
// fill: the reported value never exceeds the request.

test("a paper buy never reports a value above the requested quote size", () => {
  const order = {
    id: "o1",
    product: "X-USDC",
    side: "BUY",
    size: "89.123456789012345678",
  };
  const q = {
    ask: 0.0000001,
    bid: 0.00000009,
    asks: [{ price: "0.0000001" }],
    bids: [{ price: "0.00000009" }],
  };
  const r = paperFill(order, q, 0.001);
  assert.equal(r.filled_value, order.size);
  assert.ok(Number(r.filled_value) <= Number(order.size));
  assert.ok(Number(r.filled_size) > 0, "a positive base quantity");
});

test("the old round-up overshoot is gone", () => {
  // 13 decimals ending in 5: toFixed(12) used to round this up past the size.
  const size = "89.1234567890125";
  const order = { id: "o4", product: "X-USDC", side: "BUY", size };
  const q = {
    ask: 100,
    bid: 99,
    asks: [{ price: "100" }],
    bids: [{ price: "99" }],
  };
  const r = paperFill(order, q, "0.001");
  assert.equal(r.filled_value, size);
  assert.ok(Number(r.filled_value) <= Number(size));
});

test("a paper sell never reports more quantity than requested", () => {
  const order = {
    id: "o2",
    product: "X-USDC",
    side: "SELL",
    size: "0.123456789012345678",
  };
  const q = {
    ask: 100,
    bid: 99.9,
    asks: [{ price: "100" }],
    bids: [{ price: "99.9" }],
  };
  const r = paperFill(order, q, "0.001");
  assert.equal(r.filled_size, order.size);
  assert.ok(Number(r.filled_size) <= Number(order.size));
  assert.ok(Number(r.filled_value) > 0);
});

test("a sub-micro price does not throw on exponential notation", () => {
  const order = { id: "o3", product: "X-USDC", side: "BUY", size: "1" };
  const q = {
    ask: 1e-7,
    bid: 9e-8,
    asks: [{ price: "0.0000001" }],
    bids: [{ price: "0.00000009" }],
  };
  const r = paperFill(order, q, "0.001");
  assert.ok(Number(r.filled_size) > 0);
  assert.equal(r.filled_value, "1");
});
