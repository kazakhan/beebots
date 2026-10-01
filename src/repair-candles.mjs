// Repair an omitted bucket only from a bounded, successful trade-history query.
// Empty buckets carry the last price with zero volume and explicit provenance.
export function fromTrades(result, product, alias, start, seconds, previous) {
  if (!Array.isArray(result.trades) || result.trades.length >= 1000)
    throw Error("Trade history incomplete for candle repair");
  const trades = result.trades.map((t) => ({
    ...t,
    ts: Date.parse(t.time),
    p: Number(t.price),
    v: Number(t.size),
  }));
  if (
    trades.some(
      (t) =>
        ![product, alias].includes(t.product_id) ||
        !Number.isFinite(t.ts) ||
        t.ts < start * 1000 ||
        t.ts > (start + seconds) * 1000 ||
        !(Number.isFinite(t.p) && Number.isFinite(t.v) && t.p > 0 && t.v > 0),
    )
  )
    throw Error("Trade history interval or identity mismatch");
  const inside = trades
    .filter((t) => t.ts < (start + seconds) * 1000)
    .sort((a, b) => a.ts - b.ts);
  const prices = inside.map((t) => t.p),
    last = String(previous.close);
  return {
    start: String(start),
    open: inside.length ? String(prices[0]) : last,
    close: inside.length ? String(prices.at(-1)) : last,
    high: inside.length ? String(Math.max(...prices)) : last,
    low: inside.length ? String(Math.min(...prices)) : last,
    volume: String(inside.reduce((s, t) => s + t.v, 0)),
    source: inside.length ? "verified_trades" : "verified_no_trades",
    trade_count: inside.length,
  };
}
