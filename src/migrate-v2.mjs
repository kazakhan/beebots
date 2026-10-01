import { defaults } from "./strategy-v2.mjs";
export function migrateConfig(original) {
  const c = structuredClone(original);
  c.strategyVersion = 2;
  c.model.maxCallsPerDay ??= 1000;
  c.scanner = { workers: 4, assetOverrides: {}, ...c.scanner };
  c.marketIntervalMs = 1000;
  c.decisionIntervalMs = 10000;
  delete c.products;
  for (const [id, r] of Object.entries(c.bots)) {
    delete r.minPeriodTurnover;
    delete r.min24hTurnover;
    delete r.maxSpreadBps;
    c.bots[id] = { ...r, ...defaults[id], tradeFraction: 0.9 };
  }
  return c;
}
