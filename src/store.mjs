import { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { ALL_BOTS } from "./config.mjs";
import { dec, str, add, sub, mul } from "./decimal.mjs";
const ACTIVE = new Set(["SUBMITTING", "UNKNOWN", "OPEN"]);
export class Store extends EventEmitter {
  constructor(path, config) {
    super();
    this.config = config;
    this.path = path;
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS state(id INTEGER PRIMARY KEY CHECK(id=1),body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,ts INTEGER NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS equity(ts INTEGER NOT NULL,bot TEXT NOT NULL,equity REAL NOT NULL);",
    );
    if (!this.db.prepare("SELECT id FROM state WHERE id=1").get()) {
      const bots = Object.fromEntries(
        ALL_BOTS.filter((id) => config.bots?.[id]).map((id) => [
          id,
          this.freshBot(id),
        ]),
      );
      this.db.prepare("INSERT INTO state VALUES(1,?)").run(
        JSON.stringify({
          bots,
          orders: {},
          portfolio: config.coinbasePortfolioId ?? "",
          paused: true,
          halt: null,
          created: Date.now(),
        }),
      );
    }
    this.migratePositions();
    this.migrateRoster();
    for (const id of ALL_BOTS)
      if (
        config.bots?.[id] &&
        this.read().bots[id] &&
        String(config.bots[id].capital) !== this.read().bots[id].capital
      )
        throw Error(
          "Capital differs from persisted ledger; explicit ledger funding migration required",
        );
    if ((this.read().portfolio ?? "") !== (config.coinbasePortfolioId ?? ""))
      throw Error("Configured portfolio differs from ledger");
  }
  // The shape of a freshly funded bot. Shared by first-time init and the roster
  // migration so the two cannot drift.
  freshBot(id) {
    const c = this.config.bots[id];
    return {
      id,
      name: c.name,
      capital: String(c.capital),
      cash: String(c.capital),
      reserved: "0",
      fees: "0",
      realised: "0",
      positions: [],
      peakEquity: Number(c.capital),
      drawdown: 0,
      trades: 0,
      lastDecision: null,
    };
  }
  // A bot named in config but absent from an existing ledger is ADDED, never
  // assumed. Before 2.5.0 the roster was frozen at ledger creation, so adding a
  // bot (the control arm) to a running ledger dereferenced an undefined bot and
  // crashed the runtime on every start. Idempotent; records no audit event.
  migrateRoster() {
    const s = this.read();
    let changed = false;
    for (const id of ALL_BOTS)
      if (this.config.bots?.[id] && !s.bots[id]) {
        s.bots[id] = this.freshBot(id);
        changed = true;
      }
    if (!changed) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("UPDATE state SET body=? WHERE id=1")
        .run(JSON.stringify(s));
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  // 2.3.0 moved a bot's single `position` onto a `positions` array. Convert a
  // ledger written by an earlier runtime, preserving the open position and its
  // policy exactly. Idempotent: a migrated row is left untouched, so this is
  // safe on every start.
  migratePositions() {
    const s = this.read();
    let changed = false;
    for (const id of Object.keys(s.bots)) {
      const b = s.bots[id];
      if (!b || Array.isArray(b.positions)) {
        if (b && !Array.isArray(b.positions)) {
          // Defensive: a value that is neither null nor an array is unusable.
          b.positions = b.position ? [b.position] : [];
          changed = true;
        }
        if (b && Object.hasOwn(b, "position")) {
          delete b.position;
          changed = true;
        }
        continue;
      }
      b.positions = b.position ? [b.position] : [];
      delete b.position;
      changed = true;
    }
    if (changed) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db
          .prepare("UPDATE state SET body=? WHERE id=1")
          .run(JSON.stringify(s));
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
    }
  }
  read() {
    return JSON.parse(
      this.db.prepare("SELECT body FROM state WHERE id=1").get().body,
    );
  }
  event(kind, body) {
    this.change(() => {}, kind, body);
  }
  change(fn, kind, body) {
    this.db.exec("BEGIN IMMEDIATE");
    let event;
    try {
      const state = this.read();
      fn(state);
      this.db
        .prepare("UPDATE state SET body=? WHERE id=1")
        .run(JSON.stringify(state));
      if (kind) {
        const ts = Date.now();
        const r = this.db
          .prepare("INSERT INTO events(ts,kind,body) VALUES(?,?,?)")
          .run(ts, kind, JSON.stringify(body));
        event = { id: Number(r.lastInsertRowid), ts, kind, ...body };
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    if (event) this.emit("event", event);
  }
  events(after = 0, limit = 200) {
    return this.db
      .prepare("SELECT * FROM events WHERE id>? ORDER BY id LIMIT ?")
      .all(after, limit)
      .map((r) => ({
        id: r.id,
        ts: r.ts,
        kind: r.kind,
        ...JSON.parse(r.body),
      }));
  }
  recent(limit = 100) {
    return this.db
      .prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?")
      .all(limit)
      .reverse()
      .map((r) => ({
        id: r.id,
        ts: r.ts,
        kind: r.kind,
        ...JSON.parse(r.body),
      }));
  }
  pending() {
    return Object.values(this.read().orders).filter((o) =>
      ACTIVE.has(o.status),
    );
  }
  // Repair a usage row written by an older runtime. Before per-model buckets
  // existed the engine wrote only {day, calls, tokens}, so a live ledger can hold
  // a row missing every other field. Arithmetic on `undefined` yields NaN and
  // `u.perModel[key]` throws outright, which aborted the whole bot cycle.
  // Normalise in place and persist, so the first call heals the row for good.
  normaliseUsage(u) {
    const num = (v) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    };
    if (!u || typeof u !== "object") return u;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(u.day ?? "")) return u;
    u.calls = num(u.calls);
    u.tokens = num(u.tokens);
    u.promptTokens = num(u.promptTokens);
    u.completionTokens = num(u.completionTokens);
    u.cachedTokens = num(u.cachedTokens);
    // costNanos is a decimal string; NaN must never reach BigInt().
    const c = String(u.costNanos ?? "0");
    u.costNanos = /^\d+$/.test(c) ? c : "0";
    if (
      !u.perModel ||
      typeof u.perModel !== "object" ||
      Array.isArray(u.perModel)
    )
      u.perModel = {};
    else
      for (const [k, p] of Object.entries(u.perModel)) {
        if (!p || typeof p !== "object") {
          delete u.perModel[k];
          continue;
        }
        p.calls = num(p.calls);
        p.tokens = num(p.tokens);
        const pc = String(p.costNanos ?? "0");
        p.costNanos = /^\d+$/.test(pc) ? pc : "0";
      }
    return u;
  }
  // Daily decision-model usage. The day is the UTC calendar date so a rollover is
  // unambiguous. per-model buckets keep a provider switch from hiding what the
  // previous model already spent today.
  // costNanos is held as a decimal string because this state is persisted as JSON,
  // which cannot serialise a BigInt. Arithmetic converts via BigInt() at the edges.
  emptyUsage(day) {
    return {
      day,
      calls: 0,
      tokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      costNanos: "0",
      perModel: {},
    };
  }
  // Accepts a BigInt, a decimal string or null. null records tokens without a
  // cost, which is the honest outcome for a model absent from the catalogue.
  // `usage` is the shape from providers.usageCounts: BigInt token counts.
  recordModelCall({ day, provider, model, usage, costNanos }) {
    if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day))
      throw Error("Invalid usage day");
    const add = (current, value) =>
      (BigInt(current ?? 0) + BigInt(value ?? 0)).toString();
    this.change((s) => {
      if (s.modelUsage?.day !== day) s.modelUsage = this.emptyUsage(day);
      // A row from an older runtime may lack the newer fields. Normalising here
      // is what prevents `undefined + n` becoming NaN and `perModel` being
      // undefined on a live ledger.
      const u = this.normaliseUsage(s.modelUsage);
      s.modelUsage = u;
      for (const field of [
        "promptTokens",
        "completionTokens",
        "cachedTokens",
      ]) {
        const n = Number(usage?.[field]);
        if (Number.isSafeInteger(n) && n > 0) u[field] += n;
      }
      const total = Number(usage?.totalTokens);
      if (Number.isSafeInteger(total) && total > 0) u.tokens += total;
      if (costNanos !== null && costNanos !== undefined) {
        if (BigInt(costNanos) < 0n) throw Error("Invalid model cost");
        u.costNanos = add(u.costNanos, costNanos);
      }
      const key = `${provider ?? "custom"}:${model}`;
      const p = (u.perModel[key] ??= {
        provider: provider ?? null,
        model,
        calls: 0,
        tokens: 0,
        costNanos: "0",
      });
      p.calls++;
      // usageCounts() reports `totalTokens`; reading `tokens` here left every
      // per-model token count at zero (visible on the live ledger as
      // calls:77, tokens:0). Fixed in 2.3.0.
      const t = Number(usage?.totalTokens);
      if (Number.isSafeInteger(t) && t > 0) p.tokens += t;
      if (costNanos !== null && costNanos !== undefined)
        p.costNanos = add(p.costNanos, costNanos);
    });
  }
  // Locate a bot's open position for a product. Positions are keyed by product,
  // so a bot can never hold the same pair twice.
  findPosition(b, product) {
    return (b.positions ?? []).find((p) => p.product === product) ?? null;
  }
  // Per-bot concurrency cap. Validated by config.mjs; defaults to 1 so an
  // un-migrated config behaves exactly as the single-position runtime did.
  maxPositions(botId) {
    const n = Number(this.config?.bots?.[botId]?.maxPositions);
    return Number.isInteger(n) && n >= 1 ? n : 1;
  }
  reserve({
    bot,
    product,
    side,
    size,
    reserve = "0",
    reason,
    stopPct,
    trailPct,
    trailActivationPct,
    maxHoldHours,
    policy = null,
  }) {
    const id = randomUUID();
    this.change(
      (s) => {
        const b = s.bots[bot];
        if (!b) throw Error("Unknown bot");
        if (!Array.isArray(b.positions)) b.positions = [];
        if (
          Object.values(s.orders).some(
            (o) => o.bot === bot && ACTIVE.has(o.status),
          )
        )
          throw Error("Bot has unresolved order");
        if (side === "BUY") {
          const max = this.maxPositions(bot);
          if (b.positions.length >= max)
            throw Error(`Bot already holds ${b.positions.length} positions`);
          if (this.findPosition(b, product))
            throw Error("Bot already holds this pair");
          if (s.paused || s.halt) throw Error("Entries paused");
          if (
            dec(reserve) <= 0n ||
            dec(size) <= 0n ||
            dec(size) > dec(reserve) ||
            dec(sub(b.cash, b.reserved)) < dec(reserve)
          )
            throw Error("Insufficient bot cash");
          b.reserved = add(b.reserved, reserve);
        } else if (side === "SELL") {
          const held = this.findPosition(b, product);
          if (!held || dec(size) <= 0n || dec(size) > dec(held.quantity))
            throw Error("Cannot sell unowned quantity");
        } else throw Error("Invalid side");
        s.orders[id] = {
          id,
          bot,
          product,
          side,
          size,
          reserve,
          reason,
          stopPct,
          trailPct,
          trailActivationPct,
          maxHoldHours,
          policy,
          status: "SUBMITTING",
          created: Date.now(),
          exchangeId: null,
          filled: "0",
          value: "0",
          fees: "0",
        };
      },
      "order",
      { bot, product, side, clientId: id, status: "SUBMITTING", size, reason },
    );
    return this.read().orders[id];
  }
  acknowledge(id, exchangeId) {
    if (typeof exchangeId !== "string" || !exchangeId)
      throw Error("Missing exchange ID");
    this.change(
      (s) => {
        s.orders[id].exchangeId = exchangeId;
        s.orders[id].status = "OPEN";
      },
      "order",
      { clientId: id, exchangeId, status: "OPEN" },
    );
  }
  unknown(id) {
    this.change(
      (s) => {
        s.orders[id].status = "UNKNOWN";
      },
      "order",
      {
        clientId: id,
        status: "UNKNOWN",
        reason: "Submission outcome uncertain; no automatic resubmission",
      },
    );
  }
  reject(id) {
    this.change(
      (s) => {
        const o = s.orders[id];
        if (dec(o.filled) > 0n) throw Error("Cannot reject filled order");
        const b = s.bots[o.bot];
        b.reserved = sub(b.reserved, o.reserve);
        o.reserve = "0";
        o.status = "REJECTED";
      },
      "order",
      { clientId: id, status: "REJECTED" },
    );
  }
  applyOrder(id, exchange) {
    // Cumulative exchange totals make polling and restart reconciliation idempotent.
    this.change(
      (s) => {
        const o = s.orders[id];
        const b = s.bots[o.bot];
        if (
          exchange.product_id !== o.product ||
          exchange.side !== o.side ||
          exchange.client_order_id !== o.id ||
          exchange.order_id !== o.exchangeId
        )
          throw Error("Order identity mismatch");
        const qty = String(exchange.filled_size ?? "0"),
          value = String(exchange.filled_value ?? "0"),
          fees = String(exchange.total_fees ?? "0");
        if ([qty, value, fees].some((v) => dec(v) < 0n))
          throw Error("Negative exchange total");
        const dq = dec(qty) - dec(o.filled),
          dv = dec(value) - dec(o.value),
          df = dec(fees) - dec(o.fees);
        if (dq < 0n || dv < 0n || df < 0n)
          throw Error("Exchange totals regressed");
        if (o.status === "SETTLED" && (dq || dv || df))
          throw Error("Settled totals changed; reconciliation required");
        if (dq > 0n && dv <= 0n) throw Error("Fill has no value");
        if (o.side === "SELL" && dec(qty) > dec(o.size))
          throw Error("Exchange sell exceeds submitted quantity");
        if (o.side === "BUY") {
          if (dq > 0n) {
            let pos = this.findPosition(b, o.product);
            if (!pos) {
              pos = {
                product: o.product,
                quantity: "0",
                cost: "0",
                opened: o.created,
                peak: "0",
                stopPct: o.stopPct,
                trailPct: o.trailPct,
                trailActivationPct: o.trailActivationPct,
                maxHoldHours: o.maxHoldHours,
                ...(o.policy ? { policy: o.policy } : {}),
              };
              b.positions.push(pos);
            }
            pos.quantity = add(pos.quantity, str(dq));
          }
          // Cumulative value/fees can advance on a later poll with no new
          // quantity; attribute it to whichever position holds this product.
          const pos = this.findPosition(b, o.product);
          if (pos) pos.cost = add(pos.cost, str(dv + df));
          b.cash = sub(b.cash, str(dv + df));
          const release = dec(o.reserve) < dv + df ? dec(o.reserve) : dv + df;
          b.reserved = sub(b.reserved, str(release));
          o.reserve = sub(o.reserve, str(release));
          if (dec(b.cash) < 0n) s.halt = "Actual fill exceeded allocated cash";
          if (dec(value) > dec(o.size))
            s.halt = "Exchange buy value exceeded requested quote size";
        } else {
          if (dq > 0n) {
            const pos = this.findPosition(b, o.product);
            if (!pos || dec(pos.quantity) < dq)
              throw Error("Sell exceeds bot holdings");
            const basis = (dec(pos.cost) * dq) / dec(pos.quantity);
            pos.quantity = sub(pos.quantity, str(dq));
            pos.cost = sub(pos.cost, str(basis));
            b.realised = add(b.realised, str(dv - df - basis));
            if (dec(pos.quantity) === 0n)
              b.positions = b.positions.filter((x) => x !== pos);
          } else b.realised = add(b.realised, str(dv - df));
          b.cash = add(b.cash, str(dv - df));
        }
        b.fees = add(b.fees, str(df));
        o.filled = qty;
        o.value = value;
        o.fees = fees;
        o.exchangeStatus = exchange.status;
        if (
          ["FILLED", "CANCELLED", "EXPIRED", "FAILED"].includes(
            exchange.status,
          ) &&
          exchange.settled === true
        ) {
          if (o.status !== "SETTLED" && dec(qty) > 0n) b.trades++;
          b.reserved = sub(b.reserved, o.reserve);
          o.reserve = "0";
          o.status = "SETTLED";
        }
      },
      "fill",
      {
        clientId: id,
        exchangeStatus: exchange.status,
        filled: exchange.filled_size,
        fees: exchange.total_fees,
        settled: exchange.settled,
      },
    );
  }
  value(prices) {
    const s = this.read();
    return Object.keys(s.bots).map((id) => {
      const b = s.bots[id];
      const positions = Array.isArray(b.positions) ? b.positions : [];
      // A bot is unmarked if ANY held position lacks a price; equity is then
      // unknown rather than silently understated.
      let marked = true,
        holdings = 0,
        cost = 0,
        unrealised = 0;
      // Per-position P/L for the dashboard, so a bot holding several pairs shows
      // each rather than a single blended figure.
      const enriched = positions.map((p) => {
        const price = prices[p.product];
        if (!Number.isFinite(price)) {
          marked = false;
          return { ...p, price: null, unrealised: null };
        }
        const value = Number(p.quantity) * price;
        holdings += value;
        cost += Number(p.cost);
        const pnl = value - Number(p.cost);
        unrealised += pnl;
        return { ...p, price, unrealised: pnl };
      });
      const equity = marked ? Number(b.cash) + holdings : null;
      return {
        ...b,
        positions: enriched,
        equity,
        returnPct:
          equity !== null && Number(b.capital) > 0
            ? (equity / Number(b.capital) - 1) * 100
            : null,
        unrealised: marked ? unrealised : null,
        marked,
      };
    });
  }
  // Retire bulky telemetry. Market events carry a full snapshot per refresh and
  // dominated the live ledger (283 MB of 291 MB). Audit rows - decision, order,
  // fill, veto, control, system, status, error - are never touched, so the
  // record of what was decided and executed is preserved in full.
  pruneEvents({ keepMs = 86400000, now = Date.now() } = {}) {
    const cutoff = now - keepMs;
    const r = this.db
      .prepare("DELETE FROM events WHERE kind='market' AND ts < ?")
      .run(cutoff);
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    return Number(r.changes ?? 0);
  }
  // Reclaim disk after pruning. DELETE frees pages for reuse but does not shrink
  // the file, so a large ledger stays large until VACUUM rewrites it. Slow and
  // space-hungry, so it is gated on size and must never be fatal.
  vacuumIfLarge(thresholdBytes = 50 * 1024 * 1024) {
    try {
      const size = statSync(this.path).size;
      if (size <= thresholdBytes) return false;
      this.db.exec("VACUUM");
      return true;
    } catch {
      return false;
    }
  }
  recordEquity(prices) {
    const values = this.value(prices);
    this.change((s) => {
      for (const b of values)
        if (b.equity !== null) {
          const x = s.bots[b.id];
          x.peakEquity = Math.max(x.peakEquity, b.equity);
          x.drawdown = Math.max(
            x.drawdown,
            x.peakEquity > 0 ? (1 - b.equity / x.peakEquity) * 100 : 0,
          );
        }
    });
    const stmt = this.db.prepare("INSERT INTO equity VALUES(?,?,?)");
    for (const b of values)
      if (b.equity !== null) stmt.run(Date.now(), b.id, b.equity);
  }
  history() {
    return this.db
      .prepare(
        "SELECT * FROM (SELECT * FROM equity ORDER BY ts DESC LIMIT 1500) ORDER BY ts",
      )
      .all();
  }
  close() {
    this.db.close();
  }
}
