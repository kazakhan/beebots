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

test("analyzeBatch maps per-candidate answers from one request", async () => {
  const f = await fixture((s) =>
    s.on("data", (data) => {
      const req = JSON.parse(data);
      if (req.batch)
        s.write(
          JSON.stringify({
            ok: true,
            batch: req.batch.map(() => ({
              ok: true,
              answers: {
                fit: { score: 1 },
                regime: { choice: "range" },
                quality: { choice: "mixed" },
              },
              elapsed_s: 0.1,
            })),
            elapsed_s: 0.2,
            queue_depth: 2,
            batch_size: req.batch.length,
          }) + "\n",
        );
    }),
  );
  try {
    const r = await new Laya(f.path, 500).analyzeBatch(
      [{ product: "A" }, { product: "B" }],
      "trend",
    );
    assert.equal(r.results.length, 2);
    assert.equal(r.results[0].answers.fit.score, 1);
    assert.equal(r.batch_size, 2);
    assert.equal(r.queue_depth, 2);
  } finally {
    await f.close();
  }
});

test("analyzeBatch isolates a bad row without failing the batch", async () => {
  const f = await fixture((s) =>
    s.on("data", (data) => {
      const req = JSON.parse(data);
      if (req.batch)
        s.write(
          JSON.stringify({
            ok: true,
            batch: [
              {
                ok: true,
                answers: {
                  fit: { score: 1 },
                  regime: { choice: "range" },
                  quality: { choice: "mixed" },
                },
              },
              { ok: false, error: "bad row" },
            ],
            elapsed_s: 0.2,
            queue_depth: 1,
            batch_size: 2,
          }) + "\n",
        );
    }),
  );
  try {
    const r = await new Laya(f.path, 500).analyzeBatch(
      [{ product: "A" }, { product: "B" }],
      "trend",
    );
    assert.equal(r.results[0].answers.fit.score, 1);
    assert.equal(r.results[1].error, "bad row");
  } finally {
    await f.close();
  }
});

test("analyzeBatch chunks more than 32 candidates into multiple requests", async () => {
  let requests = 0;
  const f = await fixture((s) =>
    s.on("data", (data) => {
      const req = JSON.parse(data);
      if (req.batch) {
        requests++;
        s.write(
          JSON.stringify({
            ok: true,
            batch: req.batch.map(() => ({
              ok: true,
              answers: {
                fit: { score: 1 },
                regime: { choice: "range" },
                quality: { choice: "mixed" },
              },
            })),
            elapsed_s: 0.2,
            queue_depth: 1,
            batch_size: req.batch.length,
          }) + "\n",
        );
      }
    }),
  );
  try {
    const candidates = Array.from({ length: 40 }, (_, i) => ({
      product: "P" + i,
    }));
    const r = await new Laya(f.path, 500).analyzeBatch(candidates, "trend");
    assert.equal(r.results.length, 40);
    assert.equal(requests, 2, "40 candidates split into two <=32 requests");
    assert.ok(r.results.every((x) => x.answers?.fit?.score === 1));
  } finally {
    await f.close();
  }
});

test("request surfaces the daemon's error text", async () => {
  const f = await fixture((s) =>
    s.on("data", () =>
      s.write(
        JSON.stringify({ ok: false, error: "need state and questions" }) + "\n",
      ),
    ),
  );
  try {
    await assert.rejects(
      new Laya(f.path, 500).ping(),
      /need state and questions/,
    );
  } finally {
    await f.close();
  }
});

test("analyzeBatch falls back to serial for a chunk the daemon rejects", async () => {
  const f = await fixture((s) =>
    s.on("data", (data) => {
      const req = JSON.parse(data);
      if (req.ping)
        return s.write(
          JSON.stringify({ ok: true, ready: true, queue_depth: 0 }) + "\n",
        );
      if (req.batch)
        return s.write(JSON.stringify({ ok: false, error: "boom" }) + "\n");
      s.write(
        JSON.stringify({
          ok: true,
          answers: {
            fit: { score: 1 },
            regime: { choice: "range" },
            quality: { choice: "mixed" },
          },
          elapsed_s: 0.1,
        }) + "\n",
      );
    }),
  );
  try {
    const r = await new Laya(f.path, 500).analyzeBatch(
      [{ product: "A" }],
      "trend",
    );
    assert.equal(r.results.length, 1);
    assert.equal(r.results[0].answers.fit.score, 1);
  } finally {
    await f.close();
  }
});

test("batch is serialised behind other Laya calls", async () => {
  let active = 0,
    max = 0;
  const f = await fixture((s) =>
    s.on("data", (data) => {
      const req = JSON.parse(data);
      active++;
      max = Math.max(max, active);
      setTimeout(() => {
        if (req.ping)
          s.write(
            JSON.stringify({ ok: true, ready: true, queue_depth: 0 }) + "\n",
          );
        else if (req.batch)
          s.write(
            JSON.stringify({
              ok: true,
              batch: req.batch.map(() => ({
                ok: true,
                answers: {
                  fit: { score: 1 },
                  regime: { choice: "range" },
                  quality: { choice: "mixed" },
                },
              })),
            }) + "\n",
          );
        else
          s.write(
            JSON.stringify({
              ok: true,
              answers: {
                fit: { score: 1 },
                regime: { choice: "range" },
                quality: { choice: "mixed" },
              },
            }) + "\n",
          );
        active--;
      }, 30);
    }),
  );
  try {
    const l = new Laya(f.path, 2000);
    await Promise.all([
      l.analyze({ product: "A" }, "trend"),
      l.analyzeBatch([{ product: "B" }], "trend"),
    ]);
    assert.equal(max, 1, "no two Laya requests run at once");
  } finally {
    await f.close();
  }
});
