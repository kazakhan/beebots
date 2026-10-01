import {
  openSync,
  readFileSync,
  writeFileSync,
  closeSync,
  unlinkSync,
} from "node:fs";
export function acquireLock(path) {
  const take = () => {
    const fd = openSync(path, "wx", 0o600);
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
  };
  try {
    take();
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    const pid = Number(readFileSync(path, "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0)
      throw Error("Invalid runtime lock; owner review required");
    let dead = false;
    try {
      process.kill(pid, 0);
    } catch (e) {
      if (e.code === "ESRCH") dead = true;
      else throw Error("Cannot establish lock owner status");
    }
    if (!dead) throw Error("Another runtime owns this ledger");
    // Confirm the dead owner has not been replaced before reclaiming.
    if (readFileSync(path, "utf8") !== String(pid))
      throw Error("Runtime lock changed");
    unlinkSync(path);
    take();
  }
  return () => {
    if (readFileSync(path, "utf8") === String(process.pid)) unlinkSync(path);
  };
}
