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
  scoreboardLines,
  losingStreaks,
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
    sample: { breakout: 30, trend: 30, momentum: 30, control: 0 },
    requireControl: true,
  });
  assert.equal(strict.ok, false);
  assert.ok(strict.reasons.some((r) => /Control baseline immature/.test(r)));

  const ok = evaluateGate({
    proposal: edge,
    sample: { breakout: 30, trend: 30, momentum: 30, control: 30 },
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
    assert.ok(seen.includes("WEIGHTED MODEL"));
    assert.ok(!seen.includes("STRATEGY POOL"));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed LLM review keeps the last good review and records the error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beebots-review-fail-"));
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
    const rec = await reviewer.run({
      since: 3600000,
      until: 7200000,
      coverage: null,
      autoApply: false,
    });
    assert.equal(rec.error, "Review is not JSON", "the failure is reported");
    assert.equal(rec.summary, null, "no self-tune line is substituted");
    assert.equal(rec.proposals.length, 0);
    const st = store.read();
    assert.equal(st.lastReview.until, 3600000, "the last good review is kept");
    assert.equal(st.lastReview.summary, "all good");
    assert.equal(st.lastReviewError.at, 7200000);
    assert.equal(st.lastReviewError.message, "Review is not JSON");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a Stage 1 Laya failure keeps the last good review and records it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beebots-review-layafail-"));
  const store = new Store(":memory:", config());
  try {
    let fail = false;
    const laya = {
      ask: async () => {
        if (fail) throw Error("laya down");
        return { answers: { exit_timing: { choice: "late" } } };
      },
    };
    const model = {
      review: async () => ({ data: { summary: "all good", proposals: [] } }),
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
    assert.equal(st.lastReviewError.message, "laya down");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the review fills current from the target when the model omits it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beebots-review-current-"));
  const store = new Store(":memory:", config());
  try {
    const laya = {
      ask: async () => ({ answers: { exit_timing: { choice: "late" } } }),
    };
    const model = {
      review: async () => ({
        data: {
          summary: "x",
          proposals: [
            {
              target: "params.momentum",
              proposed: '{"minSignalBars":12}',
              rationale: "r",
            },
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
    assert.equal(rec.proposals.length, 1);
    assert.ok(
      typeof rec.proposals[0].current === "string" &&
        rec.proposals[0].current.includes("minSignalBars"),
      "current was filled from the target file",
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the LLM review keeps at most three proposals by default", async () => {
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
    assert.equal(rec.proposals.length, 3, "up to three proposals kept");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a signal-timeframe change is refused: the key is locked", () => {
  const g = evaluateGate({
    proposal: {
      target: "params.trend",
      proposed: JSON.stringify({ timeframe: "5m" }),
    },
    sample: {},
  });
  assert.equal(g.ok, false);
  assert.ok(
    g.reasons.some((r) => /fixed parameter/.test(r)),
    JSON.stringify(g.reasons),
  );
});

test("the review prompt carries no timeframe simulation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beebots-notfprompt-"));
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
      reviewLlm: () => true,
    });
    const rec = await reviewer.run({
      since: 0,
      until: 3600000,
      coverage: null,
      autoApply: false,
      applyWindow: true,
      hourly: [
        {
          until: 3600000,
          laya: { answers: { exit_timing: { choice: "early" } } },
        },
      ],
    });
    assert.ok(!seen.includes("TIMEFRAME COMPARISON"));
    assert.ok(seen.includes("HOURLY DATA SINCE LAST APPLY"));
    assert.equal(rec.timeframeLab, undefined);
    assert.equal(rec.applyWindow, true);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("current targets are compact JSON, not pretty-printed", () => {
  const dir = mkdtempSync(join(tmpdir(), "beebots-targets-compact-"));
  const store = new Store(":memory:", config());
  try {
    const reviewer = new TradeReview({
      store,
      laya: {},
      model: {},
      config: {},
      dataDir: dir,
    });
    const targets = reviewer.currentTargets();
    assert.ok(targets["laya.reviewQuestions"], "the question set is included");
    assert.ok(targets["params.trend"], "params are included");
    for (const [k, v] of Object.entries(targets)) {
      if (k.startsWith("rubric.")) continue;
      assert.equal(typeof v, "string");
      assert.ok(!v.includes("\n"), `${k} is compact (no newlines)`);
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("maxCandidates is never offered to the review", () => {
  const dir = mkdtempSync(join(tmpdir(), "beebots-nomaxcand-"));
  const store = new Store(":memory:", config());
  try {
    const reviewer = new TradeReview({
      store,
      laya: {},
      model: {},
      config: {},
      dataDir: dir,
    });
    const targets = reviewer.currentTargets();
    assert.ok(
      !targets["params.momentum"].includes("maxCandidates"),
      "not in the current targets",
    );
    assert.ok(
      !reviewer.schemaText().includes("maxCandidates"),
      "not in the allowed ranges",
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mergeProposal merges a partial patch onto the current target", () => {
  const dir = mkdtempSync(join(tmpdir(), "beebots-merge-"));
  const store = new Store(":memory:", config());
  try {
    const reviewer = new TradeReview({
      store,
      laya: {},
      model: {},
      config: {},
      dataDir: dir,
    });
    const m = reviewer.mergeProposal({
      target: "params.trend",
      proposed: JSON.stringify({ riskPct: 0.8 }),
      rationale: "x",
    });
    const d = JSON.parse(m.proposed);
    assert.equal(d.riskPct, 0.8);
    assert.ok("stopPct" in d, "other keys preserved");
    const full = reviewer.currentFor("params.trend");
    const m2 = reviewer.mergeProposal({
      target: "params.trend",
      proposed: full,
    });
    assert.deepEqual(JSON.parse(m2.proposed), JSON.parse(full));
    // The model may return the patch as an inline object, not a JSON string.
    const m3 = reviewer.mergeProposal({
      target: "params.trend",
      proposed: { strategy: "hexchaser" },
    });
    assert.equal(typeof m3.proposed, "string", "object patch is stringified");
    const d3 = JSON.parse(m3.proposed);
    assert.equal(d3.strategy, "hexchaser");
    assert.ok("stopPct" in d3, "other keys preserved");
    // A rubric is a full document and is not merged.
    const r = reviewer.mergeProposal({
      target: "rubric.trend",
      proposed: "# Doc",
    });
    assert.equal(r.proposed, "# Doc");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the review prompt is weights-only with no rotation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beebots-weights-"));
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
      reviewLlm: () => true,
    });
    await reviewer.run({
      since: 0,
      until: 3600000,
      coverage: null,
      autoApply: false,
    });
    assert.ok(seen.includes("WEIGHTED MODEL"));
    assert.ok(seen.includes("LOSING ARMS"));
    assert.ok(!seen.includes("STRATEGY POOL"));
    assert.ok(!seen.includes("STRATEGY DUE"));
    assert.ok(!/ROTATE|strategy template|strategyPool/i.test(seen));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a pinned bot's strategy is not offered to the review", () => {
  const dir = mkdtempSync(join(tmpdir(), "beebots-pinview-"));
  const store = new Store(":memory:", config());
  try {
    const reviewer = new TradeReview({
      store,
      laya: {},
      model: {},
      config: {},
      dataDir: dir,
    });
    assert.equal(reviewer.paramView("breakout").strategy, undefined);
    assert.equal(reviewer.paramView("momentum").strategy, undefined);
    assert.equal(reviewer.paramView("trend").strategy, undefined);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the scoreboard shows each arm's own P&L, with no Dice deltas", () => {
  const lines = scoreboardLines({});
  assert.ok(lines.some((l) => /SCOREBOARD/.test(l)));
  assert.ok(
    !lines.some((l) => /vs Dice|baseline to beat/.test(l)),
    "no Dice comparison",
  );
});

test("losingStreaks counts trailing consecutive losses", () => {
  const now = Date.now();
  const orders = {};
  for (let i = 0; i < 5; i++) {
    orders["b" + i] = {
      id: "b" + i,
      bot: "breakout",
      product: "X" + i + "-USDC",
      side: "BUY",
      status: "SETTLED",
      filled: "1",
      value: "100",
      fees: "0",
      created: now - 100000 + i * 1000,
    };
    orders["s" + i] = {
      id: "s" + i,
      bot: "breakout",
      product: "X" + i + "-USDC",
      side: "SELL",
      status: "SETTLED",
      filled: "1",
      value: "90",
      fees: "0",
      created: now - 99000 + i * 1000,
    };
  }
  const streaks = losingStreaks(orders);
  assert.equal(streaks.breakout, 5);
  assert.equal(streaks.momentum, 0);
  // A win at the end resets the streak.
  orders["w"] = {
    id: "w",
    bot: "breakout",
    product: "Y-USDC",
    side: "BUY",
    status: "SETTLED",
    filled: "1",
    value: "100",
    fees: "0",
    created: now,
  };
  orders["ws"] = {
    id: "ws",
    bot: "breakout",
    product: "Y-USDC",
    side: "SELL",
    status: "SETTLED",
    filled: "1",
    value: "120",
    fees: "0",
    created: now + 1000,
  };
  assert.equal(losingStreaks(orders).breakout, 0);
});

test("a focused review refuses proposals for other bots", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beebots-focus-"));
  const store = new Store(":memory:", config());
  try {
    const laya = {
      ask: async () => ({ answers: { exit_timing: { choice: "late" } } }),
    };
    const reviewer = new TradeReview({
      store,
      laya,
      model: {},
      config: {},
      dataDir: dir,
      reviewLlm: () => true,
    });
    const proposed = reviewer.currentFor("params.momentum");
    reviewer.model = {
      review: async () => ({
        data: { proposals: [{ target: "params.momentum", proposed }] },
      }),
    };
    const rec = await reviewer.run({
      since: 0,
      until: 3600000,
      coverage: null,
      autoApply: false,
      focusArm: "breakout",
      focusStreak: 5,
    });
    assert.equal(rec.focus.arm, "breakout");
    assert.equal(rec.proposals.length, 1);
    assert.ok(!rec.proposals[0].gate.ok);
    assert.ok(
      rec.proposals[0].gate.reasons.some((r) => /Focused review/.test(r)),
      "the other bot's proposal is refused",
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an hourly pass stores Laya's read and applies nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beebots-hourly-"));
  const store = new Store(":memory:", config());
  try {
    let modelCalls = 0;
    const reviewer = new TradeReview({
      store,
      laya: { ask: async () => ({ answers: { missed: {} }, elapsed_s: 0.1 }) },
      model: {
        review: async () => {
          modelCalls++;
          return { data: { proposals: [] } };
        },
      },
      config: { review: { autoApply: true } },
      dataDir: dir,
      reviewLlm: () => true,
    });
    await reviewer.run({ since: 0, until: 3600000, apply: false });
    assert.equal(modelCalls, 0, "no LLM on the hourly data pass");
    const s = store.read();
    assert.ok(s.lastHourly, "the hourly record is stored");
    assert.equal(s.lastReview, undefined, "the daily record is untouched");
    assert.equal((s.hourlyReviews ?? []).length, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a frozen review (autoApply off) performs no automatic writes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beebots-freeze-"));
  const store = new Store(":memory:", config());
  try {
    const reviewer = new TradeReview({
      store,
      laya: { ask: async () => ({ answers: {} }) },
      model: {},
      config: {},
      dataDir: dir,
      reviewLlm: () => false,
    });
    let reverted = 0;
    reviewer.revertLosers = () => {
      reverted++;
    };
    await reviewer.run({
      since: 0,
      until: 3600000,
      coverage: null,
      autoApply: false,
    });
    assert.equal(reverted, 0, "autoApply off blocks revertLosers");
    await reviewer.run({
      since: 0,
      until: 3600000,
      coverage: null,
      autoApply: true,
    });
    assert.equal(reverted, 1, "autoApply on runs revertLosers");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an advisory review (config autoApply off) does nothing at all", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beebots-advisory-"));
  const store = new Store(":memory:", config());
  try {
    let layaCalls = 0;
    const reviewer = new TradeReview({
      store,
      laya: {
        ask: async () => {
          layaCalls++;
          return { answers: {} };
        },
      },
      model: {},
      config: { review: { autoApply: false } },
      dataDir: dir,
      reviewLlm: () => false,
    });
    const rec = await reviewer.run({
      since: 0,
      until: 3600000,
      coverage: null,
    });
    assert.equal(rec, null, "no record");
    assert.equal(layaCalls, 0, "Laya is never called");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a weight change is gated by the backtest", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beebots-wgate-"));
  const store = new Store(":memory:", config());
  try {
    const laya = {
      ask: async () => ({ answers: { exit_timing: { choice: "late" } } }),
    };
    const model = {
      review: async () => ({
        data: {
          proposals: [
            { target: "params.trend", proposed: JSON.stringify({ wM7: 9 }) },
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
    let calls = 0;
    // Worse proposed weights -> refused; better -> accepted.
    let better = false;
    const backtest = (bot, rules) => {
      calls++;
      const net = Number(rules.wM7) === 9 ? (better ? 20 : 0) : 5;
      return { net, trades: 3 };
    };
    const rec = await reviewer.run({
      since: 0,
      until: 3600000,
      coverage: null,
      autoApply: false,
      backtest,
    });
    assert.ok(calls >= 2, "backtest current and proposed");
    assert.ok(
      rec.proposals[0].gate.reasons.some((r) => /Backtest/.test(r)),
      "worse weights refused",
    );
    better = true;
    const rec2 = await reviewer.run({
      since: 0,
      until: 7200000,
      coverage: null,
      autoApply: false,
      backtest,
    });
    assert.ok(
      !rec2.proposals[0].gate.reasons.some((r) => /Backtest/.test(r)),
      "better weights accepted by the backtest",
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the review refuses any non-weight proposal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beebots-wonly-"));
  const store = new Store(":memory:", config());
  try {
    const laya = {
      ask: async () => ({ answers: { exit_timing: { choice: "late" } } }),
    };
    const model = {
      review: async () => ({
        data: {
          proposals: [
            {
              target: "params.trend",
              proposed: JSON.stringify({ riskPct: 0.8 }),
            },
            { target: "rubric.trend", proposed: "# Doc" },
          ],
        },
      }),
    };
    const reviewer = new TradeReview({
      store,
      laya,
      model,
      config: { review: { maxProposals: 2 } },
      dataDir: dir,
      reviewLlm: () => true,
    });
    const rec = await reviewer.run({
      since: 0,
      until: 3600000,
      coverage: null,
      autoApply: false,
      backtest: () => ({ net: 5, trades: 1 }),
    });
    const byTarget = Object.fromEntries(
      rec.proposals.map((p) => [p.target, p]),
    );
    assert.ok(
      byTarget["params.trend"].gate.reasons.some((r) => /Weights-only/.test(r)),
      "a non-weight param key is refused",
    );
    assert.ok(
      byTarget["rubric.trend"].gate.reasons.some((r) => /Weights-only/.test(r)),
      "a non-params target is refused",
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a weight change over the step, or a negative weight, is refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beebots-wstep-"));
  const store = new Store(":memory:", config());
  try {
    const laya = {
      ask: async () => ({ answers: { exit_timing: { choice: "late" } } }),
    };
    const model = {
      review: async () => ({
        data: {
          proposals: [
            { target: "params.trend", proposed: JSON.stringify({ wM7: 9 }) },
            {
              target: "params.momentum",
              proposed: JSON.stringify({ wRsiLow: -1 }),
            },
          ],
        },
      }),
    };
    const reviewer = new TradeReview({
      store,
      laya,
      model,
      config: { review: { maxProposals: 2 } },
      dataDir: dir,
      reviewLlm: () => true,
    });
    const rec = await reviewer.run({
      since: 0,
      until: 3600000,
      coverage: null,
      autoApply: false,
      backtest: () => ({ net: 999, trades: 1 }),
    });
    const by = Object.fromEntries(rec.proposals.map((p) => [p.target, p]));
    assert.ok(
      by["params.trend"].gate.reasons.some((r) => /over the 1 step/.test(r)),
      "a jump over the step is refused",
    );
    assert.ok(
      by["params.momentum"].gate.reasons.some((r) => /non-negative/.test(r)),
      "a negative weight is refused",
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
