import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.mjs";
import { config, addControl, buy, exchangeOrder } from "./helpers.mjs";

function fixture(paper) {
  const c = addControl(config(), { paper });
  c.mode = "live";
  const s = new Store(":memory:", c);
  s.change((st) => {
    st.paused = false;
  });
  return s;
}

test("a paper fill can never halt the runtime", () => {
  const s = fixture(true);
  try {
    const a = buy(s, "control", "50");
    s.acknowledge(a.id, "exchange-" + a.id);
    // A reported value above the requested quote size is a real-fill anomaly;
    // for a simulated arm it must stay confined to that arm's ledger.
    s.applyOrder(a.id, exchangeOrder(a, { filled_value: "60" }));
    assert.equal(s.read().halt, null, "no global halt from a paper fill");
  } finally {
    s.close();
  }
});

test("a real fill over the requested quote size still halts", () => {
  const s = fixture(false);
  try {
    const a = buy(s, "control", "50");
    s.acknowledge(a.id, "exchange-" + a.id);
    s.applyOrder(a.id, exchangeOrder(a, { filled_value: "60" }));
    assert.match(s.read().halt ?? "", /exceeded requested quote size/);
  } finally {
    s.close();
  }
});
