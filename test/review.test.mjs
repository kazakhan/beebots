import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  writeFileSync,
} from "node:fs";
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
  closedRoundTrips,
  layaPerformance,
  buildHourState,
  tierOf,
  MIN_SAMPLE,
  REVIEW_QUESTIONS,
} from "../src/review.mjs";
import { validateOverride, overridePath } from "../src/overrides.mjs";
import { defaultAnalysisQuestions } from "../src/laya.mjs";

const SAFE_RUBRIC =
  "# Scout v2 — speculative consolidation breakout\n\n" +
  "Only BUY an eligible, non-extended setup. Classify false-breakout and " +
  "exhaustion evidence. Laya is uncalibrated evidence, not a decision or " +
  "probability. Code controls size and execution cost. Do not alter the initial " +
  "stop or risk sizing. Never force a trade and no shorts are permitted. " +
  "Position size is determined by code. Use the supplied stop and depth checks.";

test("protected invariants are required in every proposed rubric", () => {
  assert.equal(protectedInvariantsHold(SAFE_RUBRIC), true);
  for (const drop of [
    /No shorts\.?/i,
    /Laya is uncalibrated evidence, not a decision or probability\./i,
    /Code controls size and execution cost\./i,
    /Do not alter the initial stop/i,
    /Never force a trade/i,
  ]) {
    const stripped = SAFE_RUBRIC.replace(drop, "").trim();
    assert.equal(protectedInvariantsHold(stripped), false, `without ${drop}`);
  }
});

test("only prose targets are accepted; laya.fields is gone", () => {
  for (const t of [
    "laya.reviewQuestions",
    "laya.analysisQuestions",
    "rubric.breakout",
    "rubric.trend",
    "rubric.momentum",
  ])
    assert.equal(targetAllowed(t), true, t);
  for (const t of [
    "laya.fields",
    "riskPct",
    "stopPct",
    "src/engine.mjs",
    "rubric.control",
    "",
    null,
  ])
    assert.equal(targetAllowed(t), false, String(t));
});

test("a fragment is refused; a full rubric and a valid question set are accepted", () => {
  assert.match(
    validateOverride(
      "rubric.breakout",
      "setupEligible should only test structure",
      {
        invariantsHold: protectedInvariantsHold,
      },
    ),
    /full document with a heading/,
  );
  assert.match(
    validateOverride(
      "rubric.breakout",
      "# T\nNo shorts. Laya is uncalibrated evidence, not a decision or probability. Code controls size. Do not alter the stop. Never force a trade.",
      {
        invariantsHold: protectedInvariantsHold,
      },
    ),
    /too short/,
  );
  assert.equal(
    validateOverride("rubric.breakout", SAFE_RUBRIC, {
      invariantsHold: protectedInvariantsHold,
    }),
    null,
  );
  assert.equal(
    validateOverride("laya.reviewQuestions", JSON.stringify(REVIEW_QUESTIONS)),
    null,
  );
  assert.equal(
    validateOverride(
      "laya.analysisQuestions",
      JSON.stringify(defaultAnalysisQuestions("breakout")),
    ),
    null,
  );
  // A question set missing a head is refused.
  const broken = { ...REVIEW_QUESTIONS };
  delete broken.laya_value;
  assert.match(
    validateOverride("laya.reviewQuestions", JSON.stringify(broken)),
    /laya_value/,
  );
});

test("structural changes are ungated; edge changes need the arm and a control", () => {
  const structural = {
    target: "laya.reviewQuestions",
    proposed: JSON.stringify(REVIEW_QUESTIONS),
  };
  const g0 = evaluateGate({ proposal: structural, sample: {} });
  assert.equal(g0.ok, true, JSON.stringify(g0.reasons));
  assert.equal(g0.tier, "structural");

  const edge = { target: "rubric.breakout", proposed: SAFE_RUBRIC };
  const thin = evaluateGate({
    proposal: edge,
    sample: { breakout: 1, trend: 3, momentum: 11, control: 0 },
  });
  assert.equal(thin.ok, false);
  assert.ok(thin.reasons.some((r) => /Insufficient sample/.test(r)));
  // The control is the objective, not a hard gate by default (fast loop).
  assert.ok(!thin.reasons.some((r) => /Control baseline immature/.test(r)));

  const strict = evaluateGate({
    proposal: edge,
    sample: { breakout: 10, trend: 10, momentum: 10, control: 0 },
    requireControl: true,
  });
  assert.equal(strict.ok, false);
  assert.ok(strict.reasons.some((r) => /Control baseline immature/.test(r)));

  const ok = evaluateGate({
    proposal: edge,
    sample: { breakout: 10, trend: 10, momentum: 10, control: 10 },
  });
  assert.equal(ok.ok, true, JSON.stringify(ok.reasons));
  assert.equal(ok.tier, "edge");
});

test("the control pins only edge changes, not structural ones", () => {
  assert.equal(tierOf("laya.reviewQuestions"), "structural");
  assert.equal(tierOf("laya.analysisQuestions"), "edge");
  assert.equal(tierOf("rubric.trend"), "edge");
});

test("closed round-trips are counted and reconstructed with their outcome", () => {
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
  assert.equal(closedTrades(s.read().orders).breakout, 1);
  const trip = closedRoundTrips(s.read().orders).breakout[0];
  assert.equal(trip.product, "BTC-USDC");
  assert.equal(typeof trip.pnl, "bigint");
  s.close();
});

test("Laya performance joins entry fit to outcome", () => {
  const now = Date.now();
  const events = [
    {
      ts: now - 1000,
      kind: "analysis",
      bot: "momentum",
      product: "PUMP-USDC",
      answers: {
        regime: { choice: "uptrend" },
        fit: { score: 1.8 },
        quality: { choice: "complete" },
      },
    },
    {
      ts: now - 900,
      kind: "analysis",
      bot: "trend",
      product: "BONK-USDC",
      answers: {
        regime: { choice: "range" },
        fit: { score: 0.5 },
        quality: { choice: "mixed" },
      },
    },
  ];
  // A winning PUMP trade opened after the high-fit analysis.
  const orders = {
    b1: {
      id: "b1",
      bot: "momentum",
      product: "PUMP-USDC",
      side: "BUY",
      filled: "100",
      value: "100",
      fees: "1",
      created: now - 800,
    },
    s1: {
      id: "s1",
      bot: "momentum",
      product: "PUMP-USDC",
      side: "SELL",
      filled: "100",
      value: "120",
      fees: "1",
      created: now - 100,
    },
  };
  const p = layaPerformance({ events, orders, since: now - 5000 });
  assert.equal(p.analyses, 2);
  assert.equal(p.regime.uptrend, 1);
  assert.equal(p.regime.range, 1);
  assert.equal(p.fit.high.n, 1);
  assert.equal(p.fit.high.wins, 1);
  assert.ok(p.fit.high.pnl > 0);
  assert.equal(p.fit.low.n, 0, "the low-fit product had no trade");
});

test("the hour state carries a Laya performance section", () => {
  const now = Date.now();
  const text = buildHourState({
    since: now - 3600000,
    until: now,
    events: [
      {
        ts: now - 1000,
        kind: "analysis",
        bot: "momentum",
        product: "PUMP-USDC",
        answers: {
          regime: { choice: "uptrend" },
          fit: { score: 1.8 },
          quality: { choice: "complete" },
        },
      },
    ],
    orders: {},
    coverage: null,
  });
  assert.match(text, /LAYA PERFORMANCE/);
  assert.match(text, /regime: uptrend:1/);
});

test("an applied proposal writes an override and reverts", () => {
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
    const res = reviewer.apply({
      target: "rubric.breakout",
      proposed: SAFE_RUBRIC,
      rationale: "test",
    });
    assert.ok(existsSync(res.path));
    assert.equal(readFileSync(res.path, "utf8"), SAFE_RUBRIC);
    assert.equal(reviewer.rubric("breakout", "bundled"), SAFE_RUBRIC);
    assert.ok(
      store
        .recent(10)
        .some(
          (e) =>
            e.kind === "change" &&
            e.target === "rubric.breakout" &&
            e.tier === "edge",
        ),
    );
    assert.equal(reviewer.revert("rubric.breakout"), true);
    assert.equal(reviewer.rubric("breakout", "bundled"), "bundled");
    // A feedback-corrupt override is ignored at read time.
    writeFileSync(overridePath(dir, "rubric.trend"), "not a rubric");
    assert.equal(reviewer.rubric("trend", "bundled-trend"), "not a rubric"); // raw read; engine validates shape elsewhere
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the review consumes an overridden review-question set", () => {
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
    assert.deepEqual(
      Object.keys(reviewer.reviewQuestions()).sort(),
      Object.keys(REVIEW_QUESTIONS).sort(),
    );
    const custom = {
      ...REVIEW_QUESTIONS,
      exit_timing: {
        ...REVIEW_QUESTIONS.exit_timing,
        instructions: "OVERRIDDEN INSTRUCTION TEXT FOR TESTING",
      },
    };
    reviewer.apply({
      target: "laya.reviewQuestions",
      proposed: JSON.stringify(custom),
      rationale: "t",
    });
    assert.match(
      reviewer.reviewQuestions().exit_timing.instructions,
      /OVERRIDDEN/,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("apply refuses an out-of-scope target or a dropped invariant", () => {
  const dir = mkdtempSync(join(tmpdir(), "beebots-review3-"));
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
      () =>
        reviewer.apply({
          target: "rubric.trend",
          proposed: "# T\njust buy things, no stops, no shorts noted nowhere",
        }),
      /full document|too short|safety clause/,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a numeric params proposal applies within bounds and reverts", () => {
  const dir = mkdtempSync(join(tmpdir(), "beebots-review-params-"));
  const store = new Store(":memory:", config());
  try {
    const reviewer = new TradeReview({
      store,
      laya: {},
      model: {},
      config: {},
      dataDir: dir,
    });
    reviewer.apply({
      target: "params.momentum",
      proposed: JSON.stringify({ rangeAtr: 9, minBreadth: 6 }),
      rationale: "tune",
    });
    assert.equal(reviewer.paramView("momentum").rangeAtr, 9);
    assert.equal(reviewer.paramView("momentum").minBreadth, 6);
    // An out-of-bounds value is refused before anything is written.
    assert.throws(
      () =>
        reviewer.apply({
          target: "params.momentum",
          proposed: JSON.stringify({ riskPct: 50 }),
          rationale: "bad",
        }),
      /riskPct must be between/,
    );
    assert.notEqual(reviewer.paramView("momentum").riskPct, 50);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("numeric targets are edge-tier and scored against their own arm", () => {
  const g = evaluateGate({
    proposal: {
      target: "params.trend",
      proposed: JSON.stringify({ maxExtensionAtr: 1 }),
    },
    sample: { trend: 1, breakout: 0, momentum: 0, control: 0 },
  });
  assert.equal(g.tier, "edge");
  assert.ok(
    g.reasons.some((r) =>
      /Insufficient sample: 1 closed trades on trend/.test(r),
    ),
  );
});

test("the hourly state is aggregated and bounded under load", () => {
  const since = 0,
    until = 3600000;
  const events = [];
  for (let i = 0; i < 900; i++)
    events.push({
      ts: i,
      kind: "analysis",
      bot: "momentum",
      product: "P" + i,
      answers: {
        regime: { choice: "uptrend" },
        fit: { score: 1.5 },
        quality: { choice: "complete" },
      },
    });
  for (let i = 0; i < 300; i++)
    events.push({
      ts: i,
      kind: "decision",
      bot: "breakout",
      action: "SKIP",
      reason: "x".repeat(50),
    });
  const state = buildHourState({
    events,
    orders: {},
    coverage: null,
    since,
    until,
  });
  assert.ok(state.split("\n").length < 500, "bounded line count");
  assert.match(state, /\(\+780 more labels\)/);
  assert.match(state, /\(\+100 more decisions\)/);
  assert.match(state, /momentum: regime uptrend:900/);
});

test("without an LLM the review self-tunes from Laya's answers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beebots-review-selftune-"));
  const store = new Store(":memory:", config());
  try {
    const laya = {
      ask: async () => ({
        answers: {
          primary_bottleneck: { choice: "momentum" },
          momentum_quality: { score: 0 },
        },
      }),
    };
    let modelCalls = 0;
    const model = {
      review: async () => {
        modelCalls++;
        return { data: {} };
      },
    };
    const reviewer = new TradeReview({
      store,
      laya,
      model,
      config: {},
      dataDir: dir,
      reviewLlm: () => false,
    });
    const rec = await reviewer.run({
      since: 0,
      until: 3600000,
      coverage: null,
      autoApply: false,
    });
    assert.equal(modelCalls, 0, "the LLM is not consulted");
    assert.ok(
      rec.proposals.some((p) => p.target === "params.momentum"),
      "a bounded self-tune proposal",
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("with an LLM the review sees Laya's verdict, not the raw hour", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beebots-review-llm-"));
  const store = new Store(":memory:", config());
  try {
    const laya = {
      ask: async () => ({ answers: { exit_timing: { choice: "late" } } }),
    };
    let seen = null;
    const model = {
      review: async (sys, user) => {
        seen = user;
        return { data: { proposals: [] } };
      },
    };
    const reviewer = new TradeReview({
      store,
      laya,
      model,
      config: {},
      dataDir: dir,
    });
    await reviewer.run({ since: 0, until: 3600000, coverage: null });
    assert.ok(seen.includes("LAYA'S REVIEW"), "Laya's verdict is supplied");
    assert.ok(!seen.includes("LAYA LABELS"), "the raw hour is not");
    assert.ok(
      seen.includes("APPLIED CHANGES"),
      "the change ledger is supplied",
    );
    assert.ok(seen.includes("CURRENT TARGETS"));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed LLM review keeps the last good one and records the error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beebots-review-fail-"));
  const store = new Store(":memory:", config());
  try {
    const laya = {
      ask: async () => ({ answers: { exit_timing: { choice: "late" } } }),
    };
    let fail = false;
    const model = {
      review: async () => {
        if (fail) throw Error("Review is not JSON");
        return { data: { summary: "all good", proposals: [] } };
      },
    };
    const reviewer = new TradeReview({
      store,
      laya,
      model,
      config: {},
      dataDir: dir,
      reviewLlm: () => true,
    });
    await reviewer.run({
      since: 0,
      until: 3600000,
      coverage: null,
      autoApply: false,
    });
    assert.equal(store.read().lastReview.summary, "all good");
    fail = true;
    await reviewer.run({
      since: 3600000,
      until: 7200000,
      coverage: null,
      autoApply: false,
    });
    const st = store.read();
    assert.equal(st.lastReview.until, 3600000, "kept the last good review");
    assert.equal(st.lastReview.summary, "all good");
    assert.equal(st.lastReviewError.at, 7200000);
    assert.equal(st.lastReviewError.message, "Review is not JSON");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the LLM review keeps at most one proposal by default", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beebots-review-cap-"));
  const store = new Store(":memory:", config());
  try {
    const laya = {
      ask: async () => ({ answers: { exit_timing: { choice: "late" } } }),
    };
    const model = {
      review: async () => ({
        data: {
          summary: "three ideas",
          proposals: [
            { target: "out.of.scope", current: "a", proposed: "b" },
            { target: "out.of.scope.two", current: "a", proposed: "b" },
            { target: "out.of.scope.three", current: "a", proposed: "b" },
          ],
        },
      }),
    };
    const reviewer = new TradeReview({
      store,
      laya,
      model,
      config: {},
      dataDir: dir,
      reviewLlm: () => true,
    });
    const rec = await reviewer.run({
      since: 0,
      until: 3600000,
      coverage: null,
      autoApply: false,
    });
    assert.equal(rec.proposals.length, 1, "one proposal kept by default");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
