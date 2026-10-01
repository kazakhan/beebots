import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Laya } from "../src/laya.mjs";

test("queue depth extends bounded inference deadline and congestion avoids submission", async () => {
  const l = new Laya("unused", 1000);
  let seen;
  l.ping = async () => ({ ok: true, ready: true, queue_depth: 2 });
  l.request = async (body, deadline) => {
    seen = deadline;
    return {
      answers: {
        fit: { score: 1 },
        regime: { choice: "range" },
        quality: { choice: "mixed" },
      },
    };
  };
  await l.analyze({}, "trend");
  assert.equal(seen, 3000);
  l.ping = async () => ({ ok: true, ready: true, queue_depth: 9 });
  seen = null;
  await assert.rejects(l.analyze({}, "trend"), /congested/);
  assert.equal(seen, null);
});
async function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), "laya-"));
  const path =
    process.platform === "win32"
      ? `\\\\.\\pipe\\laya-${randomUUID()}`
      : join(dir, "socket");
  const sockets = new Set();
  const server = net.createServer((s) => {
    sockets.add(s);
    s.on("error", () => {});
    s.on("close", () => sockets.delete(s));
    fn(s);
  });
  await new Promise((r) => server.listen(path, r));
  return {
    path,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
      rmSync(dir, { recursive: true });
    },
  };
}
test("handles fragmented newline response", async () => {
  const f = await fixture((s) =>
    s.on("data", () => {
      s.write('{"ok":true,');
      setTimeout(() => s.end('"ready":true}\n'), 10);
    }),
  );
  try {
    assert.equal((await new Laya(f.path, 500).ping()).ready, true);
  } finally {
    await f.close();
  }
});
test("bounds total wait even when socket remains open", async () => {
  const f = await fixture(() => {});
  try {
    await assert.rejects(new Laya(f.path, 40).ping(), /deadline/);
  } finally {
    await f.close();
  }
});
test("errors and incomplete lines rejected", async () => {
  const f = await fixture((s) =>
    s.on("data", () => s.end('{"ok":false,"error":"bad"}\n')),
  );
  try {
    await assert.rejects(new Laya(f.path, 500).ping());
  } finally {
    await f.close();
  }
});
test("analysis serializes callers and returns uncalibrated scores", async () => {
  let active = 0,
    max = 0;
  const f = await fixture((s) =>
    s.on("data", (data) => {
      if (JSON.parse(data).ping) {
        s.end('{"ok":true,"ready":true}\n');
        return;
      }
      active++;
      max = Math.max(max, active);
      setTimeout(() => {
        active--;
        s.end(
          JSON.stringify({
            ok: true,
            answers: {
              fit: { score: 1.2 },
              regime: { choice: "uptrend" },
              quality: { choice: "complete" },
            },
            queue_depth: 2,
            elapsed_s: 0.4,
          }) + "\n",
        );
      }, 10);
    }),
  );
  try {
    const l = new Laya(f.path, 500);
    const results = await Promise.all([
      l.analyze({}, "trend"),
      l.analyze({}, "breakout"),
    ]);
    assert.equal(max, 1);
    assert.equal(results[0].calibrated, false);
    assert.equal(results[0].queue_depth, 2);
  } finally {
    await f.close();
  }
});
