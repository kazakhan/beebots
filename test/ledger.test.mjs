import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.mjs";
import { dec, str, floorStep, mul } from "../src/decimal.mjs";
import { config, arm, buy, exchangeOrder } from "./helpers.mjs";
test("fixed point increments never overspend through rounding", () => {
  assert.equal(floorStep("0.123456789", "0.00000001"), "0.12345678");
  assert.equal(str(dec("0.1") + dec("0.2")), "0.3");
  assert.equal(mul("0.00000001", "85000"), "0.00085");
});
test("partial buys, restart and cumulative reconciliation are idempotent", () => {
  const dir = mkdtempSync(join(tmpdir(), "bee-ledger-"));
  const file = join(dir, "db");
  let s = new Store(file, config());
  arm(s);
  const o = buy(s);
  s.acknowledge(o.id, "exchange-" + o.id);
  s.applyOrder(
    o.id,
    exchangeOrder(o, {
      status: "OPEN",
      settled: false,
      filled_size: "0.0005",
      filled_value: "25",
      total_fees: "0.25",
    }),
  );
  assert.equal(s.read().bots.breakout.cash, "74.75");
  assert.equal(s.read().bots.breakout.reserved, "25.75");
  s.close();
  s = new Store(file, config());
  s.applyOrder(o.id, exchangeOrder(o));
  s.applyOrder(o.id, exchangeOrder(o));
  assert.equal(s.read().bots.breakout.cash, "49.5");
  assert.equal(s.read().bots.breakout.positions[0].quantity, "0.001");
  assert.equal(s.read().bots.breakout.reserved, "0");
  assert.equal(s.read().bots.breakout.trades, 1);
  s.close();
  rmSync(dir, { recursive: true });
});
test("bot ownership, overselling and unresolved orders enforced", () => {
  const s = new Store(":memory:", config());
  arm(s);
  const o = buy(s);
  assert.throws(() => buy(s), /unresolved/);
  assert.throws(
    () =>
      s.reserve({
        bot: "trend",
        side: "SELL",
        product: "BTC-USDC",
        size: "0.001",
      }),
    /unowned/,
  );
  s.acknowledge(o.id, "exchange-" + o.id);
  s.applyOrder(o.id, exchangeOrder(o));
  assert.throws(
    () =>
      s.reserve({
        bot: "breakout",
        side: "SELL",
        product: "BTC-USDC",
        size: "0.002",
      }),
    /unowned/,
  );
  s.close();
});
test("partial cancel accounts executed amount; no refund of spent cash", () => {
  const s = new Store(":memory:", config());
  arm(s);
  const o = buy(s);
  s.acknowledge(o.id, "exchange-" + o.id);
  s.applyOrder(
    o.id,
    exchangeOrder(o, {
      status: "CANCELLED",
      filled_size: "0.0004",
      filled_value: "20",
      total_fees: "0.2",
    }),
  );
  assert.equal(s.read().bots.breakout.cash, "79.8");
  assert.equal(s.read().bots.breakout.reserved, "0");
  s.close();
});
test("sell profit includes entry and exit fees without affecting another bot", () => {
  const s = new Store(":memory:", config());
  arm(s);
  const o = buy(s);
  s.acknowledge(o.id, "exchange-" + o.id);
  s.applyOrder(o.id, exchangeOrder(o));
  const sell = s.reserve({
    bot: "breakout",
    product: "BTC-USDC",
    side: "SELL",
    size: "0.001",
  });
  s.acknowledge(sell.id, "exchange-" + sell.id);
  s.applyOrder(
    sell.id,
    exchangeOrder(sell, { filled_value: "60", total_fees: "0.6" }),
  );
  const b = s.read().bots;
  assert.equal(b.breakout.cash, "108.9");
  assert.equal(b.breakout.realised, "8.9");
  assert.deepEqual(b.breakout.positions, []);
  assert.equal(b.trend.cash, "100");
  s.close();
});
test("mismatched order and regressed fill totals roll back atomically", () => {
  const s = new Store(":memory:", config());
  arm(s);
  const o = buy(s);
  s.acknowledge(o.id, "exchange-" + o.id);
  assert.throws(
    () => s.applyOrder(o.id, exchangeOrder(o, { client_order_id: "other" })),
    /identity/,
  );
  assert.equal(s.read().bots.breakout.cash, "100");
  s.applyOrder(o.id, exchangeOrder(o));
  assert.throws(
    () => s.applyOrder(o.id, exchangeOrder(o, { filled_size: "0.0001" })),
    /regressed/,
  );
  s.close();
});
test("unknown submissions remain reserved and no second order can be created", () => {
  const s = new Store(":memory:", config());
  arm(s);
  const o = buy(s);
  s.unknown(o.id);
  assert.equal(s.pending().length, 1);
  assert.equal(s.read().bots.breakout.reserved, "51");
  assert.throws(() => buy(s));
  s.close();
});
test("mark to market uses cash plus asset value; missing prices do not fabricate returns", () => {
  const s = new Store(":memory:", config());
  arm(s);
  const o = buy(s);
  s.acknowledge(o.id, "exchange-" + o.id);
  s.applyOrder(o.id, exchangeOrder(o));
  assert.equal(s.value({ "BTC-USDC": 60000 })[0].equity, 109.5);
  assert.equal(s.value({})[0].returnPct, null);
  s.close();
});
test("pause blocks buys but allows owned exits", () => {
  const s = new Store(":memory:", config());
  assert.throws(() => buy(s), /paused/);
  arm(s);
  const o = buy(s);
  s.acknowledge(o.id, "exchange-" + o.id);
  s.applyOrder(o.id, exchangeOrder(o));
  s.change((x) => {
    x.paused = true;
  });
  assert.doesNotThrow(() =>
    s.reserve({
      bot: "breakout",
      side: "SELL",
      product: "BTC-USDC",
      size: "0.001",
    }),
  );
  s.close();
});
