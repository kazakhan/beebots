import test from "node:test";
import assert from "node:assert/strict";
import { validate } from "../src/config.mjs";
import { config } from "./helpers.mjs";
test("unconfigured real trading and public bind are rejected", () => {
  const c = config();
  c.mode = "live";
  assert.throws(() => validate(c), /acknowledgement/);
  c.liveAcknowledgement = "ENABLE_REAL_COINBASE_ORDERS";
  assert.throws(() => validate(c), /portfolio/);
  c.coinbasePortfolioId = "11111111-1111-1111-1111-111111111111";
  assert.equal(validate(c), c);
  c.bind = "0.0.0.0";
  assert.throws(() => validate(c), /listener/);
});

test("a Coinbase credential source is required and must be unambiguous", () => {
  const base = config();
  // The helper supplies a key file, so it validates.
  assert.equal(validate(base), base);

  // No source at all is refused, unless the environment provides one.
  const none = config();
  delete none.coinbaseKeyFile;
  const savedName = process.env.COINBASE_KEY_NAME;
  const savedSecret = process.env.COINBASE_KEY_SECRET;
  const savedFile = process.env.COINBASE_KEY_FILE;
  delete process.env.COINBASE_KEY_NAME;
  delete process.env.COINBASE_KEY_SECRET;
  delete process.env.COINBASE_KEY_FILE;
  try {
    assert.throws(() => validate(none), /Coinbase credential required/);
    // An inline pair is an accepted source.
    const inline = config();
    delete inline.coinbaseKeyFile;
    inline.coinbaseApiKeyName = "organizations/x/apiKeys/y";
    inline.coinbaseApiKeySecret = "-----BEGIN EC PRIVATE KEY-----\n...\n";
    assert.equal(validate(inline), inline);
    // Half a pair is refused.
    const half = { ...inline };
    delete half.coinbaseApiKeySecret;
    assert.throws(() => validate(half), /must be set together/);
    // The environment alone is enough.
    process.env.COINBASE_KEY_NAME = "env-name";
    process.env.COINBASE_KEY_SECRET = "env-secret";
    assert.equal(validate(none), none);
  } finally {
    if (savedName === undefined) delete process.env.COINBASE_KEY_NAME;
    else process.env.COINBASE_KEY_NAME = savedName;
    if (savedSecret === undefined) delete process.env.COINBASE_KEY_SECRET;
    else process.env.COINBASE_KEY_SECRET = savedSecret;
    if (savedFile === undefined) delete process.env.COINBASE_KEY_FILE;
    else process.env.COINBASE_KEY_FILE = savedFile;
  }
});

test("a relative coinbaseKeyFile is rejected; layaEnabled must be boolean", () => {
  const rel = config();
  rel.coinbaseKeyFile = "relative/key.json";
  assert.throws(() => validate(rel), /Absolute coinbaseKeyFile/);

  const bad = config();
  bad.layaEnabled = "yes";
  assert.throws(() => validate(bad), /layaEnabled must be boolean/);

  const off = config();
  off.layaEnabled = false;
  assert.equal(validate(off), off);
});

test("per-bot real/paper must be boolean", () => {
  const ok = config();
  ok.bots.breakout.paper = true;
  assert.equal(validate(ok), ok);
  const off = config();
  off.bots.momentum.paper = false;
  assert.equal(validate(off), off);
  const bad = config();
  bad.bots.trend.paper = "yes";
  assert.throws(() => validate(bad), /Invalid trend\.paper/);
});
