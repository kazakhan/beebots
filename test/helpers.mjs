import { readFileSync } from "node:fs";
import { scryptSync } from "node:crypto";
export function config() {
  const c = JSON.parse(
    readFileSync(new URL("../config.example.json", import.meta.url), "utf8"),
  );
  c.auth.passwordHash =
    "0123456789abcdef0123456789abcdef:" +
    scryptSync(
      "local-test-password",
      "0123456789abcdef0123456789abcdef",
      64,
    ).toString("hex");
  c.model = {
    baseUrl: "http://127.0.0.1:9999/v1",
    name: "fixture",
    allowNoKey: true,
  };
  for (const b of Object.values(c.bots)) b.capital = "100";
  // A Coinbase credential source is required by config validation; tests never
  // reach the exchange, so a placeholder absolute path is enough.
  c.coinbaseKeyFile = "/tmp/beebots-test-coinbase-key.json";
  delete c.coinbaseApiKeyName;
  delete c.coinbaseApiKeySecret;
  // Strategy-focused tests run the three strategy bots. Control-arm tests add
  // the fourth bot explicitly with addControl(), so its randomness never leaks
  // into unrelated assertions.
  delete c.bots.control;
  return c;
}
// Enable the control arm on a config, paper by default.
export function addControl(c, overrides = {}) {
  c.bots.control = {
    name: "Dice",
    capital: "100",
    paper: true,
    maxPositions: 3,
    tradeFraction: 0.9,
    stopPct: 3,
    trailActivationPct: 4,
    trailPct: 2,
    maxHoldHours: 24,
    riskPct: 1,
    maxCostRisk: 0.4,
    intervalMs: 60000,
    ...overrides,
  };
  return c;
}
export function arm(store) {
  store.change((s) => {
    s.paused = false;
  });
}
// Open a buy on any product. Reserve carries a small buffer, as the engine does.
export function buy(
  store,
  bot = "breakout",
  size = "50",
  product = "BTC-USDC",
) {
  return store.reserve({
    bot,
    side: "BUY",
    product,
    size: String(size),
    reserve: (Number(size) * 1.02).toFixed(8),
    reason: "test",
    stopPct: 3,
    trailPct: 2,
    trailActivationPct: 4,
    maxHoldHours: 24,
  });
}
export function exchangeOrder(order, overrides = {}) {
  return {
    order_id: "exchange-" + order.id,
    client_order_id: order.id,
    product_id: order.product,
    side: order.side,
    status: "FILLED",
    settled: true,
    filled_size: "0.001",
    filled_value: "50",
    total_fees: "0.5",
    ...overrides,
  };
}
