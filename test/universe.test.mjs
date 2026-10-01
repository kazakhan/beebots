import test from "node:test";
import assert from "node:assert/strict";
import { discover } from "../src/universe.mjs";

const product = (over = {}) => ({
  product_id: "AAA-USDC",
  product_type: "SPOT",
  quote_currency_id: "USDC",
  base_currency_id: "AAA",
  base_name: "Aaa",
  status: "online",
  base_increment: "0.01",
  quote_increment: "0.01",
  base_min_size: "1",
  quote_min_size: "1",
  ...over,
});

test("a listed product with missing sizing metadata is not tradeable", () => {
  // Coinbase returns USDC products that are online but carry no usable lot or
  // precision, so no order can be placed against them. They must not enter the
  // discovered universe: assertTradable enforces the same fields at submit time.
  const rows = discover([
    product(),
    product({
      product_id: "BBB-USDC",
      base_currency_id: "BBB",
      base_name: "Bbb",
      base_min_size: "0",
    }),
    product({
      product_id: "CCC-USDC",
      base_currency_id: "CCC",
      base_name: "Ccc",
      quote_min_size: "",
    }),
  ]);
  const byId = Object.fromEntries(rows.map((r) => [r.product, r]));
  assert.equal(byId["AAA-USDC"].eligible, true);
  assert.equal(byId["BBB-USDC"].eligible, false);
  assert.match(byId["BBB-USDC"].reason, /Sizing metadata missing/);
  assert.equal(byId["CCC-USDC"].eligible, false);
  assert.match(byId["CCC-USDC"].reason, /Sizing metadata missing/);
});

test("an unavailable product is excluded before the sizing check", () => {
  const rows = discover([
    product({
      product_id: "DDD-USDC",
      base_currency_id: "DDD",
      base_name: "Ddd",
      status: "offline",
      base_min_size: "0",
    }),
  ]);
  assert.equal(rows[0].eligible, false);
  assert.match(rows[0].reason, /Unavailable/);
});
