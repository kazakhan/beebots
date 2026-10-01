// Clear a stuck PAPER control arm's simulated book.
//
// Split from the CLI so it is unit-testable. It refunds each open position at
// its recorded cost and empties the positions/reserved, so clearing a stuck
// paper book neither invents nor destroys simulated equity. The caller is
// responsible for the paper-only and stopped-runtime rules (see reset-control).
import { CONTROL_ID } from "./config.mjs";
import { add } from "./decimal.mjs";

export function resetControl(store) {
  const before = store.read().bots[CONTROL_ID];
  if (!before) throw Error(`No ${CONTROL_ID} arm in this ledger`);
  const positions = Array.isArray(before.positions) ? before.positions : [];
  if (!positions.length) return { cleared: 0, cash: before.cash };
  store.change(
    (s) => {
      const b = s.bots[CONTROL_ID];
      for (const p of b.positions ?? []) b.cash = add(b.cash, p.cost);
      b.positions = [];
      b.reserved = "0";
    },
    "control",
    {
      message: `Control arm reset: ${positions.length} paper position(s) cleared`,
      cleared: positions.length,
    },
  );
  return {
    cleared: positions.length,
    cash: store.read().bots[CONTROL_ID].cash,
  };
}
