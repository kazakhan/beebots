import { readFileSync } from "node:fs";
const seed = JSON.parse(
  readFileSync(new URL("../strategies/assets.json", import.meta.url), "utf8"),
);
export function classify(p, overrides = {}, categories = []) {
  const id = p.base_currency_id,
    custom = overrides[id];
  if (custom)
    return { category: custom.category, source: custom.source, override: true };
  const item = seed.assets[id];
  if (
    item &&
    item.names.some(
      (n) => n.toLowerCase() === String(p.base_name).toLowerCase(),
    )
  )
    return {
      ...item,
      source: item.source || seed.source,
      reviewed: seed.reviewed,
    };
  const name = (s) =>
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
  const matches = categories.filter(
    (x) => x.symbol.toUpperCase() === id && name(x.name) === name(p.base_name),
  );
  if (matches.length === 1)
    return {
      category: "meme",
      source: "https://www.coingecko.com/en/coins/" + matches[0].id,
      providerId: matches[0].id,
      reviewed: matches[0].reviewed,
    };
  if (
    /\b(meme|memecoin|meme-inspired|meme-based)\b/i.test(
      p.about_description ?? "",
    )
  )
    return {
      category: "meme",
      source: "Coinbase product about_description",
      reviewed: new Date().toISOString(),
    };
  if (
    /stablecoin|pegged to.*dollar/i.test(p.about_description ?? "") ||
    [
      "USDT",
      "DAI",
      "USDS",
      "PYUSD",
      "EURC",
      "PAX",
      "GUSD",
      "USD1",
      "USDE",
      "FDUSD",
      "TUSD",
    ].includes(id)
  )
    return {
      category: "stablecoin",
      source: "Coinbase currency identity / product description",
    };
  return {
    category: "unclassified",
    source: "Awaiting sourced category review",
  };
}
export function discover(products, overrides = {}, categories = []) {
  const seen = new Set(),
    rows = [];
  for (const p of products) {
    if (p.product_type !== "SPOT" || p.quote_currency_id !== "USDC") continue;
    const category = classify(p, overrides, categories);
    let reason = null;
    if (
      p.status !== "online" ||
      p.trading_disabled ||
      p.is_disabled ||
      p.view_only ||
      p.cancel_only ||
      p.auction_mode
    )
      reason = "Unavailable for account/market";
    else if (p.limit_only || p.post_only) reason = "Order type unsupported";
    // A product can be listed but not actually tradeable: Coinbase returns
    // USDC products with missing lot/precision metadata that no order can use.
    // assertTradable enforces the same four fields at submit time; excluding
    // them here keeps the discovered universe equal to what can be bought.
    else if (!(
      Number(p.base_increment) > 0 &&
      Number(p.quote_increment) > 0 &&
      Number(p.base_min_size) > 0 &&
      Number(p.quote_min_size) > 0
    ))
      reason = "Sizing metadata missing";
    else if (
      category.category === "stablecoin" ||
      category.category === "excluded"
    )
      reason = "Excluded asset category";
    const canonical = p.alias || p.product_id;
    if (seen.has(canonical)) reason = "Duplicate execution market";
    if (!reason) seen.add(canonical);
    rows.push({
      product: p.product_id,
      canonical,
      base: p.base_currency_id,
      name: p.base_name,
      membership: category,
      eligible: !reason,
      reason,
      productInfo: p,
    });
  }
  return rows;
}
