import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.mjs";
import { Store } from "./store.mjs";
import { Coinbase } from "./coinbase.mjs";
import { Market } from "./market.mjs";
import { UniverseMarket } from "./collector.mjs";
import { Laya } from "./laya.mjs";
import { DecisionModel } from "./model.mjs";
import { Settings } from "./settings.mjs";
import { TradeReview } from "./review.mjs";
import { Engine } from "./engine.mjs";
import { createServer } from "./server.mjs";
import { acquireLock } from "./lock.mjs";
const config = loadConfig(
  process.env.BEEBOTS_CONFIG || "/etc/beebots/config.json",
);
mkdirSync(config.dataDir, { recursive: true, mode: 0o750 });
const lock = join(config.dataDir, "runtime.lock");
const releaseLock = acquireLock(lock);
let store, server, engine, pruneTimer;
try {
  store = new Store(join(config.dataDir, "beebots.sqlite"), config);
  // Market telemetry is bulky and unbounded: on the live ledger it reached
  // 283 MB of 291 MB. Retire it hourly and reclaim space once, at startup.
  // Decision/order/fill/veto/control/system/status/error rows are never pruned.
  const pruned = store.pruneEvents();
  pruneTimer = setInterval(() => {
    try {
      store.pruneEvents();
    } catch {
      // Pruning is housekeeping; it must never take the runtime down.
    }
  }, 3600000);
  pruneTimer.unref?.();
  console.log(
    JSON.stringify({
      service: "beebots",
      event: "prune",
      removed: pruned,
      vacuumOnStart: config.maintenance?.vacuumOnStart === true,
    }),
  );
  const exchange = new Coinbase(config),
    market =
      config.strategyVersion === 2
        ? new UniverseMarket(exchange, config)
        : new Market(exchange, config.products);
  // Dashboard-managed provider/model/key. Absent file, the owner's config block
  // and model.env apply unchanged.
  const settings = new Settings({
    dataDir: config.dataDir,
    fallback: config.model,
  });
  const laya = new Laya(config.layaSocket, config.layaTimeoutMs);
  const model = new DecisionModel(config.model, config.modelTimeoutMs, settings);
  // Hourly self-assessment. Runs on the wall clock; see Engine.scheduleReview.
  const reviewer = new TradeReview({
    store,
    laya,
    model,
    config,
    dataDir: config.dataDir,
  });
  engine = new Engine({
    config,
    store,
    exchange,
    market,
    laya,
    model,
    settings,
    review: reviewer,
  });
  server = createServer({ config, engine, store, settings });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.bind, resolve);
  });
  // Reclaiming disk with VACUUM is synchronous and blocks the event loop, so the
  // proxy would 503 for the duration. It is therefore NOT automatic; opt in with
  // maintenance.vacuumOnStart, or run `npm run vacuum` with the service stopped.
  if (config.maintenance?.vacuumOnStart === true)
    console.log(
      JSON.stringify({
        service: "beebots",
        event: "vacuum",
        done: store.vacuumIfLarge(0),
      }),
    );
  await engine.start();
  console.log(
    JSON.stringify({
      service: "beebots",
      mode: config.mode,
      port: config.port,
      model: engine.modelInfo(),
    }),
  );
} catch (e) {
  server?.close();
  store?.close();
  releaseLock();
  throw e;
}
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  engine.stop();
  clearInterval(pruneTimer);
  server.closeStreams();
  server.close();
  while (engine.busy || engine.protectBusy)
    await new Promise((r) => setTimeout(r, 100));
  await engine.executing;
  await engine.market.stop?.();
  store.close();
  releaseLock();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
