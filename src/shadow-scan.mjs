// Standalone read-only validation. Never imports Engine, Store or a live adapter.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Coinbase } from "./coinbase.mjs";
import { UniverseMarket } from "./collector.mjs";
import { migrateConfig } from "./migrate-v2.mjs";
const c = migrateConfig(
  JSON.parse(
    readFileSync(
      process.env.BEEBOTS_CONFIG || "/etc/beebots/config.json",
      "utf8",
    ),
  ),
);
c.mode = "observe";
c.liveAcknowledgement = "";
c.dataDir = process.env.BEEBOTS_SHADOW_DIR || "/var/lib/beebots-shadow-v2";
if (c.dataDir === "/var/lib/beebots")
  throw Error("Shadow data must be isolated");
const exchange = new Coinbase(c);
exchange.create = () => {
  throw Error("Read-only scanner cannot submit orders");
};
const market = new UniverseMarket(exchange, c);
const seconds = Number(process.env.SCAN_SECONDS || 600);
const began = Date.now();
let last = 0;
try {
  market.start();
  while (Date.now() - began < seconds * 1000) {
    if (Date.now() - last > 20000) {
      const v = market.coverage();
      console.log(
        JSON.stringify({
          elapsed: Math.round((Date.now() - began) / 1000),
          total: v.total,
          eligible: v.eligible,
          ready: v.ready,
          scout: v.scout,
          categories: v.categoryStatus,
          errors: market.failures.size,
          discoveryError: market.discoveryError,
        }),
      );
      last = Date.now();
      writeFileSync(
        join(c.dataDir, "coverage.json"),
        JSON.stringify(v, null, 2),
      );
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  const evidence = Object.fromEntries(
    ["breakout", "trend", "momentum"].map((id) => [id, market.snapshot(id)]),
  );
  writeFileSync(
    join(c.dataDir, "evidence.json"),
    JSON.stringify(evidence, null, 2),
  );
  console.log(
    JSON.stringify({
      final: true,
      bots: Object.fromEntries(
        Object.entries(evidence).map(([id, rows]) => [
          id,
          {
            evaluated: rows.length,
            eligible: rows.filter((r) => r.setupEligible).length,
          },
        ]),
      ),
    }),
  );
} finally {
  await market.stop();
}
