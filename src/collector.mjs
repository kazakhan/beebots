import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { MarketReader } from "./market-reader.mjs";
import { Market, closedCandles, features } from "./market.mjs";
import { discover } from "./universe.mjs";
import { evaluate, rankMomentum, aggregate } from "./strategy-v2.mjs";
import { fromTrades } from "./repair-candles.mjs";

export class UniverseMarket extends Market {
  constructor(exchange, config) {
    super(exchange, []);
    this.config = config;
    this.catalogue = [];
    this.entries = new Map();
    this.frames = new Map();
    this.active = new Set();
    this.failures = new Map();
    this.closed = false;
    this.discoveryAt = 0;
    this.categoryAt = 0;
    this.categories = [];
    this.categoryStatus = "pending";
    this.discoveryError = null;
    mkdirSync(config.dataDir, { recursive: true });
    this.cache = new DatabaseSync(join(config.dataDir, "market-cache.sqlite"));
    this.cache.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS cache(key TEXT PRIMARY KEY,body TEXT NOT NULL);",
    );
    this.nextReadAt = 0;
    this.reads = 0;
    this.readers = Array.from(
      { length: config.scanner.workers },
      () =>
        new MarketReader(config, async () => {
          const at = Math.max(Date.now(), this.nextReadAt);
          this.nextReadAt = at + 500;
          await new Promise((r) => setTimeout(r, Math.max(0, at - Date.now())));
          if (this.closed) throw Error("Collector stopped");
          this.reads++;
        }),
    );
    const saved = this.load("categories");
    if (saved) {
      this.categories = saved.rows;
      this.categoryAt = saved.at;
      this.categoryStatus = saved.status;
    }
  }
  load(k) {
    const r = this.cache.prepare("SELECT body FROM cache WHERE key=?").get(k);
    return r ? JSON.parse(r.body) : null;
  }
  save(k, v) {
    this.cache
      .prepare("INSERT OR REPLACE INTO cache VALUES(?,?)")
      .run(k, JSON.stringify(v));
  }
  async categoriesRefresh() {
    if (Date.now() - this.categoryAt < 86400000) return;
    const all = [];
    try {
      let complete = false;
      for (let page = 1; page <= 20; page++) {
        const res = await fetch(
          "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&category=meme-token&per_page=250&page=" +
            page,
          { signal: AbortSignal.timeout(15000) },
        );
        if (!res.ok) throw Error("Category provider HTTP " + res.status);
        const rows = await res.json();
        if (!Array.isArray(rows)) throw Error("Invalid category response");
        all.push(
          ...rows.map((x) => ({
            id: x.id,
            symbol: x.symbol,
            name: x.name,
            reviewed: new Date().toISOString(),
          })),
        );
        if (rows.length < 250) {
          complete = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 1200));
      }
      this.categories = all;
      this.categoryAt = Date.now();
      this.categoryStatus = complete
        ? "complete"
        : "partial (provider page bound)";
      this.save("categories", {
        rows: all,
        at: this.categoryAt,
        status: this.categoryStatus,
      });
    } catch (e) {
      this.categoryStatus = "refresh failed: " + e.message;
      if (all.length) {
        this.categories = all;
        this.categoryStatus = "partial: " + e.message;
      }
      this.categoryAt = Date.now() - 86400000 + 3600000;
      this.save("categories", {
        rows: this.categories,
        at: this.categoryAt,
        status: this.categoryStatus,
      });
    }
  }
  start() {
    this.timer = setInterval(() => void this.refresh(), 1000);
    void this.refresh();
  }
  async refresh() {
    if (this.closed) return;
    // Collection is asynchronous; never place a whole catalogue ahead of an exit.
    if (!this.discoveryTask && Date.now() - this.discoveryAt > 3600000) {
      this.discoveryTask = (async () => {
        await this.categoriesRefresh();
        const result = await this.readers[0].products();
        this.catalogue = discover(
          result.products,
          this.config.scanner.assetOverrides,
          this.categories,
        );
        this.entries = new Map(this.catalogue.map((x) => [x.product, x]));
        this.products = this.catalogue
          .filter((x) => x.eligible)
          .map((x) => x.product);
        this.discoveryAt = Date.now();
        this.discoveryError = null;
        this.save("catalogue", { at: this.discoveryAt, rows: this.catalogue });
      })()
        .catch((e) => {
          this.discoveryError = e.message;
          this.discoveryAt = Date.now() - 3600000 + 60000;
        })
        .finally(() => {
          this.discoveryTask = null;
        });
    }
    if (!this.discoveryTask) {
      for (let i = 0; i < this.readers.length; i++)
        if (!this.active.has(i)) {
          const product = this.nextProduct();
          if (!product) break;
          this.active.add(i);
          this.inFlight ??= new Set();
          this.inFlight.add(product);
          void this.collect(product, this.readers[i])
            .catch((e) => {
              this.failures.set(product, {
                message: e.message,
                retry: Date.now() + 60000,
              });
              this.rows.delete(product);
            })
            .finally(() => {
              this.active.delete(i);
              this.inFlight.delete(product);
            });
        }
    }
    this.lastError = this.discoveryError;
  }
  nextProduct() {
    const all = [...new Set([...(this.held || []), ...this.products])];
    const pending = all.filter(
      (p) =>
        !this.inFlight?.has(p) &&
        (!this.failures.has(p) || this.failures.get(p).retry < Date.now()) &&
        (!this.frames.has(p) ||
          this.frames.get(p).five.at(-1)?.time + 600000 <= Date.now()),
    );
    pending.sort(
      (a, b) =>
        (this.held?.includes(b) ? 1 : 0) - (this.held?.includes(a) ? 1 : 0) ||
        (this.frames.has(a) ? 1 : 0) - (this.frames.has(b) ? 1 : 0) ||
        (this.entries.get(b)?.membership.category === "meme" ? 1 : 0) -
          (this.entries.get(a)?.membership.category === "meme" ? 1 : 0),
    );
    return pending[0];
  }
  async candles(reader, product, seconds, granularity, count) {
    const key = product + ":" + seconds,
      old = this.load(key) || [];
    const now = Math.floor(Date.now() / 1000),
      end = Math.floor(now / seconds) * seconds;
    if (
      old.length >= count &&
      Number(old.at(-1).start) + seconds === end &&
      old.every((row, i) => !i || Number(row.start) - Number(old[i - 1].start) === seconds)
    )
      return closedCandles(old, seconds);
    const start =
      old.length >= count
        ? Math.max(
            end - (count + 1) * seconds,
            Number(old.at(-1).start) - seconds,
          )
        : end - (count + 1) * seconds;
    const result = await reader.candles(product, start, now, granularity);
    if (!Array.isArray(result.candles)) throw Error("Missing candles");
    let merged = [
      ...new Map(
        [...old, ...result.candles]
          .filter((x) => Number(x.start) + seconds <= now)
          .map((x) => [Number(x.start), x]),
      ).values(),
    ]
      .sort((a, b) => Number(a.start) - Number(b.start))
      .slice(-count);
    // Coinbase occasionally omits buckets even when individual trades exist.
    // Resolve a bounded number per visit; unresolved gaps stay excluded and visible.
    if (reader.trades && merged.length) {
      let repairs = 0;
      const byTime = new Map(merged.map((x) => [Number(x.start), x]));
      for (
        let t = Number(merged[0].start) + seconds;
        t < end && repairs < 8;
        t += seconds
      ) {
        if (byTime.has(t)) continue;
        const previous = byTime.get(t - seconds);
        if (!previous) continue;
        const ticks = await reader.trades(product, t, t + seconds);
        byTime.set(
          t,
          fromTrades(
            ticks,
            product,
            this.entries.get(product)?.canonical,
            t,
            seconds,
            previous,
          ),
        );
        this.save(
          key,
          [...byTime.values()]
            .sort((a, b) => Number(a.start) - Number(b.start))
            .slice(-count),
        );
        repairs++;
      }
      merged = [...byTime.values()]
        .sort((a, b) => Number(a.start) - Number(b.start))
        .slice(-count);
    }
    // Persist raw rows even if insufficient: subsequent calls may finish warm-up.
    this.save(key, merged);
    return closedCandles(merged, seconds);
  }
  async collect(product, reader) {
    const five = await this.candles(reader, product, 300, "FIVE_MINUTE", 300);
    let hour = [],
      hourError = null;
    try {
      hour = await this.candles(reader, product, 3600, "ONE_HOUR", 250);
    } catch (e) {
      hourError = e.message;
    }
    let four = [],
      contextError = null;
    try {
      four = await this.candles(reader, product, 14400, "FOUR_HOUR", 260);
    } catch (e) {
      contextError = e.message;
    }
    const frames = { five, hour, four, contextError, hourError };
    this.frames.set(product, frames);
    this.failures.delete(product);
    const c15 = aggregate(five, 900);
    // Legacy positions can still be reviewed with the original feature definitions.
    try {
      this.rows.set(product, {
        ...features(product, c15, hour),
        at: Date.now(),
      });
    } catch {
      this.rows.delete(product);
    }
    this.updated = Date.now();
  }
  snapshot(id) {
    if (!id) return super.snapshot();
    const rows = [];
    for (const product of this.products) {
      const frames = this.frames.get(product),
        entry = this.entries.get(product);
      if (!frames || Date.now() - frames.five.at(-1).time > 660000) continue;
      try {
        const f = evaluate(id, frames, this.config.bots[id], entry.membership);
        const interval =
          id === "breakout" ? 300000 : id === "trend" ? 3600000 : 900000;
        if (f.signalTime < Math.floor(Date.now() / interval) * interval)
          continue;
        rows.push({
          ...f,
          product,
          at: Date.now(),
          membership: entry.membership,
          dataQuality: {
            repairedTradeBuckets: frames.five.filter(
              (x) => x.source === "verified_trades",
            ).length,
            verifiedEmptyBuckets: frames.five.filter(
              (x) => x.source === "verified_no_trades",
            ).length,
          },
        });
      } catch {}
    }
    return id === "momentum" ? rankMomentum(rows, this.config.bots[id]) : rows;
  }
  coverage() {
    const evidence = Object.fromEntries(
      ["breakout", "trend", "momentum"].map((id) => [id, this.snapshot(id)]),
    );
    const rows = this.catalogue.map((x) => ({
      product: x.product,
      category: x.membership.category,
      source: x.membership.source,
      eligible: x.eligible,
      reason:
        x.reason ||
        this.failures.get(x.product)?.message ||
        (!this.frames.has(x.product) ? "Warming up" : null),
      contextError: this.frames.get(x.product)?.contextError,
      hourError: this.frames.get(x.product)?.hourError,
      ready: this.frames.has(x.product),
      lastBar: this.frames.get(x.product)?.five.at(-1)?.time ?? null,
    }));
    return {
      discoveredAt: this.discoveryAt,
      categoryStatus: this.categoryStatus,
      total: rows.length,
      eligible: this.products.length,
      ready: rows.filter((x) => x.ready && x.eligible).length,
      scout: rows.filter(
        (x) => x.eligible && ["meme", "speculative"].includes(x.category),
      ).length,
      active: this.active.size,
      marketReads: this.reads,
      rows,
      bots: Object.fromEntries(
        Object.entries(evidence).map(([id, rs]) => [
          id,
          {
            evaluated: rs.length,
            eligible: rs.filter((f) => f.setupEligible).length,
            shortlist: rs
              .filter(
                (f) =>
                  id !== "breakout" ||
                  ["meme", "speculative"].includes(f.category),
              )
              .sort(
                (a, b) =>
                  Number(b.setupEligible) - Number(a.setupEligible) ||
                  b.rankScore - a.rankScore,
              )
              .slice(0, 5)
              .map((f) => ({
                product: f.product,
                eligible: f.setupEligible,
                reasons: f.reasons,
                signalTime: f.signalTime,
                relativeVolume: f.relativeVolume,
                rankPercentile: f.rankPercentile,
              })),
          },
        ]),
      ),
    };
  }
  async stop() {
    this.closed = true;
    clearInterval(this.timer);
    await this.discoveryTask;
    while (this.active.size) await new Promise((r) => setTimeout(r, 50));
    for (const r of this.readers) r.close();
    this.cache.close();
  }
}
