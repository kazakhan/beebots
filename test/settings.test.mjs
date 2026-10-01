import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settings } from "../src/settings.mjs";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "beebots-settings-"));
  return {
    dir,
    settings: new Settings({
      dataDir: dir,
      fallback: {
        baseUrl: "https://api.deepseek.com",
        name: "deepseek-flash",
        apiKeyEnv: "BEEBOTS_TEST_KEY",
        allowNoKey: false,
      },
    }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("with no settings file the config model and model.env apply", () => {
  const f = fixture();
  try {
    process.env.BEEBOTS_TEST_KEY = "env-key-value";
    const s = f.settings;
    assert.equal(s.read().source, "config");
    assert.equal(s.read().provider, "deepseek");
    assert.equal(s.read().model, "deepseek-flash");
    assert.equal(s.key("deepseek"), "env-key-value");
    delete process.env.BEEBOTS_TEST_KEY;
  } finally {
    delete process.env.BEEBOTS_TEST_KEY;
    f.cleanup();
  }
});

test("a saved key is stored owner-only and never returned in full", () => {
  const f = fixture();
  try {
    const s = f.settings;
    s.save({
      provider: "zai",
      model: "glm-4.7-flash",
      apiKey: "zai-secret-key-1234",
    });
    const mode = statSync(join(f.dir, "model.json")).mode & 0o777;
    assert.equal(
      mode,
      0o600,
      "settings file must not be group or world readable",
    );
    const r = s.redacted();
    assert.equal(r.hasKey, true);
    assert.equal(r.keyHint, "…1234");
    assert.equal(r.provider, "zai");
    // redacted() is the only shape the HTTP layer serialises. The plaintext key
    // must never appear in it.
    assert.ok(!JSON.stringify(r).includes("zai-secret-key-1234"));
    // effective() is internal to the runtime; it is the one place a key lives.
    assert.equal(s.effective().key, "zai-secret-key-1234");
    // It is on disk, readable only by the service user.
    assert.match(
      readFileSync(join(f.dir, "model.json"), "utf8"),
      /zai-secret-key-1234/,
    );
  } finally {
    f.cleanup();
  }
});

test("a stored key is bound to its provider and is not sent to another", () => {
  const f = fixture();
  try {
    process.env.BEEBOTS_TEST_KEY = "deepseek-env-key";
    const s = f.settings;
    s.save({ provider: "zai", model: "glm-4.7-flash", apiKey: "zai-key-abcd" });
    assert.equal(s.key("zai"), "zai-key-abcd");
    // Presenting the Zai selection must not fall through to the DeepSeek
    // environment key, which belongs to a different provider.
    assert.equal(s.effective().key, "zai-key-abcd");
    assert.equal(s.effective().baseUrl, "https://api.z.ai/api/paas/v4");
    delete process.env.BEEBOTS_TEST_KEY;
  } finally {
    delete process.env.BEEBOTS_TEST_KEY;
    f.cleanup();
  }
});

test("only catalogue providers and their own models are accepted", () => {
  const f = fixture();
  try {
    const s = f.settings;
    assert.throws(
      () =>
        s.save({
          provider: "evil",
          model: "glm-4.7-flash",
          apiKey: "k".repeat(8),
        }),
      /Unknown decision-model provider/,
    );
    // A model that exists, but not under the chosen provider.
    assert.throws(
      () =>
        s.save({
          provider: "deepseek",
          model: "glm-4.7-flash",
          apiKey: "k".repeat(8),
        }),
      /not offered by that provider/,
    );
    // Retired aliases must not be selectable.
    assert.throws(
      () =>
        s.save({
          provider: "deepseek",
          model: "deepseek-v4-flash",
          apiKey: "k".repeat(8),
        }),
      /not offered by that provider/,
    );
  } finally {
    f.cleanup();
  }
});

test("a free-text base URL cannot be smuggled through the settings payload", () => {
  const f = fixture();
  try {
    const s = f.settings;
    s.save({
      provider: "zai",
      model: "glm-4.7-flash",
      apiKey: "k".repeat(8),
      baseUrl: "https://attacker.example/v1",
    });
    // The extra field is ignored entirely; the catalogue URL is authoritative.
    assert.equal(s.effective().baseUrl, "https://api.z.ai/api/paas/v4");
  } finally {
    f.cleanup();
  }
});

test("key material is bounded and whitespace is rejected", () => {
  const f = fixture();
  try {
    const s = f.settings;
    assert.throws(
      () =>
        s.save({
          provider: "zai",
          model: "glm-4.7-flash",
          apiKey: "x".repeat(201),
        }),
      /Invalid API key/,
    );
    assert.throws(
      () =>
        s.save({
          provider: "zai",
          model: "glm-4.7-flash",
          apiKey: "bad key\nX: y",
        }),
      /Invalid API key/,
    );
    assert.throws(
      () =>
        s.save({
          provider: "zai",
          model: "glm-4.7-flash",
          apiKey: "a",
          clearKey: true,
        }),
      /Cannot set and clear/,
    );
  } finally {
    f.cleanup();
  }
});

test("blank input keeps the stored key; clearKey removes it", () => {
  const f = fixture();
  try {
    const s = f.settings;
    s.save({
      provider: "zai",
      model: "glm-4.7-flash",
      apiKey: "keep-this-key",
    });
    s.save({ provider: "zai", model: "glm-4.7", apiKey: "" });
    assert.equal(s.key("zai"), "keep-this-key");
    assert.equal(
      s.read().model,
      "glm-4.7",
      "model still switches with a blank key",
    );
    s.save({ provider: "zai", model: "glm-4.7-flashx", clearKey: true });
    assert.equal(s.read().model, "glm-4.7-flashx");
  } finally {
    f.cleanup();
  }
});

test("a corrupt settings file falls back to the config defaults", () => {
  const f = fixture();
  try {
    process.env.BEEBOTS_TEST_KEY = "env-key-value";
    const s = f.settings;
    s.save({ provider: "zai", model: "glm-4.7-flash", apiKey: "stored" });
    // Simulate a truncated or hand-edited file.
    writeFileSync(join(f.dir, "model.json"), "{not json");
    s.cache = null;
    assert.equal(s.read().provider, "deepseek");
    assert.equal(s.read().source, "config");
    assert.equal(s.key("deepseek"), "env-key-value");
    delete process.env.BEEBOTS_TEST_KEY;
  } finally {
    delete process.env.BEEBOTS_TEST_KEY;
    f.cleanup();
  }
});

test("Ollama saves with no key and keeps its endpoint", () => {
  const f = fixture();
  try {
    process.env.BEEBOTS_TEST_KEY = "deepseek-env-key";
    const s = f.settings;
    const r = s.save({
      provider: "ollama",
      model: "deepscaler:latest",
      endpoint: "http://127.0.0.1:11434/v1",
    });
    assert.equal(r.provider, "ollama");
    assert.equal(r.model, "deepscaler:latest");
    assert.equal(r.hasKey, false, "a local provider needs no credential");
    assert.equal(r.endpoint, "http://127.0.0.1:11434/v1");
    const e = s.effective();
    assert.equal(e.baseUrl, "http://127.0.0.1:11434/v1");
    assert.equal(e.key, null);
    assert.equal(e.allowNoKey, true);
    delete process.env.BEEBOTS_TEST_KEY;
  } finally {
    delete process.env.BEEBOTS_TEST_KEY;
    f.cleanup();
  }
});

test("a local provider refuses an API key rather than leaking one", () => {
  const f = fixture();
  try {
    assert.throws(
      () =>
        f.settings.save({
          provider: "ollama",
          model: "deepscaler:latest",
          endpoint: "http://127.0.0.1:11434/v1",
          apiKey: "should-not-be-stored",
        }),
      /does not use an API key/,
    );
  } finally {
    f.cleanup();
  }
});

test("only the local provider accepts an endpoint", () => {
  const f = fixture();
  try {
    // This is the SSRF guard: a fixed-URL provider cannot be re-pointed, so its
    // key can never be aimed at another host.
    assert.throws(
      () =>
        f.settings.save({
          provider: "zai",
          model: "glm-4.7-flash",
          apiKey: "k".repeat(8),
          endpoint: "http://attacker.example/v1",
        }),
      /does not accept a custom endpoint/,
    );
  } finally {
    f.cleanup();
  }
});

test("a stored key is never exposed when switching to a local provider", () => {
  const f = fixture();
  try {
    const s = f.settings;
    s.save({
      provider: "zai",
      model: "glm-4.7-flash",
      apiKey: "zai-secret-9876",
    });
    s.save({
      provider: "ollama",
      model: "deepscaler:latest",
      endpoint: "http://127.0.0.1:11434/v1",
    });
    // The Zai key is bound to Zai; selecting a local provider must not inherit it.
    assert.equal(s.effective().key, null);
    assert.equal(s.redacted().hasKey, false);
    assert.ok(!JSON.stringify(s.redacted()).includes("zai-secret-9876"));
  } finally {
    f.cleanup();
  }
});

test("endpoint URLs are normalised and validated", () => {
  const f = fixture();
  try {
    const s = f.settings;
    const saved = s.save({
      provider: "ollama",
      model: "deepscaler:latest",
      endpoint: "http://127.0.0.1:11434/v1/",
    });
    // A trailing slash would double up when /chat/completions is appended.
    assert.equal(saved.endpoint, "http://127.0.0.1:11434/v1");
    for (const bad of [
      "",
      "   ",
      "not a url",
      "ftp://host/v1",
      "http://user:pass@host/v1",
      "x".repeat(301),
    ])
      assert.throws(
        () =>
          s.save({
            provider: "ollama",
            model: "deepscaler:latest",
            endpoint: bad,
          }),
        /Endpoint/i,
        String(bad),
      );
  } finally {
    f.cleanup();
  }
});

test("a local provider requires an endpoint", () => {
  const f = fixture();
  try {
    assert.throws(
      () => f.settings.save({ provider: "ollama", model: "deepscaler:latest" }),
      /Endpoint is required/,
    );
  } finally {
    f.cleanup();
  }
});

test("malformed model ids are refused for a local provider", () => {
  const f = fixture();
  try {
    for (const bad of ["", "a b", 'a"b', "-flag", "<script>", "x".repeat(129)])
      assert.throws(
        () =>
          f.settings.save({
            provider: "ollama",
            model: bad,
            endpoint: "http://127.0.0.1:11434/v1",
          }),
        /not offered by that provider/,
        String(bad),
      );
  } finally {
    f.cleanup();
  }
});

test("a corrupt endpoint falls back to the configured default", () => {
  const f = fixture();
  try {
    const s = f.settings;
    s.save({
      provider: "ollama",
      model: "deepscaler:latest",
      endpoint: "http://127.0.0.1:11434/v1",
    });
    s.write({
      provider: "ollama",
      model: "deepscaler:latest",
      apiKey: null,
      endpoint: 12345,
    });
    assert.equal(s.effective().baseUrl, "http://127.0.0.1:11434/v1");
  } finally {
    f.cleanup();
  }
});

test("a retired or misspelt config model is surfaced, never silent", () => {
  // The live /etc/beebots/config.json named "deepseek-v4-flash", a retired
  // alias that is not a catalogue id. The old code silently substituted a
  // different model, so a bot placing real orders used a model the operator
  // never selected. A typo behaved identically.
  for (const name of ["deepseek-v4-flash", "deepseek-vrge", "deepseek-chat"]) {
    const f = fixture();
    try {
      // The shared fixture uses a valid name; override it to the retired one.
      const s = new Settings({
        dataDir: f.dir,
        fallback: {
          baseUrl: "https://api.deepseek.com",
          name,
          apiKeyEnv: "BEEBOTS_TEST_KEY",
          allowNoKey: false,
        },
      });
      s.read();
      const note = s.redacted().unknownModel;
      assert.ok(note, `${name} must raise a warning`);
      assert.equal(note.provider, "deepseek");
      assert.equal(note.model, name);
      assert.match(note.message, /not offered by deepseek/);
      assert.match(
        note.message,
        /deepseek-flash/,
        "lists the valid alternatives",
      );
      assert.match(note.message, /config\.json/, "says where to fix it");
    } finally {
      f.cleanup();
    }
  }
});

test("a valid config model raises no warning", () => {
  const f = fixture();
  try {
    const s = new Settings({
      dataDir: f.dir,
      fallback: {
        baseUrl: "https://api.deepseek.com",
        name: "deepseek-flash",
        apiKeyEnv: "BEEBOTS_TEST_KEY",
        allowNoKey: false,
      },
    });
    s.read();
    assert.equal(s.redacted().unknownModel, null);
    assert.equal(s.read().model, "deepseek-flash");
  } finally {
    f.cleanup();
  }
});

test("an explicit dashboard selection suppresses the config warning", () => {
  const f = fixture();
  try {
    process.env.BEEBOTS_TEST_KEY = "env-key";
    const s = f.settings;
    // Retired name in config, but the owner picked a model in the dashboard.
    s.save({ provider: "zai", model: "glm-4.7-flash", apiKey: "k".repeat(8) });
    s.read();
    assert.equal(s.read().model, "glm-4.7-flash");
    delete process.env.BEEBOTS_TEST_KEY;
  } finally {
    delete process.env.BEEBOTS_TEST_KEY;
    f.cleanup();
  }
});

test("a dynamically-listed model can be saved on a dynamic provider", () => {
  const f = fixture();
  try {
    const s = f.settings;
    // "gpt-5.1-mini" is not in any built-in table; it came from the provider.
    s.save({
      provider: "openai",
      model: "gpt-5.1-mini",
      apiKey: "sk-openai-1234",
    });
    assert.equal(s.read().provider, "openai");
    assert.equal(s.read().model, "gpt-5.1-mini");
    assert.equal(s.key("openai"), "sk-openai-1234");
  } finally {
    f.cleanup();
  }
});

test("a fixed-catalogue provider still rejects a model it does not offer", () => {
  const f = fixture();
  try {
    assert.throws(
      () =>
        f.settings.save({
          provider: "zai",
          model: "gpt-5.1-mini",
          apiKey: "k".repeat(8),
        }),
      /not offered by that provider/,
    );
  } finally {
    f.cleanup();
  }
});

test("the model.env key is never forwarded to a different provider", () => {
  const f = fixture(); // fallback is DeepSeek
  try {
    process.env.BEEBOTS_TEST_KEY = "deepseek-env-key";
    const s = f.settings;
    // It belongs to the configured provider, so that provider gets it.
    assert.equal(s.key("deepseek"), "deepseek-env-key");
    // Selecting any other provider must not inherit it: that would hand one
    // vendor's credential to another.
    assert.equal(s.key("openai"), null);
    assert.equal(s.key("zai"), null);
    assert.equal(s.key("openrouter"), null);
    // And saving one without entering a key is refused rather than silently
    // falling back to the wrong credential.
    assert.throws(
      () => s.save({ provider: "openai", model: "gpt-5.1-mini" }),
      /No API key is configured/,
    );
    delete process.env.BEEBOTS_TEST_KEY;
  } finally {
    delete process.env.BEEBOTS_TEST_KEY;
    f.cleanup();
  }
});

// --- decision-engine selection (2.9.0) -----------------------------------

test("an install with no engine setting defaults to Laya + LLM", () => {
  const f = fixture();
  try {
    assert.equal(f.settings.engineValue(), "laya+llm");
    assert.equal(f.settings.redacted().engine, "laya+llm");
    assert.equal(f.settings.redacted().engineLabel, "Laya + LLM");
  } finally {
    f.cleanup();
  }
});

test("the default engine option overrides the built-in default", () => {
  const dir = mkdtempSync(join(tmpdir(), "beebots-settings-"));
  try {
    const s = new Settings({
      dataDir: dir,
      fallback: { baseUrl: "https://api.deepseek.com", name: "deepseek-flash" },
      defaultEngine: "llm",
    });
    assert.equal(s.engineValue(), "llm");
    // An unknown default is refused and the built-in default applies.
    const bad = new Settings({
      dataDir: dir,
      fallback: { baseUrl: "https://api.deepseek.com", name: "deepseek-flash" },
      defaultEngine: "nope",
    });
    assert.equal(bad.engineValue(), "laya+llm");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the engine and a separate Jev key persist owner-only and are masked", () => {
  const f = fixture();
  try {
    const s = f.settings;
    s.save({
      provider: "zai",
      model: "glm-4.7-flash",
      apiKey: "zai-secret-key-1234",
      engine: "jev+llm",
      jevApiKey: "jev-secret-key-9876",
      jevModel: "jev-1.13.0",
    });
    assert.equal(statSync(join(f.dir, "model.json")).mode & 0o777, 0o600);
    const r = s.redacted();
    assert.equal(r.engine, "jev+llm");
    assert.equal(r.engineLabel, "Jev + LLM");
    assert.equal(r.jev.hasKey, true);
    assert.equal(r.jev.keyHint, "…9876");
    assert.equal(r.jev.model, "jev-1.13.0");
    // Neither credential may appear in the redacted shape the HTTP layer sends.
    assert.ok(!JSON.stringify(r).includes("jev-secret-key-9876"));
    assert.ok(!JSON.stringify(r).includes("zai-secret-key-1234"));
    // effectiveJev is the one place the Jev key is exposed, for the client.
    assert.deepEqual(s.effectiveJev(), {
      model: "jev-1.13.0",
      key: "jev-secret-key-9876",
    });
  } finally {
    f.cleanup();
  }
});

test("an unknown engine, a bad Jev model and a whitespace Jev key are refused", () => {
  const f = fixture();
  try {
    const s = f.settings;
    const base = {
      provider: "zai",
      model: "glm-4.7-flash",
      apiKey: "k".repeat(8),
    };
    assert.throws(
      () => s.save({ ...base, engine: "nope" }),
      /Unknown decision engine/,
    );
    assert.throws(
      () => s.save({ ...base, jevModel: "a b" }),
      /Invalid Jev model/,
    );
    assert.throws(
      () => s.save({ ...base, jevApiKey: "bad key\nX: y" }),
      /Invalid Jev API key/,
    );
    assert.throws(
      () => s.save({ ...base, jevApiKey: "a", clearJevKey: true }),
      /Cannot set and clear the Jev key/,
    );
  } finally {
    f.cleanup();
  }
});

test("a blank Jev key keeps the stored one; clearJevKey removes it", () => {
  const f = fixture();
  try {
    const s = f.settings;
    const base = {
      provider: "zai",
      model: "glm-4.7-flash",
      apiKey: "k".repeat(8),
    };
    s.save({ ...base, engine: "laya+llm", jevApiKey: "keep-jev-key" });
    assert.equal(s.effectiveJev().key, "keep-jev-key");
    // Switching engine does not lose the Jev key.
    s.save({ ...base, engine: "laya" });
    assert.equal(s.effectiveJev().key, "keep-jev-key");
    s.save({ ...base, clearJevKey: true });
    assert.equal(s.effectiveJev().key, null);
  } finally {
    f.cleanup();
  }
});

test("TYPESAFE_API_KEY is the Jev key fallback before any stored one", () => {
  const f = fixture();
  try {
    process.env.TYPESAFE_API_KEY = "env-jev-key";
    assert.equal(f.settings.keyJev(), "env-jev-key");
    assert.equal(f.settings.redacted().jev.hasKey, true);
    f.settings.save({
      provider: "zai",
      model: "glm-4.7-flash",
      apiKey: "k".repeat(8),
      jevApiKey: "stored-jev-key",
    });
    // A stored key wins over the environment.
    assert.equal(f.settings.keyJev(), "stored-jev-key");
  } finally {
    delete process.env.TYPESAFE_API_KEY;
    f.cleanup();
  }
});
