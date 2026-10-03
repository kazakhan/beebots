import { createHash, randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import { IDS, ALL_BOTS, CONTROL_ID } from "./config.mjs";
import {
  dec,
  str,
  sub,
  mul,
  floorStep,
  add,
  availableAmount,
  SCALE,
} from "./decimal.mjs";
import { eligibility, assertTradable } from "./market.mjs";
import {
  executionPlan,
  VERSION,
  defaults as STRATEGY_DEFAULTS,
  entryRejection,
} from "./strategy-v2.mjs";
import { isRefusal, refuse } from "./refusal.mjs";
import { buildTimeframeLab } from "./timeframe-lab.mjs";
import { readJsonOverride, validateParams } from "./overrides.mjs";
import { performance } from "./performance.mjs";
import { costOf, usageCounts, PROVIDERS, modelLabel } from "./providers.mjs";
import {
  buildMenu,
  parseMove,
  engineUses,
  engineLabel,
  isEngine,
  CONVICTION_LABELS,
} from "./engines.mjs";

// Backend build identifier, surfaced in api/state for the version-skew check.
const BUILD = "3.3.7";
// How far back the Timeframe Lab simulates. 5m/15m history is ~25h, so 24h keeps
// every timeframe on the same window.
const TIMEFRAME_LAB_LOOKBACK_MS = 24 * 3600000;

// The control arm has no strategy rubric. Its only job on a held position is to
// decide whether to keep or close it, using the same evidence the strategies see.
const CONTROL_STRATEGY =
  "This is the control arm. Positions were entered at random, not from any " +
  "setup, so there is no thesis to defend. Judge only whether the evidence " +
  "supports continuing to hold: SELL to close, HOLD to keep. Do not BUY. " +
  "Laya's labels are uncalibrated evidence, not a decision or a probability. " +
  "Code controls size, stops and execution; do not attempt to alter them.";

// Simulated IOC fill at the touch, shaped like the exchange order object that
// applyOrder consumes. A BUY `size` is quote (USDC); a SELL `size` is base.
//
// Computed in exact fixed-point, not floats: a paper order size is now full
// precision (3.0.2 stopped rounding it to the exchange increment), and
// Number/toFixed rounding could make the reported value exceed the requested
// size, which applyOrder treats as a halt. The value never exceeds the request.
export function paperFill(order, q, feeRate) {
  const raw = order.side === "BUY" ? q.asks?.[0]?.price : q.bids?.[0]?.price;
  // Prefer the book's raw decimal string; fall back to the numeric touch.
  const priceStr = String(raw ?? (order.side === "BUY" ? q.ask : q.bid));
  if (!(Number(priceStr) > 0)) throw Error("Invalid paper fill price");
  const toDec = (n) => {
    const s = String(n);
    return s.includes("e") || s.includes("E") ? Number(n).toFixed(18) : s;
  };
  const feeStr = toDec(feeRate);
  // BigInt division truncates, so the base quantity is floored and its value can
  // never exceed the quote size originally requested.
  const baseQty =
    order.side === "BUY"
      ? str((dec(order.size) * SCALE) / dec(priceStr))
      : order.size;
  const value = order.side === "BUY" ? order.size : mul(order.size, priceStr);
  const fees = mul(value, feeStr);
  return {
    order_id: "paper-" + order.id,
    client_order_id: order.id,
    product_id: order.product,
    side: order.side,
    status: "FILLED",
    settled: true,
    filled_size: baseQty,
    filled_value: value,
    total_fees: fees,
  };
}
export class Engine {
  constructor({
    config,
    store,
    exchange,
    market,
    laya,
    model,
    jev = null,
    settings = null,
    review = null,
  }) {
    Object.assign(this, {
      config,
      store,
      exchange,
      market,
      laya,
      model,
      jev,
      settings,
      reviewer: review,
    });
    this.stopped = false;
    this.busy = false;
    this.protectBusy = false;
    this.lastCycle = 0;
    this.lastProtection = 0;
    this.health = { laya: null, account: null, error: null };
    this.errors = new Map();
    this.timers = [];
    this.executing = Promise.resolve();
    this.strategies = Object.fromEntries(
      IDS.map((id) => [
        id,
        readFileSync(
          new URL(`../strategies/${id}.md`, import.meta.url),
          "utf8",
        ),
      ]),
    );
    this.legacyStrategies = { ...this.strategies };
    if (config.strategyVersion === 2)
      for (const id of IDS)
        this.strategies[id] = readFileSync(
          new URL(`../strategies/v2/${id}.md`, import.meta.url),
          "utf8",
        );
    // Applied review changes live as overrides under the data directory, which
    // is the only path the sandboxed service can write. They take precedence
    // over the bundled rubric and feed the rule hash.
    if (this.reviewer)
      for (const id of IDS)
        this.strategies[id] = this.reviewer.rubric(id, this.strategies[id]);
    // Reads the live model name when a dashboard-managed selector is attached, so a
    // provider/model switch is reflected in subsequent hashes.
    this.rulesForHash = () =>
      this.model.resolve?.()?.model ?? config.model.name;
    // Seed the Jev daily cap from the ledger so a restart does not reset it.
    if (this.jev) this.restoreJevSpend();
  }
  // Every configured bot, strategy and control alike. Used by the protective
  // loop and reporting, which are agnostic to how an entry was chosen.
  botIds() {
    return ALL_BOTS.filter((id) => this.config.bots?.[id]);
  }
  // The control arm enters at random and is never sent to the decision model for
  // an entry. It still uses the model for discretionary exits, matching the live
  // bots exactly so the only difference between arms is entry selection.
  isControl(id) {
    return id === CONTROL_ID;
  }
  isPaper(id) {
    return this.config.bots?.[id]?.paper === true;
  }
  effectiveRulesMap() {
    return Object.fromEntries(
      ALL_BOTS.filter((id) => this.config.bots?.[id]).map((id) => [
        id,
        this.effectiveRules(id),
      ]),
    );
  }
  // The rule hash identifies which instructions produced a decision. It is stamped
  // on every decision event, so it must follow the model that actually decided.
  // A dashboard model switch would otherwise leave later decisions carrying the
  // previous model's hash and misattribute them in the audit trail.
  currentRuleHash() {
    return createHash("sha256")
      .update(
        JSON.stringify({
          bots: this.effectiveRulesMap(),
          strategies: this.strategies,
          model: this.rulesForHash(),
        }),
      )
      .digest("hex");
  }
  // The strategy parameters a bot actually runs on: bundled defaults, then the
  // owner's config, then whatever the self-improvement loop last applied. The
  // override is schema-validated before use, so a corrupt or out-of-bounds file
  // is ignored rather than trusted.
  effectiveRules(id) {
    const base = {
      ...(STRATEGY_DEFAULTS[id] ?? {}),
      ...(this.config.bots?.[id] ?? {}),
    };
    const over = readJsonOverride(this.config.dataDir, `params.${id}`, null);
    if (over && !validateParams(`params.${id}`, over))
      Object.assign(base, over);
    return base;
  }
  // Runtime-wide knobs the review may tune. Defaults are the pre-review values.
  effectiveRuntime() {
    const base = {
      cadenceMs: 300000,
      maxCandidates: 25,
      modelMaxCallsPerDay: this.config.model?.maxCallsPerDay ?? 1000,
      scoutCategories: ["meme", "speculative", "unclassified"],
    };
    const over = readJsonOverride(this.config.dataDir, "runtime", null);
    if (over && !validateParams("runtime", over)) Object.assign(base, over);
    return base;
  }
  // Record what actually happened to a decision after execution, so the card
  // cannot show a BUY that was refused without saying so.
  noteOutcome(id, action, executed, refusal) {
    this.store.change(
      (s) => {
        const d = s.bots[id]?.lastDecision;
        if (d)
          s.bots[id].lastDecision = {
            ...d,
            executed,
            refusal: refusal ?? null,
          };
      },
      "status",
      {
        bot: id,
        message: executed
          ? `${action} executed`
          : `${action} not executed: ${refusal}`,
      },
    );
  }
  // The selected decision engine. Dashboard settings win; absent that, the
  // owner's config.engine; absent that, the pre-2.9 behaviour (Laya+LLM, or
  // LLM-only when Laya is disabled) so a runtime constructed without a settings
  // file keeps trading as before. A fresh install's Settings defaults to Laya.
  engineId() {
    const stored = this.settings?.engineValue?.();
    if (isEngine(stored)) return stored;
    if (isEngine(this.config.engine)) return this.config.engine;
    return this.config.layaEnabled === false ? "llm" : "laya+llm";
  }
  // Compact, bounded market + position state for a System One engine. It is
  // evidence, not full precision: the execution layer holds the exact numbers.
  engineState(id, candidates, bot) {
    const keys = [
      "close",
      "previousClose",
      "channelHigh",
      "channelLow",
      "ema20",
      "ema50",
      "momentum7dPct",
      "momentum24hPct",
      "return15mPct",
      "spreadBps",
      "periodTurnover",
      "turnover24h",
      "atr",
      "relativeVolume",
      "compressionAtr",
      "rankPercentile",
      "breadth",
      "stopPrice",
      "maxEntry",
      "rankScore",
    ];
    return {
      bot: id,
      positions: (Array.isArray(bot.positions) ? bot.positions : []).map(
        (p) => ({ product: p.product, quantity: p.quantity }),
      ),
      candidates: (candidates ?? []).map((f) => {
        const out = { product: f.product, held: !!f.held };
        for (const k of keys)
          if (Number.isFinite(f[k])) out[k] = Number(f[k].toPrecision(6));
        // Laya's own classification of this candidate, so the decision uses it.
        // The original design fed analysed candidates into the decision; do not
        // drop this or Laya decides blind to its own analysis.
        const a = f.analysis?.answers;
        if (a)
          out.analysis = {
            regime: a.regime?.choice ?? null,
            quality: a.quality?.choice ?? null,
            fit: Number.isFinite(a.fit?.score) ? a.fit.score : null,
          };
        return out;
      }),
    };
  }
  // Active model identity for the dashboard and audit records.
  modelInfo() {
    const resolved = this.model.resolve?.();
    const provider = resolved?.provider ?? null;
    const model = resolved?.model ?? this.config.model.name;
    const spec = provider ? PROVIDERS[provider]?.models?.[model] : null;
    const engine = this.engineId();
    return {
      provider,
      model,
      label: provider ? modelLabel(provider, model) : String(model),
      // The summary card wants a compact title; the settings panel wants the
      // descriptive label including any price hint.
      cardTitle: String(model).toUpperCase(),
      free: spec?.free === true,
      hasKey: !!resolved?.key,
      keyEnv: resolved?.apiKeyEnv ?? this.config.model.apiKeyEnv ?? null,
      // The decision engine selected for entries, distinct from the LLM above
      // (which still runs the Trade Review even when it does not decide).
      engine,
      engineLabel: engineLabel(engine),
      // The Jev daily USD cap, for the dashboard's Jev spend card. Null when the
      // runtime has no Jev client.
      jevCapUsd: this.jev ? Number(this.jev.dailyUsdCap) : null,
    };
  }
  // Restore today's Jev spend from the ledger at startup, so a restart does not
  // silently reset the daily cap to zero.
  restoreJevSpend() {
    try {
      const u = this.store.normaliseUsage(this.store.read().modelUsage ?? null);
      const today = new Date().toISOString().slice(0, 10);
      if (!u || u.day !== today) {
        this.jev.spentTodayUsd = 0;
        return;
      }
      const nanos = Object.values(u.perModel ?? {})
        .filter((p) => p.provider === "jev")
        .reduce((n, p) => n + BigInt(p.costNanos ?? 0), 0n);
      this.jev.spentTodayUsd = Number(nanos) / 1e9;
    } catch {
      // Best effort; a bad ledger row must never stop the runtime starting.
    }
  }
  // Persist one Jev call in the same day-scoped ledger as the LLM, so the
  // dashboard can show a Jev spend card and the cap survives a restart. Usage
  // accounting is telemetry: a failure is recorded and swallowed, never thrown
  // into a decision path.
  recordJevCall(read, day) {
    try {
      this.store.recordModelCall({
        day,
        provider: "jev",
        model: read.model ?? "jev",
        // Jev bills input tokens only; output is free.
        usage: usageCounts({
          prompt_tokens: read.inputTokens,
          total_tokens: read.inputTokens,
        }),
        costNanos: BigInt(Math.round((Number(read.costUsd) || 0) * 1e9)),
      });
    } catch (e) {
      this.store.event("status", {
        message: `Jev usage not recorded: ${e.message}`,
      });
    }
  }
  async start() {
    this.market.start?.();
    // Explicit config arms live startup; mode remains visible. No exchange mutation in observe.
    this.store.change(
      (s) => {
        if (this.config.mode !== "live") s.paused = true;
        else if (s.lastMode !== "live") s.paused = false;
        s.lastMode = this.config.mode;
      },
      "system",
      {
        message: "Runtime started",
        mode: this.config.mode,
        ruleHash: this.currentRuleHash(),
      },
    );
    this.timers.push(
      setInterval(() => void this.cycle(), this.config.marketIntervalMs),
    );
    this.timers.push(
      setInterval(() => void this.protect(), this.config.protectionIntervalMs),
    );
    this.scheduleReview();
    void this.cycle();
    void this.protect();
  }
  // The Trade Review runs on the wall clock, at :00 each hour, over the hour
  // that just closed. A plain interval would drift and split hours unevenly.
  scheduleReview() {
    if (!this.reviewer || this.config.review?.enabled === false) return;
    const now = Date.now();
    const next = Math.ceil(now / 3600000) * 3600000;
    const first = setTimeout(
      () => {
        void this.review();
        const iv = setInterval(() => void this.review(), 3600000);
        iv.unref?.();
        this.timers.push(iv);
      },
      Math.max(1000, next - now + 1500),
    );
    first.unref?.();
    this.timers.push(first);
    // Review the hour that just closed on startup, rather than waiting for the
    // next wall-clock :00. review() is idempotent for an already-reviewed hour.
    void this.review();
  }
  async review(force = false) {
    if (this.reviewing || this.stopped) return;
    const until = Math.floor(Date.now() / 3600000) * 3600000;
    const since = until - 3600000;
    if (!force) {
      const s = this.store.read();
      // Already reviewed this hour successfully; a failed hour is retried.
      if (s.lastReview?.until === until && !s.lastReviewError) return;
    }
    this.reviewing = true;
    try {
      await this.reviewer.run({
        since,
        until,
        coverage: this.market.coverage?.() ?? null,
        autoApply: this.config.review?.autoApply !== false,
        timeframeLab: this.timeframeLab(),
      });
      this.setError("review", null);
    } catch (e) {
      this.setError("review", e.message);
      this.store.event("error", { component: "review", message: e.message });
    } finally {
      this.reviewing = false;
    }
  }
  // Deterministic evidence about each bot's signal timeframe, for the hourly
  // review. Re-runs each bot's own strategy over the candles already held, at
  // 5m/15m/1h, and simulates its own exits. Bounded (product/eval/time caps) and
  // side-effect free; returns null when no candle history is loaded.
  timeframeLab() {
    const market = this.market;
    if (!market?.frames?.size) return null;
    const products = Array.isArray(market.products) ? market.products : [];
    if (!products.length) return null;
    const until = Date.now();
    return buildTimeframeLab({
      products,
      framesFor: (p) => market.frames.get(p),
      membershipFor: (p) =>
        market.entries?.get(p)?.membership ?? { category: "unclassified" },
      arms: IDS.map((id) => ({ id, rules: this.effectiveRules(id) })),
      // 5m/15m history is ~25h, so a longer lookback buys nothing for them; 24h
      // keeps all three timeframes comparable.
      since: until - TIMEFRAME_LAB_LOOKBACK_MS,
      until,
    });
  }
  stop() {
    this.stopped = true;
    if (this.market.stop) this.market.closed = true;
    for (const t of this.timers) clearInterval(t);
  }
  serial(fn) {
    const p = this.executing.then(fn);
    this.executing = p.catch(() => {});
    return p;
  }
  async cycle() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      this.market.held = Object.values(this.store.read().bots).flatMap((b) =>
        (Array.isArray(b.positions) ? b.positions : []).map((p) => p.product),
      );
      await this.market.refresh();
      if (this.stopped) return;
      if (!this.lastMarketEvent || Date.now() - this.lastMarketEvent >= 60000) {
        this.store.recordEquity(this.market.prices());
        this.store.event("market", {
          products: this.market.snapshot(),
          error: this.market.lastError,
        });
        this.lastMarketEvent = Date.now();
      }
      if (Date.now() - this.lastCycle < this.config.decisionIntervalMs) return;
      this.lastCycle = Date.now();
      this.setError("analysis", null);
      const runtime = this.effectiveRuntime();
      for (const id of IDS) {
        try {
          if (this.stopped) return;
          if (this.store.pending().some((o) => o.bot === id)) {
            this.store.event("status", {
              bot: id,
              message: "Waiting for order reconciliation",
            });
            continue;
          }
          const bot = this.store.read().bots[id],
            rules = this.effectiveRules(id);
          const positions = Array.isArray(bot.positions) ? bot.positions : [];
          const heldProducts = positions.map((p) => p.product);
          const maxPositions = this.store.maxPositions(id);
          const atCapacity = positions.length >= maxPositions;
          const v2 = this.config.strategyVersion === 2;
          // A position written before the policy layer has no saved exit plan and
          // is reviewed from the generic feature rows on the fast cadence.
          const legacyPosition = v2 && positions.some((p) => !p.policy);
          const available = v2 ? this.market.snapshot(id) : null;
          // The full collected snapshot always, so a held product is found,
          // quoted and valued even if it has dropped out of the strategy
          // universe. Held rows only; fresh entries still come from `available`.
          const generic = v2 ? this.market.snapshot() : [];
          const reviewable = [...(available ?? []), ...generic];
          if (v2) {
            // Cadence is tunable and defaults to 5 minutes for every bot; the
            // old fixed 5m/15m/1h buckets are gone, so Keeper can day-trade.
            const cadence = Number(rules.cadenceMs);
            const interval = cadence >= 30000 ? cadence : runtime.cadenceMs;
            const bucket = Math.floor(Date.now() / interval);
            if (this.store.read().assessments?.[id] === bucket) continue;
            // No strategy snapshot yet: do NOT consume the cadence (a later
            // cycle in the same bucket must still get a valid assessment), but
            // record a visible SKIP once per bucket so the bot is never
            // invisible in the decision stream.
            if (!available.length) {
              this.skipLog ??= new Map();
              if (this.skipLog.get(id) !== bucket) {
                this.skipLog.set(id, bucket);
                const decision = {
                  action: positions.length ? "HOLD" : "SKIP",
                  reason: "No market read yet (strategy warming)",
                  source: "strategy rules",
                  at: Date.now(),
                };
                this.store.change(
                  (s) => {
                    s.bots[id].lastDecision = decision;
                  },
                  "decision",
                  { bot: id, ...decision },
                );
              }
              continue;
            }
            // A held asset with no market read is a real gap: retry next cycle
            // (leave the cadence unstamped) and surface it once per bucket.
            if (
              heldProducts.some((p) => !reviewable.some((f) => f.product === p))
            ) {
              this.skipLog ??= new Map();
              if (this.skipLog.get(id) !== bucket) {
                this.skipLog.set(id, bucket);
                this.store.event("status", {
                  bot: id,
                  message: "Held asset has no market read; waiting to warm",
                });
              }
              continue;
            }
            this.store.change((s) => {
              s.assessments ??= {};
              s.assessments[id] = bucket;
            });
          }
          // Every held position stays in the candidate list so the model can
          // review and exit it. New entries are drawn from the strategy universe
          // and excluded while a bot is at its position limit.
          let candidates;
          if (v2) {
            const held = [];
            for (const p of positions) {
              const row = reviewable.find((f) => f.product === p.product);
              if (row) held.push({ ...row, held: true });
            }
            const cap = Math.max(
              1,
              Number(rules.maxCandidates) || runtime.maxCandidates,
            );
            const fresh = atCapacity
              ? []
              : available
                  .filter((f) => !heldProducts.includes(f.product))
                  .slice(0, cap);
            candidates = [...held, ...fresh];
          } else {
            candidates = this.market
              .snapshot()
              .filter(
                (f) =>
                  heldProducts.includes(f.product) ||
                  (f.periodTurnover >= rules.minPeriodTurnover &&
                    f.turnover24h >= rules.min24hTurnover &&
                    f.spreadBps <= rules.maxSpreadBps),
              )
              .map((f) => ({
                ...f,
                setupEligible: eligibility(id, f, rules),
              }));
          }
          // Analyze liquid near-misses too: Laya remains visible even before an
          // entry trigger. The execution layer still enforces the exact rules.
          const rank = (f) =>
            v2
              ? (f.rankScore ?? 0)
              : id === "breakout"
                ? f.close / f.channelHigh
                : id === "trend"
                  ? f.ema20 / f.ema50
                  : f.momentum7dPct;
          // Scout's priority is meme and newly listed coins, then setup quality.
          const priority = (f) =>
            id === "breakout" && (f.category === "meme" || f.isNew) ? 1 : 0;
          candidates.sort(
            (a, b) =>
              Number(b.setupEligible) - Number(a.setupEligible) ||
              priority(b) - priority(a) ||
              rank(b) - rank(a),
          );
          // Held positions are never dropped from view; fresh entries were
          // already capped above.
          const maxCandidates = Math.max(
            1,
            Number(rules.maxCandidates) || runtime.maxCandidates,
          );
          candidates = v2
            ? candidates.slice(0, positions.length + maxCandidates)
            : candidates.slice(0, maxCandidates);
          if (v2) {
            const fresh = [];
            for (const f of candidates) {
              try {
                const q = await this.market.quote(f.product);
                const item = { ...f, ...q };
                fresh.push(item);
              } catch (e) {
                this.store.event("status", {
                  bot: id,
                  product: f.product,
                  message: e.message,
                });
              }
            }
            candidates = fresh;
          }
          if (!candidates.length) {
            // Always record something, so a bot is never invisible. Say why.
            const markets = v2
              ? available.length
              : this.market.snapshot().length;
            const decision = {
              action: positions.length ? "HOLD" : "SKIP",
              reason: markets
                ? `No qualifying setup among ${markets} market read${markets === 1 ? "" : "s"}`
                : "No market read yet (strategy warming)",
              source: "strategy rules",
              at: Date.now(),
            };
            this.store.change(
              (s) => {
                s.bots[id].lastDecision = decision;
              },
              "decision",
              { bot: id, ...decision },
            );
            this.setError(`analysis:${id}`, null);
            continue;
          }
          // Which engine decides this cycle, and which components it uses.
          const engine = this.engineId();
          const usesJev = engineUses(engine, "jev");
          const llmDecides = engineUses(engine, "llm");
          // Laya analyses candidates whenever it is part of the engine (laya,
          // laya+llm). This ran from day one and must NOT be keyed to the LLM
          // engine id: the analysis feeds the decision and the review's per-arm
          // metrics, whether Laya or the LLM makes the final call. Engines with
          // no Laya (llm, jev, jev+llm) skip it. A failed classification
          // degrades that one candidate rather than aborting the bot.
          let analyzed = candidates;
          if (engineUses(engine, "laya")) {
            analyzed = [];
            for (const f of candidates) {
              if (this.stopped) return;
              try {
                const analysis = await this.laya.analyze(f, id);
                this.health.laya = {
                  ready: true,
                  queueDepth: analysis.queue_depth,
                  at: Date.now(),
                };
                this.store.event("analysis", {
                  bot: id,
                  product: f.product,
                  sourceTime: f.at,
                  ...analysis,
                });
                analyzed.push({ ...f, analysis });
              } catch (e) {
                this.store.event("status", {
                  bot: id,
                  product: f.product,
                  message: e.message,
                });
                analyzed.push(f);
              }
            }
            analyzed.sort(
              (a, b) =>
                (b.analysis?.answers?.fit?.score ?? 0) -
                (a.analysis?.answers?.fit?.score ?? 0),
            );
          } else {
            this.health.laya = { ready: false, disabled: true, at: Date.now() };
          }
          const day = new Date().toISOString().slice(0, 10);
          let d;
          let llmUsage = false;
          if (llmDecides) {
            if (v2) {
              const usage = this.store.read().modelUsage;
              if (
                usage?.day === day &&
                usage.calls >=
                  (runtime.modelMaxCallsPerDay ??
                    this.config.model.maxCallsPerDay ??
                    1000)
              )
                throw Error("Daily decision-model call budget reached");
              // Count the attempt before the call so a crash mid-request still
              // consumes budget. Tokens and cost are recorded once it returns.
              this.store.change((s) => {
                if (s.modelUsage?.day !== day)
                  s.modelUsage = this.store.emptyUsage(day);
                s.modelUsage.calls = Number(s.modelUsage.calls) || 0;
                s.modelUsage.calls++;
              });
            }
            // Jev+LLM: Jev's proposed move is supplied as evidence. A Jev
            // failure is not fatal - the LLM still decides on the metrics.
            let evidence = null;
            if (usesJev && this.jev) {
              const read = await this.jev.decide({
                state: this.engineState(id, analyzed, bot),
                menu: buildMenu({
                  id,
                  candidates: analyzed,
                  positions,
                  maxPositions,
                }),
                convictionLabels: CONVICTION_LABELS,
              });
              if (read?.ok) {
                this.recordJevCall(read, day);
                const move = parseMove(read.choice);
                evidence = {
                  engine: "jev",
                  choice: read.choice,
                  action: move?.action ?? null,
                  product: move?.product ?? null,
                  probabilities: read.probabilities,
                  confidence: read.confidence,
                  conviction: read.conviction,
                  convictionRaw: read.convictionRaw,
                };
              } else
                this.store.event("status", {
                  bot: id,
                  message: `Jev evidence unavailable (${read?.reason ?? "error"})`,
                });
            }
            d = await this.model.decide({
              strategy:
                (legacyPosition
                  ? this.legacyStrategies[id]
                  : this.strategies[id]) +
                "\nConfigured rules: " +
                JSON.stringify(
                  legacyPosition ? positions.filter((p) => !p.policy) : rules,
                ),
              // The model needs the current holdings and the cap to decide
              // whether a BUY is even possible, so it is told both explicitly.
              bot: { ...bot, maxPositions },
              candidates: analyzed,
              evidence,
            });
            llmUsage = true;
          } else {
            // The engine itself decides: one System One choice over the valid
            // moves. Jev and Laya share the contract; a failed call holds the
            // bot, exactly as a missing model would.
            const menu = buildMenu({
              id,
              candidates: analyzed,
              positions,
              maxPositions,
            });
            const state = this.engineState(id, analyzed, bot);
            const read = usesJev
              ? this.jev
                ? await this.jev.decide({
                    state,
                    menu,
                    convictionLabels: CONVICTION_LABELS,
                  })
                : {
                    ok: false,
                    reason: "error",
                    error: { message: "Jev client is not available" },
                  }
              : await this.laya.decide({
                  state,
                  menu,
                  convictionLabels: CONVICTION_LABELS,
                });
            if (!read?.ok)
              throw Error(
                `Decision engine ${engineLabel(engine)} unavailable: ${
                  read?.error?.message ?? read?.reason ?? "no answer"
                }`,
              );
            if (!usesJev)
              this.health.laya = {
                ready: true,
                queueDepth: read.queue_depth,
                at: Date.now(),
              };
            else this.recordJevCall(read, day);
            const move = parseMove(read.choice);
            if (!move)
              throw Error(`${engineLabel(engine)} returned an off-menu move`);
            d = {
              action: move.action,
              product: move.product,
              reason:
                `${engineLabel(engine)} chose ${read.choice}` +
                (read.convictionRaw !== null && read.convictionRaw !== undefined
                  ? ` (conviction ${read.convictionRaw})`
                  : ""),
              model: read.model ?? engine,
              provider: usesJev ? "jev" : null,
              engine,
              usage: null,
            };
          }
          // Usage accounting is telemetry. It must never be able to abort a
          // decision or block an order, so a failure here is recorded and
          // swallowed rather than thrown into the per-bot catch below.
          if (v2 && llmUsage)
            try {
              this.store.recordModelCall({
                day,
                provider: d.provider ?? null,
                model: d.model,
                usage: usageCounts(d.usage),
                // null when the model has no published rate: tokens are still
                // counted, but no cost is invented for it.
                costNanos: costOf(d.usage, d.provider, d.model, Date.now()),
              });
            } catch (e) {
              this.store.event("status", {
                bot: id,
                message: `Model usage not recorded: ${e.message}`,
              });
            }
          const hash = this.currentRuleHash();
          this.store.change(
            (s) => {
              s.bots[id].lastDecision = { ...d, at: Date.now() };
            },
            "decision",
            { bot: id, ...d, ruleHash: hash },
          );
          this.setError(`analysis:${id}`, null);
          if (this.stopped) return;
          if (["BUY", "SELL"].includes(d.action)) {
            const f = analyzed.find((f) => f.product === d.product);
            if (!f || Date.now() - f.at > this.config.maxAnalysisAgeMs) {
              this.store.event("veto", {
                bot: id,
                reason: "Analysis expired before execution",
              });
              this.noteOutcome(
                id,
                d.action,
                false,
                "Analysis expired before execution",
              );
              continue;
            }
            try {
              await this.serial(async () => {
                const live = this.store.read().bots[id];
                const current = Array.isArray(live.positions)
                  ? live.positions.find((p) => p.product === d.product)
                  : null;
                const snapshotPos = positions.find(
                  (p) => p.product === d.product,
                );
                if (
                  d.action === "SELL" &&
                  (!current ||
                    current.opened !== snapshotPos?.opened ||
                    current.quantity !== snapshotPos?.quantity)
                ) {
                  this.store.event("veto", {
                    bot: id,
                    reason: "Position changed during agent assessment",
                  });
                  this.noteOutcome(
                    id,
                    d.action,
                    false,
                    "Position changed during agent assessment",
                  );
                  return;
                }
                const orderId = await this.execute(
                  id,
                  d.action,
                  d.product,
                  d.reason,
                  f,
                );
                if (orderId) this.noteOutcome(id, d.action, true, null);
              });
            } catch (e) {
              // A refusal is a normal decline; annotate the card and stop here so
              // the outer catch does not double-log it.
              if (isRefusal(e)) {
                this.store.event("veto", { bot: id, reason: e.message });
                this.noteOutcome(id, d.action, false, e.message);
                this.setError(`analysis:${id}`, null);
              } else throw e;
            }
          }
        } catch (e) {
          // A refusal (thin book, slippage over budget, entry no longer
          // qualifies) is a normal decline, not a fault: record it as a veto.
          if (isRefusal(e)) {
            this.store.event("veto", { bot: id, reason: e.message });
            this.setError(`analysis:${id}`, null);
          } else {
            this.setError(`analysis:${id}`, e.message);
            this.store.event("error", {
              bot: id,
              component: "analysis",
              message: e.message,
            });
          }
        }
      }
      // The control arm runs after the strategies so it competes for the same
      // market reads. It chooses entries at random and never consults the model
      // for an entry; exits go through the identical model review.
      if (this.config.bots?.[CONTROL_ID]) {
        try {
          await this.controlCycle();
        } catch (e) {
          if (isRefusal(e)) {
            this.store.event("veto", { bot: CONTROL_ID, reason: e.message });
            this.setError(`analysis:${CONTROL_ID}`, null);
          } else {
            this.setError(`analysis:${CONTROL_ID}`, e.message);
            this.store.event("error", {
              bot: CONTROL_ID,
              component: "analysis",
              message: e.message,
            });
          }
        }
      }
    } catch (e) {
      this.setError("analysis", e.message);
      this.store.event("error", { component: "analysis", message: e.message });
    } finally {
      this.busy = false;
    }
  }
  setError(scope, message) {
    this.errors.delete(scope);
    if (message) this.errors.set(scope, message);
    this.health.error = [...this.errors.values()].at(-1) ?? null;
  }
  // One control cadence: review any held positions through the same Laya+model
  // exit path the strategies use, then take at most one random entry while
  // below the cap. The randomness is the point: it is the null hypothesis the
  // strategy arms are measured against.
  async controlCycle() {
    const id = CONTROL_ID,
      rules = this.effectiveRules(id);
    if (this.store.pending().some((o) => o.bot === id)) return;
    const interval =
      Number(rules.cadenceMs) >= 30000
        ? rules.cadenceMs
        : this.effectiveRuntime().cadenceMs;
    const bucket = Math.floor(Date.now() / interval);
    if (this.store.read().assessments?.[id] === bucket) return;
    const available = this.market.snapshot();
    if (!available.length) return;
    this.store.change((s) => {
      s.assessments ??= {};
      s.assessments[id] = bucket;
    });

    // Discretionary exits first, through the identical model review.
    const held = (this.store.read().bots[id].positions ?? []).slice();
    if (held.length) await this.reviewControlExits(id, held, available);

    // Then at most one random entry if there is room.
    const live = this.store.read().bots[id];
    const heldNow = (live.positions ?? []).map((p) => p.product);
    if (heldNow.length >= this.store.maxPositions(id)) return;
    const pool = available.filter((f) => !heldNow.includes(f.product));
    if (!pool.length) return;
    // Uniform over the union universe. Math.random is deliberate: any selection
    // rule here would reintroduce the entry skill the control exists to remove.
    const pick = pool[randomInt(pool.length)];
    let q;
    try {
      q = await this.market.quote(pick.product);
    } catch (e) {
      this.store.event("status", {
        bot: id,
        product: pick.product,
        message: e.message,
      });
      return;
    }
    const stopPrice = q.ask * (1 - Number(rules.stopPct) / 100);
    const evidence = {
      product: pick.product,
      at: Date.now(),
      atr: Number.isFinite(pick.atr) ? pick.atr : null,
      stopPrice,
      signalTime: pick.signalTime ?? Date.now(),
      control: true,
      reason: "Control arm: uniformly random entry",
    };
    await this.serial(() =>
      this.execute(id, "BUY", pick.product, evidence.reason, evidence),
    );
  }
  // Held control positions are reviewed by the model exactly as strategy
  // positions are: Laya classifies the evidence, the model decides SELL/HOLD.
  async reviewControlExits(id, held, available) {
    const rules = this.effectiveRules(id);
    const candidates = [];
    for (const p of held) {
      const row = available.find((f) => f.product === p.product);
      if (!row) continue;
      try {
        candidates.push({
          ...row,
          ...(await this.market.quote(p.product)),
          held: true,
        });
      } catch (e) {
        this.store.event("status", {
          bot: id,
          product: p.product,
          message: e.message,
        });
      }
    }
    if (!candidates.length) return;
    // Same Laya policy as the strategy loop: optional, and a failure degrades
    // the candidate rather than dropping it.
    let analyzed = candidates;
    if (this.config.layaEnabled !== false) {
      analyzed = [];
      for (const f of candidates) {
        try {
          const analysis = await this.laya.analyze(f, id);
          this.store.event("analysis", {
            bot: id,
            product: f.product,
            sourceTime: f.at,
            ...analysis,
          });
          analyzed.push({ ...f, analysis });
        } catch (e) {
          this.store.event("status", {
            bot: id,
            product: f.product,
            message: e.message,
          });
          analyzed.push(f);
        }
      }
    }
    if (!analyzed.length) return;
    const day = new Date().toISOString().slice(0, 10);
    const bot = this.store.read().bots[id];
    const d = await this.model.decide({
      strategy: CONTROL_STRATEGY,
      bot: { ...bot, maxPositions: this.store.maxPositions(id) },
      candidates: analyzed,
    });
    try {
      this.store.recordModelCall({
        day,
        provider: d.provider ?? null,
        model: d.model,
        usage: usageCounts(d.usage),
        costNanos: costOf(d.usage, d.provider, d.model, Date.now()),
      });
    } catch (e) {
      this.store.event("status", {
        bot: id,
        message: `Model usage not recorded: ${e.message}`,
      });
    }
    this.store.change(
      (s) => {
        s.bots[id].lastDecision = { ...d, at: Date.now() };
      },
      "decision",
      { bot: id, ...d, ruleHash: this.currentRuleHash() },
    );
    if (d.action !== "SELL") return;
    const f = analyzed.find((x) => x.product === d.product);
    if (!f) return;
    await this.serial(() => this.execute(id, "SELL", d.product, d.reason, f));
  }
  async accounts() {
    const r = await this.exchange.accounts();
    const balances = {};
    for (const a of r.accounts ?? []) {
      if (!a.currency || a.available_balance?.currency !== a.currency)
        throw Error("Invalid account currency");
      const amount = availableAmount(a.available_balance.value);
      if (dec(amount) < 0n) throw Error("Invalid account balance");
      balances[a.currency] = add(balances[a.currency] ?? "0", amount);
    }
    return balances;
  }
  async reconcileBalances() {
    const balances = await this.accounts(),
      s = this.store.read();
    // Open exchange orders reserve funds there; compare cash only once they are settled.
    if (this.store.pending().length) return balances;
    let cash = "0";
    const owned = {};
    for (const b of Object.values(s.bots)) {
      // A paper arm's simulated cash is not on the exchange, so including it
      // would demand real funds the account does not hold.
      if (this.isPaper(b.id)) continue;
      cash = add(cash, b.cash);
      for (const p of Array.isArray(b.positions) ? b.positions : []) {
        const coin = p.product.split("-")[0];
        owned[coin] = add(owned[coin] ?? "0", p.quantity);
      }
    }
    if (dec(balances.USDC ?? "0") < dec(cash))
      throw Error("Exchange USDC is below combined bot cash allocation");
    for (const [coin, qty] of Object.entries(owned))
      if (dec(balances[coin] ?? "0") < dec(qty))
        throw Error("Exchange holdings are below bot-owned quantity");
    this.health.account = { ok: true, at: Date.now() };
    return balances;
  }
  async execute(id, side, product, reason, evidence = null) {
    if (this.stopped) return;
    if (this.config.mode !== "live") {
      this.store.event("veto", {
        bot: id,
        reason: "Observe mode: no real orders",
        intendedAction: side,
        product,
      });
      return;
    }
    const rules = this.effectiveRules(id),
      state = this.store.read(),
      bot = state.bots[id];
    const paper = this.isPaper(id);
    // A paper arm has no exchange, so exchange lot/precision flooring does not
    // apply: its simulated sizes are whatever the sizing code produced. Only a
    // real order is rounded down to the product's increment.
    const step = (value, increment) =>
      paper ? str(dec(value)) : floorStep(value, increment);
    if (this.store.pending().some((o) => o.bot === id)) return;
    if (side === "BUY" && (state.paused || state.halt)) return;
    const p = await this.exchange.product(product);
    assertTradable(p, product);
    const q = await this.market.quote(product);
    // Account/capital discrepancies block new exposure, not a valid protective
    // sale. A paper arm holds no real funds, so it is exempt: its own ledger
    // reserves are the only limit that applies to it.
    const balances = paper
      ? null
      : side === "BUY"
        ? await this.reconcileBalances()
        : await this.accounts();
    let size,
      reserve = "0",
      policy = null,
      takerFee = null;
    if (side === "BUY") {
      if (!evidence) throw refuse("No entry evidence");
      if (Date.now() - evidence.at > this.config.maxAnalysisAgeMs)
        throw refuse("Analysis expired before execution");
      // The control arm has no setup to qualify; its randomness is the point.
      if (!evidence.control && !eligibility(id, { ...evidence, ...q }, rules)) {
        const merged = { ...evidence, ...q };
        // Say exactly which entry condition failed, rather than implying a
        // change that did not happen.
        const why = evidence.strategyVersion
          ? (entryRejection(id, merged) ?? "Entry no longer qualifies")
          : "Entry no longer qualifies";
        throw refuse(why);
      }
      // Re-check capacity and duplicates against live state: another cycle may
      // have filled a slot while this decision was being assessed.
      const held = Array.isArray(bot.positions) ? bot.positions : [];
      if (held.length >= this.store.maxPositions(id))
        throw refuse("Position limit reached while decision was pending");
      if (held.some((x) => x.product === product))
        throw refuse("Bot already holds this pair");
      const fee = await this.exchange.fees();
      const feeRate = String(fee.fee_tier?.taker_fee_rate ?? "");
      takerFee = feeRate;
      if (!(Number(feeRate) >= 0 && Number(feeRate) < 0.1))
        throw Error("Actual fee rate unavailable");
      const budget = mul(
        sub(bot.cash, bot.reserved),
        String(rules.tradeFraction),
      );
      // Fee reserve includes a 0.1% buffer; no confidence-based sizing.
      const divisor = dec(add("1.001", feeRate));
      size = step(str((dec(budget) * dec("1")) / divisor), p.quote_increment);
      if (evidence.strategyVersion || evidence.control) {
        policy = executionPlan(
          evidence,
          q,
          Number(sub(bot.cash, bot.reserved)),
          Number(feeRate),
          rules,
        );
        size = step(policy.quote.toFixed(18), p.quote_increment);
        // The control has no strategy exit plan: its stops are the pct stops in
        // config, so the sizing plan is used but the policy is not attached.
        if (!evidence.strategyVersion) policy = null;
      }
      reserve = add(size, mul(size, add(feeRate, "0.001")));
      const totalReserved = Object.values(state.bots)
        .filter((b2) => !this.isPaper(b2.id))
        .reduce((n, b2) => n + dec(b2.reserved), 0n);
      if (!paper && dec(reserve) > dec(balances.USDC ?? "0") - totalReserved)
        throw refuse("Insufficient unreserved exchange cash");
      // A paper arm has no exchange to satisfy, so it may open any simulated
      // size; only a real order is bound by the product's minimum.
      if (
        !paper &&
        (dec(size) < dec(p.quote_min_size) ||
          Number(size) / q.ask < Number(p.base_min_size))
      )
        throw refuse("Below product minimum");
      if (p.quote_max_size && dec(size) > dec(p.quote_max_size))
        throw refuse("Above product maximum");
    } else {
      const held = Array.isArray(bot.positions)
        ? bot.positions.find((x) => x.product === product)
        : null;
      if (!held) throw refuse("Position changed while decision was pending");
      // A paper fill is simulated locally, so the exchange lot size does not
      // apply either: sell the full held quantity, even a sub-lot remainder.
      size = step(held.quantity, p.base_increment);
      // Only a real order is bound by the exchange minimum. A paper arm can
      // always close its own simulated dust, so it cannot strand a position.
      if (
        !paper &&
        (dec(size) < dec(p.base_min_size) ||
          Number(size) * q.bid < Number(p.quote_min_size))
      )
        throw Error(
          "Residual holding below exchange minimum; needs owner review",
        );
      if (dec(size) > dec(balances?.[product.split("-")[0]] ?? "0") && !paper)
        throw refuse("Insufficient exchange asset balance");
    }
    if (this.stopped) return;
    // Recheck freshness after private API reads and immediately before reserving/submitting.
    if (
      side === "BUY" &&
      Date.now() - evidence.at > this.config.maxAnalysisAgeMs
    )
      throw refuse("Entry evidence expired");
    const freshQuote = await this.market.quote(product);
    if (
      side === "BUY" &&
      !evidence.control &&
      !eligibility(id, { ...evidence, ...freshQuote }, rules)
    )
      throw refuse("Entry changed during validation");
    if (side === "BUY" && policy) {
      const checked = executionPlan(
        evidence,
        freshQuote,
        Number(sub(bot.cash, bot.reserved)),
        Number(takerFee),
        rules,
      );
      const bounded = step(checked.quote.toFixed(18), p.quote_increment);
      if (dec(bounded) < dec(size)) size = bounded;
      reserve = add(size, mul(size, add(takerFee, "0.001")));
      if (
        !paper &&
        (dec(size) < dec(p.quote_min_size) ||
          Number(size) / freshQuote.ask < Number(p.base_min_size))
      )
        throw refuse("Risk-sized order below product minimum");
      policy = checked;
    }
    const order = this.store.reserve({
      bot: id,
      product,
      side,
      size,
      reserve,
      reason,
      ...rules,
      policy: policy
        ? { ...policy, bot: id, trailAtr: rules.trailAtr, trailR: rules.trailR }
        : null,
    });
    try {
      // A paper arm never touches the exchange. Its fill is simulated at the
      // touch with the real taker fee and booked through the same ledger path a
      // real fill uses, so positions, P&L and protective exits behave
      // identically. Switching the arm to real funds is `paper: false`.
      if (paper) {
        const fee = await this.exchange.fees();
        const rate = Number(fee.fee_tier?.taker_fee_rate ?? 0);
        if (!(rate >= 0 && rate < 0.1))
          throw Error("Actual fee rate unavailable");
        this.store.acknowledge(order.id, "paper-" + order.id);
        this.store.applyOrder(order.id, paperFill(order, q, rate));
        return order.id;
      }
      const r = await this.exchange.create({
        client_order_id: order.id,
        product_id: product,
        side,
        size,
      });
      if (r.success === false) {
        this.store.reject(order.id);
        return null;
      }
      const exchangeId = r.success_response?.order_id;
      if (!exchangeId) throw Error("No exchange order acknowledgement");
      this.store.acknowledge(order.id, exchangeId);
      return order.id;
    } catch {
      this.store.unknown(order.id);
      return null;
    }
  }
  async reconcileOrders() {
    for (const o of this.store.pending()) {
      try {
        let exchangeId = o.exchangeId;
        if (!exchangeId) {
          const r = await this.exchange.find(o.id, o.created);
          if (!r.order) continue; // Never repeat a submission just because a search is empty.
          exchangeId = r.order.order_id;
          this.store.acknowledge(o.id, exchangeId);
        }
        const r = await this.exchange.order(exchangeId);
        const x = r.order;
        const previous = this.store.read().orders[o.id];
        if (
          x &&
          (String(x.filled_size ?? "0") !== previous.filled ||
            String(x.filled_value ?? "0") !== previous.value ||
            String(x.total_fees ?? "0") !== previous.fees ||
            x.status !== previous.exchangeStatus ||
            x.settled === true)
        )
          this.store.applyOrder(o.id, x);
        this.setError(`reconciliation:${o.id}`, null);
      } catch (e) {
        this.setError(`reconciliation:${o.id}`, e.message);
        this.store.event("error", {
          bot: o.bot,
          clientId: o.id,
          component: "reconciliation",
          message: e.message,
        });
      }
    }
  }
  async protect() {
    if (this.protectBusy || this.stopped) return;
    this.protectBusy = true;
    try {
      await this.serial(async () => {
        await this.reconcileOrders();
        for (const id of this.botIds()) {
          try {
            const b = this.store.read().bots[id];
            const positions = Array.isArray(b.positions) ? b.positions : [];
            if (!positions.length) {
              this.setError(`protection:${id}`, null);
              continue;
            }
            // One order in flight per bot: an unresolved exit blocks the rest
            // until it reconciles, so positions are worked off sequentially.
            if (this.store.pending().some((o) => o.bot === id)) continue;
            for (const p of positions) {
              const q = await this.market.quote(p.product),
                entry = Number(p.cost) / Number(p.quantity);
              if (p.policy) {
                const result = this.strategyExit(id, p, q);
                if (result) {
                  await this.execute(id, "SELL", p.product, result);
                  break;
                }
                continue;
              }
              const peak = Math.max(Number(p.peak), q.bid, entry);
              this.store.change((s) => {
                const live = Array.isArray(s.bots[id].positions)
                  ? s.bots[id].positions
                  : [];
                const t = live.find(
                  (x) => x.product === p.product && x.opened === p.opened,
                );
                if (t) t.peak = String(peak);
              });
              const hard = q.bid <= entry * (1 - p.stopPct / 100);
              const trailing =
                peak >= entry * (1 + p.trailActivationPct / 100) &&
                q.bid <= peak * (1 - p.trailPct / 100);
              const expired =
                p.maxHoldHours > 0 &&
                Date.now() - p.opened > p.maxHoldHours * 3600000;
              if (hard || trailing || expired) {
                await this.execute(
                  id,
                  "SELL",
                  p.product,
                  hard
                    ? "Protective stop"
                    : trailing
                      ? "Trailing exit"
                      : "Maximum holding time",
                );
                break;
              }
            }
            this.setError(`protection:${id}`, null);
          } catch (e) {
            if (isRefusal(e)) {
              this.store.event("veto", { bot: id, reason: e.message });
              this.setError(`protection:${id}`, null);
            } else {
              this.setError(`protection:${id}`, e.message);
              this.store.event("error", {
                bot: id,
                component: "protection",
                message: e.message,
              });
            }
          }
        }
        this.lastProtection = Date.now();
      });
      this.setError("execution", null);
    } catch (e) {
      this.setError("execution", e.message);
      this.store.event("error", { component: "execution", message: e.message });
    } finally {
      this.protectBusy = false;
    }
  }
  strategyExit(id, p, q) {
    const policy = { ...p.policy };
    if (q.bid <= policy.stopPrice) return "Strategy protective stop";
    const f = this.market.snapshot(id).find((x) => x.product === p.product);
    if (!f) return null; // Existing price stop survives missing indicator data.
    const entry = Number(p.cost) / Number(p.quantity);
    if (f.signalTime !== policy.lastBar) {
      policy.lastBar = f.signalTime;
      policy.peakClose = Math.max(policy.peakClose ?? entry, f.close);
      if (policy.peakClose - entry >= policy.trailR * policy.initialRisk)
        policy.stopPrice = Math.max(
          policy.stopPrice,
          policy.peakClose - policy.trailAtr * f.atr,
        );
      if (id === "momentum" && f.rankTime !== policy.lastRankTime) {
        policy.lastRankTime = f.rankTime;
        policy.weakRanks =
          f.rankPercentile < 0.5 ? (policy.weakRanks ?? 0) + 1 : 0;
      }
      this.store.change((s) => {
        const live = Array.isArray(s.bots[id].positions)
          ? s.bots[id].positions
          : [];
        const t = live.find(
          (x) => x.product === p.product && x.opened === p.opened,
        );
        if (t) t.policy = policy;
      });
    }
    if (q.bid <= policy.stopPrice) return "Strategy trailing stop";
    if (id === "breakout") {
      if (f.close < policy.breakoutLevel) return "Breakout failed";
      if (
        f.signalTime - policy.signalTime >= 12 * 300000 &&
        policy.peakClose - entry < policy.initialRisk
      )
        return "Breakout follow-through expired";
    }
    if (id === "trend" && f.contextClose < f.ema50)
      return "Four-hour trend invalidated";
    if (
      id === "momentum" &&
      ((policy.weakRanks ?? 0) >= 2 ||
        (f.momentum24hPct <= 0 && f.hourClose < f.ema20))
    )
      return "Relative momentum deteriorated";
    return null;
  }
  snapshot() {
    const s = this.store.read();
    const results = performance(s.orders);
    return {
      mode: this.config.mode,
      // Identifies the backend build. public/ is re-read per request while src/
      // is cached at import, so a frontend-only deploy leaves the browser and
      // the API on different versions. The dashboard compares this against the
      // version it was shipped with and reports the mismatch.
      build: BUILD,
      review: s.lastReview ?? null,
      reviewError: s.lastReviewError ?? null,
      reviewing: !!this.reviewing,
      paused: s.paused,
      halt: s.halt,
      ruleHash: this.currentRuleHash(),
      bots: this.store.value(this.market.prices()).map((b) => ({
        ...b,
        performance: results.stats[b.id] || {
          wins: 0,
          losses: 0,
          breakeven: 0,
          unknown: 0,
        },
      })),
      orders: Object.values(s.orders)
        .slice(-100)
        .map((o) => ({ ...o, realisedPnl: results.sales[o.id] ?? null })),
      health: this.health,
      market: this.market.snapshot(),
      coverage: this.market.coverage?.() ?? null,
      strategyVersion: this.config.strategyVersion ?? 1,
      modelUsage: (() => {
        const u = this.store.normaliseUsage(s.modelUsage ?? null);
        if (!u) return null;
        // costNanos is a decimal string in storage; it never leaves as a BigInt,
        // which JSON cannot represent.
        const cost = (n) => (/^\d+$/.test(String(n ?? "")) ? String(n) : "0");
        return {
          ...u,
          costNanos: cost(u.costNanos),
          perModel: Object.fromEntries(
            Object.entries(u.perModel ?? {}).map(([k, p]) => [
              k,
              { ...p, costNanos: cost(p.costNanos) },
            ]),
          ),
        };
      })(),
      model: this.modelInfo(),
      latestAnalyses: this.store.db
        .prepare(
          "SELECT id,ts,body FROM events WHERE kind='analysis' ORDER BY id DESC LIMIT 30",
        )
        .all()
        .map((r) => ({ id: r.id, ts: r.ts, ...JSON.parse(r.body) })),
      lastProtection: this.lastProtection,
      lastCycle: this.lastCycle,
      history: this.store.history(),
      rules: this.effectiveRulesMap(),
    };
  }
}
