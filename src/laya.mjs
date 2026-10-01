import net from "node:net";
export class Laya {
  constructor(socketPath, timeoutMs = 30000) {
    this.path = socketPath;
    this.timeoutMs = timeoutMs;
    this.tail = Promise.resolve();
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
        try {
          const r = JSON.parse(data.subarray(0, end).toString("utf8"));
          if (r.ok !== true) throw Error("Laya inference failed");
          finish(null, r);
        } catch {
          finish(Error("Invalid or unsuccessful Laya response"));
        }
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
      const r = await this.request(
        {
          state: compact,
          questions: {
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
          },
        },
        deadline,
      );
      if (
        !r.answers ||
        !Number.isFinite(r.answers.fit?.score) ||
        r.answers.fit.score < 0 ||
        r.answers.fit.score > 2 ||
        !["uptrend", "range", "downtrend", "unclear"].includes(
          r.answers.regime?.choice,
        ) ||
        !["complete", "mixed", "insufficient"].includes(
          r.answers.quality?.choice,
        )
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
}
