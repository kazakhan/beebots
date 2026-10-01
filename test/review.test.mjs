import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.mjs";
import { config, buy, exchangeOrder } from "./helpers.mjs";
import {
  TradeReview,
  evaluateGate,
  protectedInvariantsHold,
  targetAllowed,
  closedTrades,
  buildHourState,
  MIN_SAMPLE,
  REVIEW_QUESTIONS,
} from "../src/review.mjs";

const SAFE_RUBRIC =
  "Scout v2. Only BUY an eligible, non-extended setup. Laya is uncalibrated " +
  "evidence, not a decision or probability. Code controls size and execution " +
  "cost. Do not alter the initial stop. Never force a trade. No shorts.";

test("protected invariants are required in every proposed rubric", () => {
  assert.equal(protectedInvariantsHold(SAFE_RUBRIC), true);
  // Each clause removed in turn must be refused - an LLM can otherwise strip a
  // safety instruction while looking like an improvement.
  for (const drop of [
    /No shorts\.?/,
    /Laya is uncalibrated evidence, not a decision or probability\./,
    /Code controls size and execution cost\./,
    /Do not alter the initial stop\./,
    /Never force a trade\./,
  ]) {
    const stripped = SAFE_RUBRIC.replace(drop, "").trim();
    assert.equal(protectedInvariantsHold(stripped), false, `without ${drop}`);
  }
  assert.equal(protectedInvariantsHold(""), false);
  assert.equal(protectedInvariantsHold(null), false);
});

test("only prose targets are accepted", () => {
  for (const t of [
    "laya.questions",
    "laya.fields",
    "rubric.breakout",
    "rubric.trend",
    "rubric.momentum",
  ])
    assert.equal(targetAllowed(t), true, t);
  // Numeric risk, capital, mode and code are out of scope by construction.
  for (const t of [
    "riskPct",
    "stopPct",
    "config.model",
    "src/engine.mjs",
    "rubric.control",
    "control.paper",
    "",
    null,
  ])
    assert.equal(targetAllowed(t), false, String(t));
});

test("the gate refuses below the minimum sample, whatever the proposal", () => {
  const proposal = {
    target: "rubric.breakout",
    proposed: SAFE_RUBRIC,
    rationale: "x",
  };
  const thin = evaluateGate({
    proposal,
    sample: { breakout: 1, trend: 2, momentum: 9, control: 4 },
  });
  assert.equal(thin.ok, false);
  assert.ok(thin.reasons.some((r) => /Insufficient sample/.test(r)));
  assert.ok(thin.reasons.some((r) => r.includes(String(MIN_SAMPLE))));
});

test("the gate refuses an out-of-scope target and a dropped invariant", () => {
  const enough = {
    breakout: MIN_SAMPLE,
    trend: MIN_SAMPLE,
    momentum: MIN_SAMPLE,
    control: MIN_SAMPLE,
  };
  const bad = evaluateGate({
    proposal: { target: "riskPct", proposed: SAFE_RUBRIC },
    sample: enough,
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.reasons.some((r) => /out of scope/.test(r)));

  const unsafe = evaluateGate({
    proposal: { target: "rubric.breakout", proposed: "Buy things. No stops." },
    sample: enough,
  });
  assert.equal(unsafe.ok, false);
  assert.ok(unsafe.reasons.some((r) => /safety clause/.test(r)));
});

test("the gate opens only when sample and invariants are both satisfied", () => {
  const enough = {
    breakout: MIN_SAMPLE,
    trend: MIN_SAMPLE,
    momentum: MIN_SAMPLE,
    control: MIN_SAMPLE,
  };
  const ok = evaluateGate({
    proposal: {
      target: "rubric.breakout",
      proposed: SAFE_RUBRIC,
      rationale: "x",
    },
    sample: enough,
  });
  assert.equal(ok.ok, true, JSON.stringify(ok.reasons));
  assert.deepEqual(ok.reasons, []);
});

test("closed round-trips are counted per bot for the sample", () => {
  const s = new Store(":memory:", config());
  s.change((st) => {
    st.paused = false;
  });
  const a = buy(s);
  s.acknowledge(a.id, "exchange-" + a.id);
  s.applyOrder(a.id, exchangeOrder(a));
  const sell = s.reserve({
    bot: "breakout",
    product: "BTC-USDC",
    side: "SELL",
    size: "0.001",
    reason: "exit",
  });
  s.acknowledge(sell.id, "exchange-" + sell.id);
  s.applyOrder(
    sell.id,
    exchangeOrder(sell, {
      side: "SELL",
      filled_size: "0.001",
      filled_value: "50",
    }),
  );
  const counts = closedTrades(s.read().orders);
  assert.equal(counts.breakout, 1);
  s.close();
});

test("the hour state carries the decisions, Laya labels and rejections as text", () => {
  const now = Date.now();
  const text = buildHourState({
    since: now - 3600000,
    until: now,
    events: [
      {
        ts: now - 1000,
        kind: "decision",
        bot: "breakout",
        action: "SKIP",
        reason: "no setup",
      },
      {
        ts: now - 900,
        kind: "analysis",
        bot: "breakout",
        product: "SHIB-USDC",
        answers: {
          regime: { choice: "range" },
          fit: { score: 1.2 },
          quality: { choice: "mixed" },
        },
      },
      {
        ts: now - 100,
        kind: "decision",
        bot: "trend",
        action: "BUY",
        reason: "too old to include?",
        product: "X",
      },
    ],
    orders: {},
    coverage: {
      total: 410,
      eligible: 392,
      ready: 200,
      scout: 26,
      bots: {
        breakout: {
          evaluated: 26,
          eligible: 0,
          shortlist: [
            {
              product: "SHIB-USDC",
              eligible: false,
              reasons: ["Range not compressed"],
            },
          ],
        },
      },
    },
  });
  assert.match(text, /DECISIONS \(2\)/);
  assert.match(text, /SHIB-USDC/);
  assert.match(text, /Range not compressed/);
  assert.match(text, /LAYA LABELS/);
});

test("the question set is four classified heads, not free text", () => {
  const heads = Object.keys(REVIEW_QUESTIONS);
  assert.deepEqual(heads.sort(), [
    "evidence_quality",
    "exit_timing",
    "failing_rubric",
    "missed_opportunity",
  ]);
  for (const [name, q] of Object.entries(REVIEW_QUESTIONS)) {
    assert.ok(["noul", "choice", "score"].includes(q.type), name);
    assert.ok(typeof q.instructions === "string" && q.instructions.length > 20);
  }
});

test("an applied proposal writes an override under the data dir and reverts", () => {
  const dir = mkdtempSync(join(tmpdir(), "beebots-review-"));
  const store = new Store(":memory:", config());
  try {
    const reviewer = new TradeReview({
      store,
      laya: {},
      model: {},
      config: {},
      dataDir: dir,
    });
    const target = "rubric.breakout";
    const res = reviewer.apply({
      target,
      proposed: SAFE_RUBRIC,
      rationale: "test",
    });
    assert.ok(existsSync(res.path), "override written");
    assert.equal(readFileSync(res.path, "utf8"), SAFE_RUBRIC);
    // The engine's rubric reader prefers the override.
    assert.equal(reviewer.rubric("breakout", "bundled"), SAFE_RUBRIC);
    // An audit event records the change.
    assert.ok(
      store.recent(10).some((e) => e.kind === "change" && e.target === target),
    );
    // Revert restores the bundled text (empty override) and audits it.
    assert.equal(reviewer.revert(target), true);
    assert.ok(store.recent(10).some((e) => e.kind === "change"));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("apply refuses an out-of-scope target or a dropped invariant", () => {
  const dir = mkdtempSync(join(tmpdir(), "beebots-review2-"));
  const store = new Store(":memory:", config());
  try {
    const reviewer = new TradeReview({
      store,
      laya: {},
      model: {},
      config: {},
      dataDir: dir,
    });
    assert.throws(
      () => reviewer.apply({ target: "riskPct", proposed: SAFE_RUBRIC }),
      /out of scope/,
    );
    assert.throws(
      () => reviewer.apply({ target: "rubric.trend", proposed: "just buy" }),
      /safety clause/,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
