// Manual database reclaim. VACUUM rewrites the whole file and blocks, which is
// why it is not run automatically on a live service. Stop beebots first:
//
//   sudo systemctl stop beebots
//   sudo -u beebots BEEBOTS_CONFIG=/etc/beebots/config.json \
//     /opt/beebots-runtime/node /var/www/example.com/beebots/releases/2.0.0/src/vacuum.mjs
//   sudo systemctl start beebots
//
// It also prunes stale market telemetry, so it is safe to run even when the
// file is already small.
import { DatabaseSync } from "node:sqlite";
import { statSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.mjs";

const config = loadConfig(
  process.env.BEEBOTS_CONFIG || "/etc/beebots/config.json",
);
const path = join(config.dataDir, "beebots.sqlite");
const before = statSync(path).size;
const db = new DatabaseSync(path);
db.exec("PRAGMA busy_timeout=5000");
const cutoff = Date.now() - 86400000;
const pruned = db
  .prepare("DELETE FROM events WHERE kind='market' AND ts < ?")
  .run(cutoff);
db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
db.exec("VACUUM");
db.close();
const after = statSync(path).size;
console.log(
  JSON.stringify({
    service: "beebots",
    event: "vacuum",
    removed: Number(pruned.changes ?? 0),
    bytesBefore: before,
    bytesAfter: after,
    reclaimed: before - after,
  }),
);
