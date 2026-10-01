// One-off maintenance: clear a stuck PAPER control arm.
//
// The control arm can accumulate simulated positions whose market is no longer
// tradeable. A paper arm never touches the exchange, but an unquotable holding
// cannot be closed even in simulation (the fill needs a price), so it strands
// the arm and leaves its equity unmarked. This returns each open position's
// cost to the arm's cash and clears the book.
//
// It refuses to run on a real control arm, and refuses while the runtime owns
// the ledger (stop the service first):
//
//   systemctl stop beebots
//   BEEBOTS_CONFIG=/etc/beebots/config.json npm run reset-control
//   systemctl start beebots
import { join } from "node:path";
import { loadConfig, CONTROL_ID } from "./config.mjs";
import { Store } from "./store.mjs";
import { acquireLock } from "./lock.mjs";
import { resetControl } from "./control-reset.mjs";

const config = loadConfig(
  process.env.BEEBOTS_CONFIG || "/etc/beebots/config.json",
);
const bot = config.bots?.[CONTROL_ID];
if (!bot) throw Error(`No ${CONTROL_ID} arm is configured`);
if (bot.paper !== true)
  throw Error(
    `Refusing: the ${CONTROL_ID} arm is real (paper !== true). Clear its positions by hand.`,
  );

// The lock is the same one the runtime holds, so this also refuses to run while
// the service is up.
const release = acquireLock(join(config.dataDir, "runtime.lock"));
let store;
try {
  store = new Store(join(config.dataDir, "beebots.sqlite"), config);
  const r = resetControl(store);
  console.log(JSON.stringify({ service: "reset-control", ...r }));
} finally {
  store?.close();
  release();
}
