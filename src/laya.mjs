import net from "node:net";
import { readJsonOverride } from "./overrides.mjs";
import { isVariant, variantQuestions } from "./analysis-variants.mjs";

// The default trading-classification questions Laya answers per candidate. The
// Trade Review may override these; the heads and answer types are fixed so the
// response schema stays checkable, while the instructions (and choice labels)
// are editable.
export function defaultAnalysisQuestions(style) {
  return {
    regime: {
      type: "choice",
      instructions:
        "Classify the observed price context, not a trading action.",
      criteria: {
        uptrend: "Sustained upward trend",
        range: "Sideways range",
        downtrend: "Downward trend",
        unclear: "Insufficient or conflicting evidence",
      },
    },
    fit: {
      type: "score",
      instructions: `Classify evidence of a ${style} setup. Do not choose a trade.`,
      criteria: ["weak", "mixed", "strong"],
    },
    quality: {
      type: "choice",
      instructions: "Classify the supplied evidence quality.",
      criteria: {
        complete: "Complete and consistent",
        mixed: "Conflicting signals",
        insufficient: "Missing important evidence",
      },
    },
  };
}

// Merge an override onto the defaults so a partial file still works. When a
// variant is named (the no-LLM analysis policy), its pre-authored question set is
// the base instead of the bundled default.
export function resolveAnalysisQuestions(style, override, variant = null) {
  const base = isVariant(variant)
    ? variantQuestions(style, variant)
    : defaultAnalysisQuestions(style);
  if (!override || typeof override !== "object") return base;
  return {
    regime: { ...base.regime, ...override.regime },
    fit: { ...base.fit, ...override.fit },
    quality: { ...base.quality, ...override.quality },
  };
}

// The daemon's per-request batch cap (laya_serve BATCH_CAP). Larger sets are
// chunked to this size.
const BATCH_MAX = 32;
// Candidate evidence compacted for the checkpoint. Shared by the single and the
// batched path so both send exactly the same fields.
const COMPACT_KEYS = [
  "close",
  "previousClose",
  "channelHigh",
  "channelLow",
  "ema20",
  "ema50",
  "hourClose",
  "hourPrevious",
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
  "contextClose",
];
function compactState(state) {
  const compact = { product: state.product, period: state.period };
  for (const key of COMPACT_KEYS)
    if (Number.isFinite(state[key]))
      compact[key] = Number(state[key].toPrecision(6));
  return compact;
}
// Validate one answer against its question set. Returns null or an error string.
function answerError(questions, answers) {
  const regimeChoices = Object.keys(questions.regime.criteria ?? {});
  const qualityChoices = Object.keys(questions.quality.criteria ?? {});
  const fitMax = Math.max(0, (questions.fit.criteria?.length ?? 3) - 1);
  if (
    !answers ||
    !Number.isFinite(answers.fit?.score) ||
    answers.fit.score < 0 ||
    answers.fit.score > fitMax ||
    !regimeChoices.includes(answers.regime?.choice) ||
    !qualityChoices.includes(answers.quality?.choice)
  )
    return "Unexpected Laya answer schema";
  return null;
}

export class Laya {
  constructor(socketPath, timeoutMs = 30000, dataDir = null) {
    this.path = socketPath;
    this.timeoutMs = timeoutMs;
    this.dataDir = dataDir;
    this.tail = Promise.resolve();
  }
  questionsOverride() {
    return this.dataDir
      ? readJsonOverride(this.dataDir, "laya.analysisQuestions", null)
      : null;
  }
  // The selected analysis policy variant, if a valid one is stored.
  analysisVariant() {
    const p = this.dataDir
      ? readJsonOverride(this.dataDir, "laya.analysisPolicy", null)
      : null;
    return isVariant(p?.variant) ? p.variant : null;
  }
  request(body, timeoutMs = this.timeoutMs) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.path);
      let data = Buffer.alloc(0),
        done = false;
      const finish = (e, r) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.destroy();
        e ? reject(e) : resolve(r);
      };
      const timer = setTimeout(
        () => finish(Error("Laya response deadline exceeded")),
        timeoutMs,
      );
      socket.on("connect", () => socket.write(JSON.stringify(body) + "\n"));
      socket.on("error", () => finish(Error("Laya socket unavailable")));
      socket.on("end", () => finish(Error("Incomplete Laya response")));
      socket.on("data", (chunk) => {
        data = Buffer.concat([data, chunk]);
        if (data.length > 1024 * 1024)
          return finish(Error("Oversized Laya response"));
        const end = data.indexOf(10);
        if (end < 0) return;
        let r;
        try {
          r = JSON.parse(data.subarray(0, end).toString("utf8"));
        } catch {
          return finish(Error("Invalid Laya response"));
        }
        if (r.ok !== true)
          return finish(
            Error(
              r.error
                ? `Laya error: ${r.error}`
                : "Laya inference was not successful",
            ),
          );
        finish(null, r);
      });
    });
  }
  ping() {
    return this.request({ ping: true });
  }
  // Generic call. The daemon hands `state` and `questions` straight to the model,
  // so a caller may send free text (a whole hour of decisions) as state and use
  // arbitrary heads - `noul`, `choice`, `score` - not just the trading schema
  // above. Serialised behind analyze() so the single GPU never runs two at once.
  ask(state, questions, timeoutMs = this.timeoutMs) {
    const run = async () => {
      const r = await this.request({ state, questions }, timeoutMs);
      if (!r.answers || typeof r.answers !== "object")
        throw Error("Unexpected Laya answer schema");
      return {
        answers: r.answers,
        elapsed_s: r.elapsed_s,
        queue_depth: r.queue_depth,
      };
    };
    const p = this.tail.then(run);
    this.tail = p.catch(() => {});
    return p;
  }
  // The classifier-only and Laya+LLM engines ask Laya to pick one move from the
  // valid menu and score its conviction - the same choice/score contract Jev
  // speaks. Laya is a System One model too, so this needs no new machinery.
  // Throws on failure; the engine's per-bot catch holds the bot.
  async decide({
    state,
    menu,
    convictionLabels = [],
    timeoutMs = this.timeoutMs,
  }) {
    const labels = Object.keys(menu ?? {});
    const r = await this.ask(
      state,
      {
        action: {
          type: "choice",
          instructions: "Pick your next move from the valid options.",
          criteria: menu,
        },
        conviction: {
          type: "score",
          instructions: "How strong is the evidence for that move?",
          criteria: convictionLabels,
        },
      },
      timeoutMs,
    );
    const a = r.answers?.action,
      c = r.answers?.conviction;
    if (!a || typeof a.choice !== "string" || !labels.includes(a.choice))
      throw Error("Unexpected Laya action schema");
    const maxConv = Math.max(0, convictionLabels.length - 1);
    return {
      ok: true,
      choice: a.choice,
      probabilities: a.probabilities ?? null,
      confidence: Number.isFinite(a.confidence) ? a.confidence : null,
      conviction: Number.isFinite(c?.score)
        ? Math.max(0, Math.min(maxConv, Math.round(c.score)))
        : null,
      convictionRaw: Number.isFinite(c?.score) ? c.score : null,
      model: "laya",
      answers: r.answers,
      elapsed_s: r.elapsed_s,
      queue_depth: r.queue_depth,
    };
  }
  analyze(state, style) {
    // One in-flight inference from this application; no automatic retry after timeout.
    const run = async () => {
      const health = await this.ping();
      if (!health.ready) throw Error("Laya model not ready");
      const queueDepth = Number.isInteger(health.queue_depth)
        ? Math.max(0, health.queue_depth)
        : 0;
      if (queueDepth > 8)
        throw Error("Laya queue congested; analysis deferred");
      const deadline = Math.min(60000, this.timeoutMs * (1 + queueDepth));
      // Compact bounded evidence fits the checkpoint; full precision stays in execution code.
      const compact = { product: state.product, period: state.period };
      for (const key of [
        "close",
        "previousClose",
        "channelHigh",
        "channelLow",
        "ema20",
        "ema50",
        "hourClose",
        "hourPrevious",
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
        "contextClose",
      ])
        if (Number.isFinite(state[key]))
          compact[key] = Number(state[key].toPrecision(6));
      // The questions may have been overridden by an applied Trade Review
      // proposal; the heads and answer types are fixed, so validation reads the
      // effective criteria rather than a hard-coded set.
      const questions = resolveAnalysisQuestions(
        style,
        this.questionsOverride(),
        this.analysisVariant(),
      );
      const r = await this.request({ state: compact, questions }, deadline);
      const regimeChoices = Object.keys(questions.regime.criteria ?? {});
      const qualityChoices = Object.keys(questions.quality.criteria ?? {});
      const fitMax = Math.max(0, (questions.fit.criteria?.length ?? 3) - 1);
      if (
        !r.answers ||
        !Number.isFinite(r.answers.fit?.score) ||
        r.answers.fit.score < 0 ||
        r.answers.fit.score > fitMax ||
        !regimeChoices.includes(r.answers.regime?.choice) ||
        !qualityChoices.includes(r.answers.quality?.choice)
      )
        throw Error("Unexpected Laya answer schema");
      return {
        answers: r.answers,
        elapsed_s: r.elapsed_s,
        queue_depth: r.queue_depth,
        calibrated: false,
      };
    };
    const p = this.tail.then(run);
    this.tail = p.catch(() => {});
    return p;
  }
  // One request carrying many candidates that share a question set (one bot's
  // cycle). The daemon groups by questions and runs a single forward pass.
  batch(items, timeoutMs = this.timeoutMs) {
    return this.request({ batch: items }, timeoutMs);
  }
  // Classify many candidates for one bot in one inference. Returns results
  // aligned to `candidates`; each item is `{ answers, elapsed_s }` or `{ error }`,
  // so one bad row degrades that candidate, never the bot.
  async analyzeBatch(candidates, style, timeoutMs = this.timeoutMs) {
    if (!candidates?.length)
      return { results: [], queue_depth: 0, elapsed_s: 0, batch_size: 0 };
    const questions = resolveAnalysisQuestions(
      style,
      this.questionsOverride(),
      this.analysisVariant(),
    );
    const results = [];
    let queue_depth = 0,
      elapsed_s = 0,
      batch_size = 0;
    // The daemon caps one request at BATCH_MAX; split larger sets into
    // sequential chunks (the GPU runs one inference at a time anyway) and merge.
    // A chunk that fails is retried once, then falls back to serial calls for
    // that chunk only - a bad chunk never forces the whole bot to serial.
    const serial = async (chunk) => {
      for (const c of chunk) {
        try {
          const a = await this.analyze(c, style, timeoutMs);
          results.push({ answers: a.answers, elapsed_s: a.elapsed_s ?? null });
        } catch (e) {
          results.push({ error: e.message });
        }
      }
    };
    for (let i = 0; i < candidates.length; i += BATCH_MAX) {
      const chunk = candidates.slice(i, i + BATCH_MAX);
      const items = chunk.map((state) => ({
        state: compactState(state),
        questions,
      }));
      let r = null;
      try {
        r = await this.batch(items, timeoutMs);
      } catch {
        try {
          r = await this.batch(items, timeoutMs);
        } catch {
          await serial(chunk);
          continue;
        }
      }
      if (!Array.isArray(r?.batch) || r.batch.length !== chunk.length) {
        await serial(chunk);
        continue;
      }
      for (const res of r.batch) {
        if (!res || res.ok !== true) {
          results.push({ error: res?.error ?? "batch item failed" });
          continue;
        }
        const err = answerError(questions, res.answers);
        results.push(
          err
            ? { error: err }
            : { answers: res.answers, elapsed_s: res.elapsed_s ?? null },
        );
      }
      queue_depth = Math.max(queue_depth, r.queue_depth ?? 0);
      elapsed_s += Number(r.elapsed_s) || 0;
      batch_size += r.batch_size ?? chunk.length;
    }
    return {
      results,
      queue_depth,
      elapsed_s: Number(elapsed_s.toFixed(3)),
      batch_size,
    };
  }
}
