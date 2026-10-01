import { loadConfig } from "./config.mjs";
const c = loadConfig(process.env.BEEBOTS_CONFIG || "/etc/beebots/config.json");
console.log(
  JSON.stringify({
    valid: true,
    mode: c.mode,
    products:
      c.strategyVersion === 2 ? "automatic USDC discovery" : c.products.length,
    allocations: Object.fromEntries(
      Object.entries(c.bots).map(([id, b]) => [id, b.capital]),
    ),
  }),
);
