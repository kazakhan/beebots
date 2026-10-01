import test from "node:test";
import assert from "node:assert/strict";
import { availableAmount, dec } from "../src/decimal.mjs";
import { Engine } from "../src/engine.mjs";

test("Coinbase balance precision is conservatively reduced without floating point", async () => {
  const raw = "306.335523648141718718854";
  assert.equal(availableAmount(raw), "306.335523648141718718");
  assert.equal(availableAmount("0.000000000000000000999"), "0");
  assert.equal(
    availableAmount("1.999999999999999999999"),
    "1.999999999999999999",
  );
  assert.equal(availableAmount("87.90"), "87.9");
  const e = {
    exchange: {
      accounts: async () => ({
        accounts: [
          {
            currency: "USDC",
            available_balance: { currency: "USDC", value: raw },
          },
        ],
      }),
    },
  };
  assert.deepEqual(await Engine.prototype.accounts.call(e), {
    USDC: "306.335523648141718718",
  });
});

test("balance conversion rejects malformed or negative amounts; ledger parser stays exact", () => {
  for (const value of [
    null,
    undefined,
    3,
    "NaN",
    "Infinity",
    "1e3",
    "-0.0000000000000000001",
    "1.2x",
    "",
    " 1",
    "1.",
  ])
    assert.throws(() => availableAmount(value), /Invalid account balance/);
  assert.throws(() => dec("1.1234567890123456789"), /Invalid decimal/);
});
