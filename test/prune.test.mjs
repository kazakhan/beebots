import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.mjs";
import { config } from "./helpers.mjs";

test("pruning drops old analyses after a week but keeps decisions", () => {
  const s = new Store(":memory:", config());
  try {
    const now = Date.now();
    const old = now - 8 * 86400000;
    const recent = now - 3600000;
    const ins = s.db.prepare("INSERT INTO events(ts,kind,body) VALUES(?,?,?)");
    ins.run(old, "analysis", "{}");
    ins.run(old, "market", "{}");
    ins.run(old, "decision", "{}");
    ins.run(recent, "analysis", "{}");
    const removed = s.pruneEvents({ now });
    assert.ok(removed >= 2, "old analysis and market removed");
    const rows = s.db.prepare("SELECT kind, ts FROM events").all();
    assert.ok(
      !rows.some((r) => r.kind === "analysis" && r.ts === old),
      "old analysis gone",
    );
    assert.ok(
      rows.some((r) => r.kind === "analysis" && r.ts === recent),
      "recent analysis kept",
    );
    assert.ok(
      rows.some((r) => r.kind === "decision" && r.ts === old),
      "decision kept",
    );
  } finally {
    s.close();
  }
});
