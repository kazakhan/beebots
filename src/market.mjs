import { entryEligible } from "./strategy-v2.mjs";
export function closedCandles(rows, seconds, now = Date.now()) {
  const candles = rows
    .map((c) => ({
      time: Number(c.start) * 1000,
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: Number(c.volume),
      ...(c.source ? { source: c.source, tradeCount: c.trade_count } : {}),
    }))
    .filter((c) => c.time + seconds * 1000 <= now)
    .sort((a, b) => a.time - b.time);
  if (candles.length < 60) throw Error("Insufficient closed candle history");
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (
      ![c.time, c.open, c.high, c.low, c.close, c.volume].every(
        Number.isFinite,
      ) ||
      c.low <= 0 ||
      c.volume < 0 ||
      c.low > Math.min(c.open, c.close) ||
      c.high < Math.max(c.open, c.close)
    )
      throw Error("Invalid candle");
    if (i && c.time - candles[i - 1].time !== seconds * 1000)
      throw Error("Missing or duplicate candle");
  }
  if (now - (candles.at(-1).time + seconds * 1000) > seconds * 1000 + 30000)
    throw Error("Stale candle history");
  return candles;
}
function ema(values, period) {
  const k = 2 / (period + 1);
  return values.reduce((a, x) => (a === null ? x : x * k + a * (1 - k)), null);
}
export function features(product, c15, hour) {
  const last = c15.at(-1),
    previous = c15.at(-2),
    prior = c15.slice(-21, -1),
    h = hour.map((c) => c.close);
  if (h.length < 169) throw Error("Seven-day history missing");
  return {
    product,
    signalTime: last.time + 900000,
    close: last.close,
    previousClose: previous.close,
    channelHigh: Math.max(...prior.map((c) => c.high)),
    channelLow: Math.min(...prior.map((c) => c.low)),
    periodTurnover: last.volume * last.close,
    turnoverMethod: "base volume × close approximation",
    period: "15m",
    ema20: ema(h, 20),
    ema50: ema(h, 50),
    hourClose: h.at(-1),
    hourPrevious: h.at(-2),
    momentum7dPct: (h.at(-1) / h.at(-169) - 1) * 100,
    momentum24hPct: (h.at(-1) / h.at(-25) - 1) * 100,
    return15mPct: (last.close / previous.close - 1) * 100,
  };
}
export function eligibility(id, f, rules) {
  if (f.strategyVersion) return entryEligible(id, f);
  if (
    f.periodTurnover < rules.minPeriodTurnover ||
    f.turnover24h < rules.min24hTurnover ||
    f.spreadBps > rules.maxSpreadBps
  )
    return false;
  if (id === "breakout")
    return f.close > f.channelHigh && f.bid > f.channelHigh;
  if (id === "trend")
    return (
      f.hourClose > f.ema20 && f.ema20 > f.ema50 && f.hourClose > f.hourPrevious
    );
  return (
    f.momentum7dPct > 0 && f.momentum24hPct > 0 && f.close > f.previousClose
  );
}
export class Market {
  constructor(exchange, products) {
    this.exchange = exchange;
    this.products = products;
    this.rows = new Map();
    this.quotes = new Map();
    this.lastError = null;
    this.updated = 0;
  }
  async quote(product) {
    const r = await this.exchange.book(product);
    const b = r.pricebook;
    if (!b || b.product_id !== product) throw Error("Book product mismatch");
    const bid = Number(b.bids?.[0]?.price),
      ask = Number(b.asks?.[0]?.price);
    const ts = Date.parse(b.time);
    if (
      !(bid > 0 && ask >= bid) ||
      !Number.isFinite(ts) ||
      Math.abs(Date.now() - ts) > 30000
    )
      throw Error("Invalid or stale order book");
    const q = {
      bid,
      ask,
      at: Date.now(),
      spreadBps: ((ask - bid) / ((bid + ask) / 2)) * 10000,
      bids: b.bids,
      asks: b.asks,
    };
    this.quotes.set(product, q);
    return q;
  }
  async refresh() {
    this.lastError = null;
    for (const product of this.products) {
      try {
        const p = await this.exchange.product(product);
        assertTradable(p, product);
        const now = Math.floor(Date.now() / 1000);
        const c = await this.exchange.candles(
          product,
          now - 101 * 900,
          now,
          "FIFTEEN_MINUTE",
        );
        const h = await this.exchange.candles(
          product,
          now - 201 * 3600,
          now,
          "ONE_HOUR",
        );
        const q = await this.quote(product);
        const f = features(
          product,
          closedCandles(c.candles, 900),
          closedCandles(h.candles, 3600),
        );
        const turnover24h = Number(p.volume_24h) * Number(p.price);
        if (!Number.isFinite(turnover24h) || turnover24h < 0)
          throw Error("Invalid 24h volume");
        this.rows.set(product, {
          ...f,
          ...q,
          turnover24h,
          at: Date.now(),
          productInfo: p,
        });
      } catch {
        this.rows.delete(product);
        this.lastError = `Market data unavailable: ${product}`;
      }
    }
    this.updated = Date.now();
  }
  snapshot() {
    return [...this.rows.values()]
      .filter((r) => Date.now() - r.at < 180000)
      .map(({ productInfo, ...r }) => r);
  }
  prices() {
    return Object.fromEntries(
      [...this.quotes]
        .filter(([, q]) => Date.now() - q.at < 60000)
        .map(([id, q]) => [id, q.bid]),
    );
  }
}
export function assertTradable(p, id) {
  if (
    p.product_id !== id ||
    p.product_type !== "SPOT" ||
    p.quote_currency_id !== "USDC" ||
    p.status !== "online" ||
    p.trading_disabled ||
    p.is_disabled ||
    p.view_only ||
    p.cancel_only ||
    p.limit_only ||
    p.post_only ||
    p.auction_mode
  )
    throw Error("Product unavailable for spot market orders");
  for (const k of [
    "base_increment",
    "quote_increment",
    "base_min_size",
    "quote_min_size",
  ])
    if (!(Number(p[k]) > 0)) throw Error("Product sizing metadata missing");
}
