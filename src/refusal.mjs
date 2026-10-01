// A Refusal is a deliberate decline, not a fault: the market or the risk layer
// says no (thin book, slippage over budget, entry no longer qualifies, position
// limit, insufficient cash). The engine logs a `veto` for these instead of an
// `error`, so ordinary refusals do not read as failures.
//
// Anything that is a genuine defect or an owner-action condition stays a plain
// Error and is still reported as an error.
export class Refusal extends Error {
  constructor(message) {
    super(message);
    this.name = "Refusal";
  }
}

export function isRefusal(error) {
  return error instanceof Refusal || error?.name === "Refusal";
}

export function refuse(message) {
  return new Refusal(message);
}
