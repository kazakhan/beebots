// Fixed-point arithmetic for all ledger amounts. Floating point is display/indicators only.
export const SCALE = 10n ** 18n;
// External available balances can exceed the ledger precision. Discard only
// sub-unit positive dust; never round spendable funds upward or use floats.
export function availableAmount(value) {
  if (
    typeof value !== "string" ||
    value.length > 200 ||
    !/^\d+(\.\d+)?$/.test(value)
  )
    throw Error("Invalid account balance decimal");
  const [whole, fraction = ""] = value.split(".");
  return str(dec(whole + (fraction ? "." + fraction.slice(0, 18) : "")));
}
export function dec(v) {
  const s = String(v);
  if (!/^-?\d+(\.\d{1,18})?$/.test(s)) throw Error("Invalid decimal");
  const neg = s.startsWith("-");
  const [a, b = ""] = (neg ? s.slice(1) : s).split(".");
  return (neg ? -1n : 1n) * (BigInt(a) * SCALE + BigInt(b.padEnd(18, "0")));
}
export function str(n) {
  const sign = n < 0n ? "-" : "";
  n = n < 0n ? -n : n;
  return (
    sign +
    n / SCALE +
    (n % SCALE
      ? "." +
        String(n % SCALE)
          .padStart(18, "0")
          .replace(/0+$/, "")
      : "")
  );
}
export const add = (a, b) => str(dec(a) + dec(b));
export const sub = (a, b) => str(dec(a) - dec(b));
export const mul = (a, b) => str((dec(a) * dec(b)) / SCALE);
export function floorStep(value, step) {
  if (dec(step) <= 0n || dec(value) < 0n) throw Error("Invalid increment");
  return str((dec(value) / dec(step)) * dec(step));
}
export const min = (...v) => str(v.map(dec).reduce((a, b) => (a < b ? a : b)));
