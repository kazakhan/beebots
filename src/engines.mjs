// Decision-engine selection: which component decides a trade, and whether a
// System One model (Jev or Laya) supplies structured evidence to it.
//
//   jev       Jev (TypeSafe) decides directly, the original beebots behaviour.
//   laya      Laya decides directly.
//   llm       the provider-backed decision model decides (the pre-2.4 default).
//   jev+llm   Jev proposes a move; the LLM makes the final decision from that.
//   laya+llm  Laya's per-candidate classification is evidence; the LLM decides
//             (the default this port has always used).
//
// A System One engine answers one choice over the valid moves plus a conviction
// score; code maps that answer to an action. The LLM path keeps its JSON
// contract. One catalogue here means the runtime, the settings file and the
// dashboard agree on the same list and on which components each engine uses.

export const ENGINES = {
  jev: {
    id: "jev",
    label: "Jev (TypeSafe)",
    jev: true,
    laya: false,
    llm: false,
  },
  laya: { id: "laya", label: "Laya", jev: false, laya: true, llm: false },
  llm: {
    id: "llm",
    label: "LLM (provider model)",
    jev: false,
    laya: false,
    llm: true,
  },
  "jev+llm": {
    id: "jev+llm",
    label: "Jev + LLM",
    jev: true,
    laya: false,
    llm: true,
  },
  "laya+llm": {
    id: "laya+llm",
    label: "Laya + LLM",
    jev: false,
    laya: true,
    llm: true,
  },
};

// The default for an install that has never chosen one. Laya decides directly
// (local and free); the LLM is reserved for the hourly review.
export const DEFAULT_ENGINE = "laya";

// Order shown in the dashboard: the two System One engines first, then the LLM,
// then the two hybrids.
export const ENGINE_ORDER = ["jev", "laya", "llm", "jev+llm", "laya+llm"];

export function isEngine(id) {
  return typeof id === "string" && Object.hasOwn(ENGINES, id);
}

export function engineLabel(id) {
  return ENGINES[id]?.label ?? String(id);
}

// Whether the named engine uses a component: "jev", "laya" or "llm".
export function engineUses(id, component) {
  return ENGINES[id]?.[component] === true;
}

// True when the engine itself makes the final call (no LLM in the loop).
export function engineDecides(id) {
  return isEngine(id) && !engineUses(id, "llm");
}

// The list the dashboard builds its selector from.
export function engineCatalog() {
  return ENGINE_ORDER.filter(isEngine).map((id) => ({
    id,
    label: ENGINES[id].label,
    jev: ENGINES[id].jev,
    laya: ENGINES[id].laya,
    llm: ENGINES[id].llm,
  }));
}

// Conviction bands a System One engine scores its chosen move against. The
// labels are code, never prompt text, so the interpretation is stable.
export const CONVICTION_LABELS = ["very weak", "weak", "moderate", "strong"];

const MOVE = /^(BUY|SELL|HOLD) (\S+)$/;

// The valid moves for one bot this cycle. One BUY per eligible, non-held product
// while below the position limit; SELL or HOLD per held product; SKIP always.
// Held products are read from `positions`, not from the candidate flags, so a
// candidate that is both held and dropped from view cannot produce a BUY.
export function buildMenu({
  candidates = [],
  positions = [],
  maxPositions = 1,
}) {
  const held = new Set(positions.map((p) => p.product));
  const room = positions.length < Number(maxPositions || 1);
  const menu = {};
  for (const c of candidates) {
    if (!c || typeof c.product !== "string" || !c.product) continue;
    if (held.has(c.product)) {
      menu[`SELL ${c.product}`] = `Close the ${c.product} position now`;
      menu[`HOLD ${c.product}`] = `Keep the ${c.product} position open`;
    } else if (room) {
      menu[`BUY ${c.product}`] = `Enter a new long ${c.product} position`;
    }
  }
  menu.SKIP = "No trade this cycle";
  return menu;
}

// Map a System One choice back to an action and product. Returns null for
// anything not in the menu grammar, so an off-menu answer is refused rather than
// guessed at.
export function parseMove(choice) {
  if (choice === "SKIP") return { action: "SKIP", product: null };
  if (typeof choice !== "string") return null;
  const m = MOVE.exec(choice);
  if (!m) return null;
  return { action: m[1], product: m[2] };
}
