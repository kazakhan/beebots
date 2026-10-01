// Deployment verification only: authenticated reads and a Laya ping; never orders.
import { loadConfig, IDS } from "./config.mjs";
import { Coinbase } from "./coinbase.mjs";
import { Laya } from "./laya.mjs";
const c = loadConfig(process.env.BEEBOTS_CONFIG || "/etc/beebots/config.json");
const exchange = new Coinbase(c);
const ping = await new Laya(c.layaSocket, c.layaTimeoutMs).ping();
const accounts = await exchange.accounts();
const fees = await exchange.fees();
const portfolios = [
  ...new Set(
    accounts.accounts.map((a) => a.retail_portfolio_id).filter(Boolean),
  ),
];
console.log(
  JSON.stringify(
    {
      laya: ping,
      accountCount: accounts.accounts.length,
      portfolios,
      configuredPortfolio: c.coinbasePortfolioId,
      allocations: Object.fromEntries(
        IDS.map((id) => [id, c.bots[id].capital]),
      ),
      takerFeeRate: fees.fee_tier?.taker_fee_rate,
    },
    null,
    2,
  ),
);
