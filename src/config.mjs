import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { isEngine } from "./engines.mjs";
export const IDS = ["breakout", "trend", "momentum"];
// The control arm: a fourth bot that enters at RANDOM from the same universe,
// with the same sizing and the same exits, to provide a null baseline. It is
// not a strategy - no rubric, no setup gates, no Laya. It runs on a simulated
// ledger unless `paper` is set to false, at which point it trades real funds
// like the others. Present only when configured.
export const CONTROL_ID = "control";
export const ALL_BOTS = [...IDS, CONTROL_ID];
export function validate(c) {
  if (!["observe", "live"].includes(c.mode))
    throw Error("mode must be observe or live");
  if (
    c.bind !== "127.0.0.1" ||
    !Number.isInteger(c.port) ||
    c.port < 1024 ||
    c.port > 65535
  )
    throw Error("Invalid local listener");
  if (c.basePath !== "/beebots/") throw Error("basePath must be /beebots/");
  if (
    typeof c.publicOrigin !== "string" ||
    new URL(c.publicOrigin).origin !== c.publicOrigin
  )
    throw Error("Valid publicOrigin required");
  for (const k of ["dataDir", "layaSocket", "coinbasePython"])
    if (!isAbsolute(c[k] || "")) throw Error(`Absolute ${k} required`);
  // Coinbase credentials: a key file, an inline key/secret pair, or the
  // environment. Exactly one source must be usable; the env wins at runtime.
  if (
    c.coinbaseKeyFile !== undefined &&
    c.coinbaseKeyFile !== "" &&
    !isAbsolute(c.coinbaseKeyFile)
  )
    throw Error("Absolute coinbaseKeyFile required");
  if (
    (c.coinbaseApiKeyName || c.coinbaseApiKeySecret) &&
    !(c.coinbaseApiKeyName && c.coinbaseApiKeySecret)
  )
    throw Error(
      "coinbaseApiKeyName and coinbaseApiKeySecret must be set together",
    );
  const envCreds =
    (process.env.COINBASE_KEY_NAME && process.env.COINBASE_KEY_SECRET) ||
    process.env.COINBASE_KEY_FILE;
  if (
    !c.coinbaseKeyFile &&
    !(c.coinbaseApiKeyName && c.coinbaseApiKeySecret) &&
    !envCreds
  )
    throw Error(
      "Coinbase credential required: set coinbaseKeyFile, coinbaseApiKeyName + coinbaseApiKeySecret, or COINBASE_KEY_FILE / COINBASE_KEY_NAME + COINBASE_KEY_SECRET",
    );
  if (c.layaEnabled !== undefined && typeof c.layaEnabled !== "boolean")
    throw Error("layaEnabled must be boolean");
  // The config may name a default decision engine; the dashboard selection, in
  // the settings file, overrides it. Unknown ids are refused here so a typo
  // cannot silently fall back to a different engine.
  if (c.engine !== undefined && !isEngine(c.engine))
    throw Error(
      `Unknown engine "${c.engine}" (expected one of: jev, laya, llm, jev+llm, laya+llm)`,
    );
  if (c.jev !== undefined) {
    if (typeof c.jev !== "object" || c.jev === null || Array.isArray(c.jev))
      throw Error("Invalid jev block");
    if (
      c.jev.model !== undefined &&
      (typeof c.jev.model !== "string" ||
        !/^[A-Za-z0-9._:@/+-]{1,128}$/.test(c.jev.model))
    )
      throw Error("Invalid jev.model");
    if (
      c.jev.timeoutMs !== undefined &&
      (!Number.isFinite(c.jev.timeoutMs) || c.jev.timeoutMs < 250)
    )
      throw Error("Invalid jev.timeoutMs");
    if (
      c.jev.dailyUsdCap !== undefined &&
      (!Number.isFinite(c.jev.dailyUsdCap) || c.jev.dailyUsdCap <= 0)
    )
      throw Error("Invalid jev.dailyUsdCap");
    if (
      c.jev.usdPerMTok !== undefined &&
      (!Number.isFinite(c.jev.usdPerMTok) || c.jev.usdPerMTok < 0)
    )
      throw Error("Invalid jev.usdPerMTok");
  }
  if (c.review !== undefined) {
    if (
      typeof c.review !== "object" ||
      c.review === null ||
      Array.isArray(c.review)
    )
      throw Error("Invalid review block");
    if (
      c.review.minSample !== undefined &&
      (!Number.isInteger(c.review.minSample) || c.review.minSample < 1)
    )
      throw Error("Invalid review.minSample");
    if (
      c.review.autoApply !== undefined &&
      typeof c.review.autoApply !== "boolean"
    )
      throw Error("Invalid review.autoApply");
    if (
      c.review.requireControl !== undefined &&
      typeof c.review.requireControl !== "boolean"
    )
      throw Error("Invalid review.requireControl");
  }
  if (/\/(var\/www|htdocs|public_html)(\/|$)/.test(c.dataDir))
    throw Error("Data must be outside web root");
  if (
    !c.auth?.username ||
    !/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(c.auth.passwordHash || "")
  )
    throw Error("Run npm run password to generate auth.passwordHash");
  if (c.strategyVersion === 2) {
    if (
      c.model?.maxCallsPerDay !== undefined &&
      (!Number.isInteger(c.model.maxCallsPerDay) || c.model.maxCallsPerDay < 1)
    )
      throw Error("Invalid model call budget");
    if (
      !c.scanner ||
      !Number.isInteger(c.scanner.workers) ||
      c.scanner.workers < 1 ||
      c.scanner.workers > 8
    )
      throw Error("Scanner workers must be 1–8");
    for (const v of Object.values(c.scanner.assetOverrides ?? {}))
      if (
        !["meme", "speculative", "stablecoin", "excluded"].includes(
          v.category,
        ) ||
        typeof v.source !== "string" ||
        !v.source
      )
        throw Error("Sourced asset override required");
  }
  if (
    c.strategyVersion !== 2 &&
    (!Array.isArray(c.products) ||
      !c.products.length ||
      c.products.length > 50 ||
      c.products.some((p) => !/^([A-Z0-9]+)-USDC$/.test(p)))
  )
    throw Error("Configure 1–50 USDC spot products");
  for (const k of [
    "decisionIntervalMs",
    "marketIntervalMs",
    "protectionIntervalMs",
    "maxAnalysisAgeMs",
    "layaTimeoutMs",
    "modelTimeoutMs",
  ])
    if (!Number.isFinite(c[k]) || c[k] < 1000) throw Error(`Invalid ${k}`);
  if (!c.model?.baseUrl || !c.model.name)
    throw Error("Decision model endpoint and name required");
  if (c.maintenance !== undefined) {
    if (
      typeof c.maintenance !== "object" ||
      c.maintenance === null ||
      Array.isArray(c.maintenance)
    )
      throw Error("Invalid maintenance block");
    if (
      c.maintenance.vacuumOnStart !== undefined &&
      typeof c.maintenance.vacuumOnStart !== "boolean"
    )
      throw Error("Invalid maintenance.vacuumOnStart");
  }
  const u = new URL(c.model.baseUrl);
  if (
    u.username ||
    u.password ||
    (u.protocol !== "https:" &&
      !(
        ["localhost", "127.0.0.1"].includes(u.hostname) &&
        u.protocol === "http:"
      ))
  )
    throw Error("Model endpoint requires HTTPS or localhost");
  for (const id of IDS) {
    const b = c.bots?.[id];
    if (
      !b ||
      !/^\d+(\.\d{1,8})?$/.test(String(b.capital)) ||
      Number(b.capital) < 0
    )
      throw Error(`Invalid ${id} capital`);
    for (const k of [
      "tradeFraction",
      "stopPct",
      "trailPct",
      "trailActivationPct",
      ...(c.strategyVersion === 2 ? [] : ["maxSpreadBps"]),
      ...(c.strategyVersion === 2
        ? ["riskPct", "maxCostRisk", "trailAtr", "trailR"]
        : ["minPeriodTurnover", "min24hTurnover"]),
      "maxHoldHours",
    ])
      if (!Number.isFinite(b[k]) || b[k] < 0) throw Error(`Invalid ${id}.${k}`);
    if (
      b.tradeFraction <= 0 ||
      b.tradeFraction > 1 ||
      b.stopPct <= 0 ||
      b.stopPct >= 100 ||
      b.trailPct <= 0 ||
      b.trailPct >= 100
    )
      throw Error("Invalid sizing/exits");
    // Concurrent position cap per bot. Optional: absent means the single-position
    // behaviour of every release before 2.3.0.
    if (
      b.maxPositions !== undefined &&
      (!Number.isInteger(b.maxPositions) ||
        b.maxPositions < 1 ||
        b.maxPositions > 5)
    )
      throw Error(`Invalid ${id}.maxPositions`);
    // Real or paper, per bot. Absent means the pre-3.0 default (real,
    // subject to mode); config.example ships paper: true for a fresh install.
    if (b.paper !== undefined && typeof b.paper !== "boolean")
      throw Error(`Invalid ${id}.paper`);
    if (
      c.strategyVersion === 2 &&
      (!(b.riskPct > 0 && b.riskPct <= 5) ||
        !(b.maxCostRisk > 0 && b.maxCostRisk <= 1) ||
        !(b.trailAtr > 0 && b.trailR > 0))
    )
      throw Error("Invalid strategy risk configuration");
    if (c.strategyVersion === 2) {
      const required =
        id === "breakout"
          ? ["rangeBars", "rangeAtr", "relativeVolume", "maxExtensionAtr"]
          : id === "trend"
            ? ["pullbackBars", "maxExtensionAtr"]
            : ["topFraction", "minBreadth"];
      for (const key of required)
        if (!Number.isFinite(b[key]) || b[key] <= 0)
          throw Error(`Invalid ${id}.${key}`);
      if (
        id === "breakout" &&
        (!Number.isInteger(b.rangeBars) || b.rangeBars > 150)
      )
        throw Error("Invalid range lookback");
      if (
        id === "trend" &&
        (!Number.isInteger(b.pullbackBars) || b.pullbackBars > 50)
      )
        throw Error("Invalid pullback lookback");
      if (
        id === "momentum" &&
        (b.topFraction > 1 ||
          !Number.isInteger(b.minBreadth) ||
          b.minBreadth < 2)
      )
        throw Error("Invalid momentum universe parameters");
    }
  }
  // The control arm is configured separately: it has no strategy-specific keys
  // and may run paper (simulated fills) or real.
  if (c.bots?.[CONTROL_ID] !== undefined) {
    const b = c.bots[CONTROL_ID];
    if (
      !b ||
      !/^\d+(\.\d{1,8})?$/.test(String(b.capital)) ||
      Number(b.capital) < 0
    )
      throw Error("Invalid control capital");
    for (const k of [
      "tradeFraction",
      "stopPct",
      "trailPct",
      "trailActivationPct",
      "maxHoldHours",
      "riskPct",
      "maxCostRisk",
    ])
      if (!Number.isFinite(b[k]) || b[k] < 0)
        throw Error(`Invalid ${CONTROL_ID}.${k}`);
    if (
      b.tradeFraction <= 0 ||
      b.tradeFraction > 1 ||
      b.stopPct <= 0 ||
      b.stopPct >= 100 ||
      b.trailPct <= 0 ||
      b.trailPct >= 100
    )
      throw Error("Invalid control sizing/exits");
    if (
      !(b.riskPct > 0 && b.riskPct <= 5) ||
      !(b.maxCostRisk > 0 && b.maxCostRisk <= 1)
    )
      throw Error("Invalid control risk configuration");
    if (
      b.maxPositions !== undefined &&
      (!Number.isInteger(b.maxPositions) ||
        b.maxPositions < 1 ||
        b.maxPositions > 5)
    )
      throw Error(`Invalid ${CONTROL_ID}.maxPositions`);
    if (b.paper !== undefined && typeof b.paper !== "boolean")
      throw Error("Invalid control.paper");
  }
  if (
    c.mode === "live" &&
    (c.liveAcknowledgement !== "ENABLE_REAL_COINBASE_ORDERS" ||
      IDS.some((id) => Number(c.bots[id].capital) <= 0))
  )
    throw Error(
      "Live activation requires explicit acknowledgement and positive allocations",
    );
  // A control arm trading real funds is held to the same funding rule. Paper is
  // exempt: it spends no money.
  if (
    c.mode === "live" &&
    c.bots?.[CONTROL_ID] &&
    c.bots[CONTROL_ID].paper !== true &&
    Number(c.bots[CONTROL_ID].capital) <= 0
  )
    throw Error("Live control arm requires positive capital or paper: true");
  if (
    c.mode === "live" &&
    !/^[a-f0-9-]{36}$/i.test(c.coinbasePortfolioId ?? "")
  )
    throw Error(
      "Explicit Coinbase portfolio ID required for live capital isolation",
    );
  return c;
}
export function loadConfig(path) {
  return validate(JSON.parse(readFileSync(path, "utf8")));
}
