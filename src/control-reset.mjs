// Clear a stuck PAPER control arm's simulated book, and clear a sticky halt.
//
// Split from the CLI so it is unit-testable. It refunds each open position at
// its recorded cost and empties the positions/reserved, so clearing a stuck
// paper book neither invents nor destroys simulated equity. It also clears
// `halt`: a halt set by a spurious paper-fill rounding (fixed in 3.0.3) is
// persisted and otherwise never cleared, and would keep blocking new entries.
// The caller is responsible for the paper-only and stopped-runtime rules (see
// reset-control).
import { CONTROL_ID } from "./config.mjs";
import { add } from "./decimal.mjs";

export function resetControl(store) {
  const state = store.read();
  const before = state.bots[CONTROL_ID];
  if (!before) throw Error(`No ${CONTROL_ID} arm in this ledger`);
  const positions = Array.isArray(before.positions) ? before.positions : [];
  const halt = state.halt ?? null;
  if (!positions.length && !halt)
    return { cleared: 0, haltCleared: false, cash: before.cash };
  store.change(
    (s) => {
      const b = s.bots[CONTROL_ID];
      for (const p of b.positions ?? []) b.cash = add(b.cash, p.cost);
      b.positions = [];
      b.reserved = "0";
      s.halt = null;
    },
    "control",
    {
      message:
        `Control arm reset: ${positions.length} paper position(s) cleared` +
        (halt ? `; halt cleared (${halt})` : ""),
      cleared: positions.length,
      haltCleared: !!halt,
    },
  );
  return {
    cleared: positions.length,
    haltCleared: !!halt,
    cash: store.read().bots[CONTROL_ID].cash,
  };
}
