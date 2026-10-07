// Isolated synthetic UI preview. Never imports Coinbase, Laya or the live engine.
import { Store } from "./store.mjs";
import { createServer } from "./server.mjs";
import { scryptSync } from "node:crypto";
const salt = "0123456789abcdef0123456789abcdef";
const config = {
  mode: "demo",
  bind: "127.0.0.1",
  port: Number(process.env.DEMO_PORT || 8790),
  basePath: "/beebots/",
  publicOrigin: "http://127.0.0.1:8790",
  auth: {
    username: "demo",
    passwordHash:
      salt + ":" + scryptSync("local-preview-only", salt, 64).toString("hex"),
  },
  bots: {
    breakout: {
      name: "Scout",
      capital: "100",
      maxPositions: 3,
      paper: true,
      riskPct: 1,
      tradeFraction: 0.9,
      maxCostRisk: 0.4,
      timeframe: "5m",
      cadenceMs: 300000,
      maxCandidates: 25,
      rangeAtr: 8,
      relativeVolume: 1.5,
      maxExtensionAtr: 3,
      categories: ["meme", "speculative", "unclassified"],
    },
    trend: {
      name: "Keeper",
      capital: "100",
      maxPositions: 3,
      paper: true,
      riskPct: 1,
      tradeFraction: 0.9,
      maxCostRisk: 0.2,
      timeframe: "15m",
      cadenceMs: 300000,
      maxCandidates: 25,
      pullbackBars: 3,
      maxExtensionAtr: 1,
    },
    momentum: {
      name: "Spark",
      capital: "100",
      maxPositions: 3,
      paper: true,
      riskPct: 1,
      tradeFraction: 0.9,
      maxCostRisk: 0.2,
      timeframe: "15m",
      cadenceMs: 300000,
      maxCandidates: 25,
      topFraction: 0.35,
      minBreadth: 5,
    },
    control: { name: "Dice", capital: "100", maxPositions: 3, paper: true },
  },
};
const store = new Store(":memory:", config);
store.change((s) => {
  s.bots.breakout.cash = "104.25";
  s.bots.breakout.realised = "4.25";
  s.bots.breakout.fees = "1.12";
  s.bots.breakout.trades = 3;
  s.bots.trend.cash = "20";
  // Two positions on one bot, so the preview exercises the multi-position list.
  s.bots.trend.positions = [
    { product: "ETH-USDC", quantity: "0.03", cost: "80" },
    { product: "SOL-USDC", quantity: "0.4", cost: "40" },
  ];
  s.bots.momentum.cash = "98.15";
  s.bots.momentum.realised = "-1.85";
  s.bots.control.cash = "101.4";
  s.bots.control.realised = "1.4";
  s.bots.control.trades = 4;
  s.bots.control.positions = [
    { product: "DOGE-USDC", quantity: "300", cost: "60" },
  ];
});
for (let i = 0; i < 45; i++)
  for (const [j, id] of Object.keys(config.bots).entries())
    store.db
      .prepare("INSERT INTO equity VALUES(?,?,?)")
      .run(
        Date.now() - (45 - i) * 60000,
        id,
        100 +
          Math.sin(i / 8 + j) * 2 +
          i * (j === 0 ? 0.1 : j === 1 ? 0.04 : -0.04),
      );
const engine = {
  snapshot: () => ({
    mode: "demo",
    strategyVersion: 2,
    // Matches the backend build the page expects, so the version-skew check does
    // not fire against the synthetic preview.
    build: "3.7.0",
    // Synthetic free-model fixture: proves the cost line and provider-driven
    // labels render without any provider connection.
    modelUsage: {
      day: new Date().toISOString().slice(0, 10),
      calls: 394,
      tokens: 1_284_400,
      promptTokens: 1_100_000,
      completionTokens: 184_400,
      cachedTokens: 96_000,
      costNanos: "0",
      perModel: {
        "zai:glm-4.7-flash": {
          provider: "zai",
          model: "glm-4.7-flash",
          calls: 394,
          tokens: 1_284_400,
          costNanos: "0",
        },
        "jev:jev-1.13.0": {
          provider: "jev",
          model: "jev-1.13.0",
          calls: 128,
          tokens: 51_200,
          costNanos: "2150400",
        },
      },
    },
    review: {
      since: Date.now() - 3600000,
      until: Date.now(),
      summary:
        "Two of three arms declined every setup on weak relative volume; the control arm's random entries were flat. No rubric change is justified on one hour.",
      observations: [
        {
          bot: "breakout",
          issue: "No eligible breakout close",
          evidence: "SHIB relVol 5.8x but compressionAtr 5.2",
        },
        {
          bot: "momentum",
          issue: "Two stops, both late",
          evidence: "exits after momentum had turned",
        },
      ],
      proposals: [
        {
          target: "rubric.breakout",
          current: "Only BUY an eligible, non-extended setup.",
          proposed:
            "Only BUY an eligible setup whose relative volume is at least twice the median and whose close is in the top half of its bar.",
          rationale: "Reduces weak-close breakouts.",
          risk: "May skip valid setups with quiet volume.",
          gate: {
            ok: false,
            tier: "edge",
            reasons: [
              "Insufficient sample: 1 closed trades on breakout, need 10",
              "Control baseline immature: 0/10 closed trades",
            ],
          },
          applied: false,
        },
      ],
      sample: { breakout: 1, trend: 2, momentum: 9, control: 0 },
      layaPerf: {
        analyses: 61,
        trips: 24,
        matched: 12,
        regime: { uptrend: 22, range: 30, downtrend: 9 },
        quality: { complete: 40, mixed: 18, insufficient: 3 },
        fit: {
          low: { n: 3, wins: 1, pnl: -2.4 },
          mid: { n: 5, wins: 2, pnl: -0.8 },
          high: { n: 4, wins: 3, pnl: 3.1 },
        },
      },
      laya: {
        answers: {
          missed_opportunity: { noul: 0.41 },
          exit_timing: { choice: "late" },
          failing_rubric: { choice: "momentum" },
          evidence_quality: { score: 1.5 },
          laya_value: { choice: "neutral" },
        },
        elapsed_s: 0.8,
      },
      error: null,
    },
    model: {
      provider: "zai",
      model: "glm-4.7-flash",
      label: "GLM-4.7-Flash (free)",
      cardTitle: "GLM-4.7-FLASH",
      free: true,
      hasKey: true,
      keyEnv: "BEEBOTS_MODEL_KEY",
      engine: "laya",
      engineLabel: "Laya",
      jevCapUsd: 2,
    },
    coverage: {
      total: 410,
      eligible: 392,
      ready: 200,
      scout: 26,
      categoryStatus: "Synthetic fixture",
      rows: [
        {
          product: "DOGE-USDC",
          category: "meme",
          source: "Synthetic fixture",
          eligible: true,
          ready: true,
          reason: null,
        },
      ],
      bots: {
        breakout: {
          evaluated: 26,
          eligible: 1,
          shortlist: [
            {
              product: "DOGE-USDC",
              eligible: true,
              reasons: [],
              relativeVolume: 2.5,
            },
          ],
        },
      },
    },
    paused: true,
    halt: null,
    bots: store.value({ "ETH-USDC": 2800, "SOL-USDC": 150 }),
    orders: [],
    health: { laya: { ready: true, queueDepth: 0 } },
    history: store.history(),
    rules: config.bots,
  }),
};
// The preview has no writable data directory, so it serves a fixed catalogue and
// reports the models the local provider would list. Writes are refused rather
// than pretending a selection was saved.
const DEMO_MODELS = {
  zai: ["glm-4.7-flash", "glm-4.5-flash", "glm-4.7", "glm-4.7-flashx"],
  deepseek: ["deepseek-flash", "deepseek-v4-pro"],
  ollama: ["deepscaler:latest", "ornith-1.5:9B"],
};
const demoSettings = {
  redacted: () => ({
    provider: "zai",
    model: "glm-4.7-flash",
    source: "demo",
    hasKey: true,
    keyHint: "…demo",
    keyEnv: "BEEBOTS_MODEL_KEY",
    apiKeyEnv: "BEEBOTS_MODEL_KEY",
    fallbackName: null,
    endpoint: null,
    defaultEndpoint: null,
    engine: "laya",
    engineLabel: "Laya",
    reviewLlm: true,
    jev: {
      model: "jev-1.13.0",
      modelDefault: "jev-1.13.0",
      hasKey: false,
      keyHint: null,
      keyEnv: "TYPESAFE_API_KEY",
    },
  }),
  key: () => "demo-key",
  engineValue: () => "laya",
  reviewLlm: () => true,
  effectiveJev: () => ({ model: "jev-1.13.0", key: null }),
  save: () => {
    throw Error("Settings cannot be changed in the synthetic preview");
  },
};
const server = createServer({
  config,
  store,
  engine,
  settings: demoSettings,
  // The preview must never make a real network call.
  listModelsFn: async ({ provider }) => ({
    models: (DEMO_MODELS[provider] ?? []).map((id) => ({ id, label: id })),
    source: "provider",
  }),
});
server.listen(config.port, config.bind, () =>
  console.log(
    `Synthetic preview: http://127.0.0.1:${config.port}/beebots/ (demo / local-preview-only)`,
  ),
);
let n = 0;
const timer = setInterval(() => {
  const bot = Object.keys(config.bots)[n++ % 3];
  store.event("analysis", {
    bot,
    product: bot === "trend" ? "ETH-USDC" : "BTC-USDC",
    answers: {
      regime: { choice: "uptrend" },
      fit: { score: 1.4 + (n % 3) * 0.15 },
      quality: { choice: "complete" },
    },
    elapsed_s: 0.42,
    queue_depth: 0,
    calibrated: false,
  });
  store.event("decision", {
    bot,
    action: "SKIP",
    reason: "Synthetic preview event — no model or exchange connection.",
  });
}, 2500);
const stop = () => {
  clearInterval(timer);
  server.closeStreams();
  server.closeAllConnections();
  server.close(() => {
    store.close();
    process.exit(0);
  });
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
// Bounded fixture lifetime prevents orphaned preview processes in Windows CI.
if (process.env.DEMO_LIFETIME_MS)
  setTimeout(stop, Number(process.env.DEMO_LIFETIME_MS));
