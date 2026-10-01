// Jev (TypeSafe AI) System One client. Dependency-free HTTP, so no SDK is
// installed: the same state + questions contract as the Laya socket, sent to
// POST https://api.typesafe.ai/v1/systemone.
//
//   state in, typed answers out: a `choice` over the valid moves plus a `score`
//   for conviction. Jev never generates text, so there is no parsing to do.
//
// Fail-closed: any failure returns { ok: false, ... } and the caller holds, so a
// Jev outage opens nothing. A daily USD cap (computed from the input-token rate)
// and exponential backoff on 429/529/5xx bound the spend and the latency.
//
// The key is supplied by the dashboard settings (see settings.effectiveJev) or,
// before any selection, TYPESAFE_API_KEY. It is never logged.
const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MAX_RESPONSE = 1024 * 1024;

export class Jev {
  constructor(opts = {}, settings = null) {
    this.settings = settings;
    this.model = opts.model ?? "jev-1.13.0";
    this.timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 2000;
    this.dailyUsdCap = Number.isFinite(opts.dailyUsdCap)
      ? opts.dailyUsdCap
      : 20;
    this.usdPerMTok = Number.isFinite(opts.usdPerMTok)
      ? opts.usdPerMTok
      : 0.042;
    // An injected client lets tests exercise the paths without a network. It
    // must expose systemOne(req, opts) returning a TypeSafe-shaped response.
    this.client = opts.client ?? null;
    this.now = opts.now ?? Date.now;
    this.spentTodayUsd = 0;
    this.day = this.dayKey(this.now());
    this.backoffUntil = 0;
    this.backoffStep = 0;
  }

  dayKey(ms) {
    return new Date(ms).toISOString().slice(0, 10);
  }

  rollDay() {
    const d = this.dayKey(this.now());
    if (d !== this.day) {
      this.day = d;
      this.spentTodayUsd = 0;
    }
  }

  // Effective key/model: the dashboard selection first, then the owner's
  // environment. resolve() is internal; only the key matters here, and it never
  // leaves this object.
  resolve() {
    const e = this.settings?.effectiveJev?.();
    return {
      key: e?.key ?? process.env.TYPESAFE_API_KEY ?? null,
      model: e?.model ?? this.model,
    };
  }

  hasKey() {
    return !!this.resolve().key;
  }

  get capTripped() {
    this.rollDay();
    return this.spentTodayUsd >= this.dailyUsdCap;
  }

  async systemOne(state, questions, timeoutMs = this.timeoutMs) {
    const { key, model } = this.resolve();
    if (!key)
      throw Object.assign(Error("Jev API key unavailable"), { status: 401 });
    if (this.client)
      return this.client.systemOne({ state, model, questions }, { timeoutMs });
    let res;
    try {
      res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({ state, model, questions }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      // A timeout or socket error is transient in the same way as a 503.
      throw Object.assign(Error(e.message), { status: 503 });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let body = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
      throw Object.assign(Error(`Jev HTTP ${res.status}`), {
        status: res.status,
        body,
      });
    }
    const body = await res.json();
    if (body?.error && !body.answers)
      throw Object.assign(
        Error(
          typeof body.error.message === "string"
            ? `Jev rejected: ${body.error.message}`
            : "Jev rejected the request",
        ),
        { status: 400, body: body.error },
      );
    return body;
  }

  // Ask Jev to pick one move and rate its conviction. Fail-closed: a missing
  // key, a tripped cap, an active backoff, or any error returns ok: false and
  // the caller holds rather than trading.
  async decide({
    state,
    menu,
    convictionLabels = [],
    timeoutMs = this.timeoutMs,
  }) {
    const t0 = this.now();
    if (!this.hasKey()) return { ok: false, reason: "no_key", latencyMs: 0 };
    if (this.capTripped)
      return { ok: false, reason: "daily_cap", latencyMs: 0 };
    if (t0 < this.backoffUntil)
      return { ok: false, reason: "backoff", latencyMs: 0 };
    const labels = Object.keys(menu ?? {});
    if (!labels.length)
      return {
        ok: false,
        reason: "error",
        error: { code: "EMPTY_MENU", message: "no valid options" },
        latencyMs: 0,
      };
    try {
      const r = await this.systemOne(
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
      const latencyMs = this.now() - t0;
      const a = r?.answers?.action,
        c = r?.answers?.conviction;
      if (!a || typeof a.choice !== "string" || !labels.includes(a.choice))
        return {
          ok: false,
          reason: "error",
          error: { code: "OFF_MENU", message: "choice not in menu" },
          latencyMs,
        };
      const inputTokens = Number(r?.usage?.input_tokens) || 0;
      const costUsd = (inputTokens * this.usdPerMTok) / 1e6;
      this.rollDay();
      this.spentTodayUsd += costUsd;
      this.backoffStep = 0;
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
        inputTokens,
        costUsd,
        model: r?.model ?? this.resolve().model,
        latencyMs,
      };
    } catch (err) {
      const latencyMs = this.now() - t0;
      const status = err?.status;
      if (
        status === 429 ||
        status === 529 ||
        (status !== undefined && status >= 500)
      ) {
        this.backoffStep = Math.min(this.backoffStep + 1, 6);
        this.backoffUntil =
          this.now() + Math.min(60000, 1000 * 2 ** this.backoffStep);
      }
      return {
        ok: false,
        reason: status === 429 || status === 529 ? "backoff" : "error",
        error: {
          code: err?.code ?? String(status ?? "ERROR"),
          message: err?.message ?? "Jev call failed",
        },
        latencyMs,
      };
    }
  }

  // Dashboard "Test connection": one tiny real call that proves the key works.
  // The response body is discarded; only success is reported.
  async probe(timeoutMs = 10000) {
    await this.systemOne(
      { check: "connection" },
      {
        ok: {
          type: "choice",
          instructions: "Is this a connection test?",
          criteria: { YES: "Yes", NO: "No" },
        },
      },
      timeoutMs,
    );
    return { ok: true, model: this.resolve().model };
  }
}
