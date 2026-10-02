import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.mjs";
import { config } from "./helpers.mjs";
import { TradeReview } from "../src/review.mjs";
import { overridePath } from "../src/overrides.mjs";

// The loop decides reverts. There is no manual revert path; the LLM may revert
// its own change from the ledger, and in no-LLM mode Laya's controller does.
test("the LLM can revert one of its own applied changes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beebots-revert-"));
  const store = new Store(":memory:", config());
  try {
    const reviewer = new TradeReview({
      store,
      laya: { ask: async () => ({ answers: {} }) },
      model: {
        review: async () => ({
          data: {
            proposals: [
              { target: "params.momentum", revert: true, rationale: "losing" },
            ],
          },
        }),
      },
      config: {},
      dataDir: dir,
      engineId: () => "laya+llm",
    });
    // A prior applied change, tracked in the ledger.
    reviewer.apply({
      target: "params.momentum",
      proposed: JSON.stringify({ minBreadth: 4 }),
      rationale: "t",
    });
    reviewer.recordChange({ target: "params.momentum", rationale: "t" });
    assert.ok(existsSync(overridePath(dir, "params.momentum")));
    assert.equal(store.read().appliedChanges.length, 1);

    const rec = await reviewer.run({
      since: 0,
      until: 3600000,
      coverage: null,
    });
    const rp = rec.proposals.find((p) => p.revert);
    assert.ok(rp, "a revert proposal is recorded");
    assert.equal(rp.gate.tier, "revert");
    assert.ok(rp.applied, "the loop applied the revert");
    assert.ok(
      !existsSync(overridePath(dir, "params.momentum")),
      "the override is removed",
    );
    assert.equal(
      (store.read().appliedChanges ?? []).length,
      0,
      "the reverted change leaves the ledger",
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("with an LLM the deterministic revert controller does not run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beebots-norevert-"));
  const store = new Store(":memory:", config());
  try {
    const reviewer = new TradeReview({
      store,
      laya: { ask: async () => ({ answers: {} }) },
      model: { review: async () => ({ data: { proposals: [] } }) },
      config: {},
      dataDir: dir,
      engineId: () => "laya+llm",
    });
    let ran = 0;
    reviewer.revertLosers = () => {
      ran++;
    };
    await reviewer.run({ since: 0, until: 3600000, coverage: null });
    assert.equal(ran, 0, "the LLM decides, not the controller");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
