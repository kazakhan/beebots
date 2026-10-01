import test from "node:test";
import http from "node:http";
import assert from "node:assert/strict";
import {
  PROVIDERS,
  allowsNoKey,
  catalogue,
  costOf,
  isPeakUtc,
  isModel,
  isProvider,
  listModels,
  isDynamic,
  modelLabel,
  modelSpec,
  needsEndpoint,
  usageCounts,
  validModelId,
} from "../src/providers.mjs";

// 2026-09-30 is a Wednesday. Peak is 01:00-04:00 and 06:00-10:00 UTC, Mon-Fri.
const at = (iso) => Date.parse(iso);

test("DeepSeek peak window follows UTC hours and weekdays exactly", () => {
  // Wednesday 2026-09-30.
  assert.equal(isPeakUtc(at("2026-09-30T00:59:00Z")), false);
  assert.equal(isPeakUtc(at("2026-09-30T01:00:00Z")), true);
  assert.equal(isPeakUtc(at("2026-09-30T03:59:00Z")), true);
  assert.equal(isPeakUtc(at("2026-09-30T04:00:00Z")), false);
  assert.equal(isPeakUtc(at("2026-09-30T06:00:00Z")), true);
  assert.equal(isPeakUtc(at("2026-09-30T09:59:00Z")), true);
  assert.equal(isPeakUtc(at("2026-09-30T10:00:00Z")), false);
  // Saturday 2026-10-03 and Sunday 2026-10-04 are entirely off-peak, even at 02:00.
  assert.equal(isPeakUtc(at("2026-10-03T02:00:00Z")), false);
  assert.equal(isPeakUtc(at("2026-10-04T02:00:00Z")), false);
});

test("cached input is charged at the cache rate, not the full input rate", () => {
  const usage = {
    prompt_tokens: 1_000_000,
    completion_tokens: 0,
    prompt_tokens_details: { cached_tokens: 0 },
  };
  const offPeak = at("2026-09-30T12:00:00Z"); // Wednesday midday UTC
  const miss = costOf(usage, "deepseek", "deepseek-flash", offPeak);
  const hit = costOf(
    { ...usage, prompt_tokens_details: { cached_tokens: 1_000_000 } },
    "deepseek",
    "deepseek-flash",
    offPeak,
  );
  // $0.15/1M uncached versus $0.003/1M cached.
  assert.equal(miss, 150_000_000n);
  assert.equal(hit, 3_000_000n);
  // A partially cached prompt splits between the two rates:
  // 500k cached at $0.003/1M plus 500k uncached at $0.15/1M.
  const half = costOf(
    { ...usage, prompt_tokens_details: { cached_tokens: 500_000 } },
    "deepseek",
    "deepseek-flash",
    offPeak,
  );
  assert.equal(half, 1_500_000n + 75_000_000n);
});

test("DeepSeek peak hours bill exactly double the off-peak rate", () => {
  const usage = {
    prompt_tokens: 100_000,
    completion_tokens: 100_000,
    prompt_tokens_details: { cached_tokens: 0 },
  };
  const offPeak = costOf(
    usage,
    "deepseek",
    "deepseek-flash",
    at("2026-09-30T12:00:00Z"),
  );
  const peak = costOf(
    usage,
    "deepseek",
    "deepseek-flash",
    at("2026-09-30T07:00:00Z"),
  );
  // $0.15 in + $0.60 out per 1M off-peak = $0.075; peak is exactly 2x.
  assert.equal(offPeak, 75_000_000n);
  assert.equal(peak, offPeak * 2n);
});

test("free models record calls and tokens at zero cost", () => {
  const usage = {
    prompt_tokens: 900,
    completion_tokens: 65,
    total_tokens: 994,
    prompt_tokens_details: { cached_tokens: 3 },
  };
  assert.equal(costOf(usage, "zai", "glm-4.7-flash"), 0n);
  assert.equal(modelSpec("zai", "glm-4.7-flash").free, true);
  // The same call on a paid model: 897 uncached in, 3 cached in, 65 out.
  // $0.60/$0.11/$2.20 per 1M is 600/110/2200 nano-USD per token.
  assert.equal(
    costOf(usage, "zai", "glm-4.7"),
    897n * 600n + 3n * 110n + 65n * 2200n,
  );
  assert.equal(costOf(usage, "zai", "glm-4.7"), 681_530n);
});

test("an unknown model is never silently priced as free", () => {
  assert.equal(costOf({ total_tokens: 10 }, "zai", "glm-nope"), null);
  assert.equal(costOf({ total_tokens: 10 }, "nope", "glm-4.7-flash"), null);
  assert.equal(isProvider("nope"), false);
  assert.equal(isModel("zai", "glm-nope"), false);
  // DeepSeek's retired alias must not resolve; it bills as V4.1-Flash.
  assert.equal(isModel("deepseek", "deepseek-v4-flash"), false);
});

test("malformed or absent usage cannot poison a running cost total", () => {
  const model = ["deepseek", "deepseek-flash"];
  assert.equal(costOf(null, ...model), 0n === 0n ? 0n : null);
  assert.equal(costOf({}, ...model), 0n);
  assert.equal(
    costOf({ prompt_tokens: -5, completion_tokens: "x" }, ...model),
    0n,
  );
  // A provider reporting more cached than prompt cannot produce a negative cost.
  const c = costOf(
    {
      prompt_tokens: 10,
      completion_tokens: 0,
      prompt_tokens_details: { cached_tokens: 999 },
    },
    ...model,
  );
  assert.ok(c >= 0n, "cost never goes negative");
});

test("usageCounts keeps only safe non-negative integers", () => {
  const u = usageCounts({
    prompt_tokens: 100,
    completion_tokens: 20,
    total_tokens: 120,
    prompt_tokens_details: { cached_tokens: 7 },
  });
  assert.deepEqual(u, {
    promptTokens: 100n,
    completionTokens: 20n,
    cachedTokens: 7n,
    totalTokens: 120n,
  });
  assert.equal(usageCounts(undefined).promptTokens, 0n);
});

// A provider listing double. Returns OpenAI-shaped { data: [{ id }] }.
async function listingServer(ids, { status = 200 } = {}) {
  const server = http.createServer((req, res) => {
    req.resume();
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(
      status === 200
        ? JSON.stringify({
            object: "list",
            data: ids.map((id) => ({ id, object: "model" })),
          })
        : "{}",
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return server;
}
const close = async (server) => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
};

// Records the Authorization header seen, so a test can assert whether a
// credential was attached to the request.
async function authListingServer(record, ids = ["glm-4.7-flash"]) {
  const server = http.createServer((req, res) => {
    record(req.headers.authorization ?? null);
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({ data: ids.map((id) => ({ id, object: "model" })) }),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return server;
}

test("a provider listing populates the models list, deduplicated and sorted", async () => {
  const server = await listingServer([
    "deepscaler:latest",
    "all-minilm:33m",
    "deepscaler:latest",
    "ornith-1.5:9B",
  ]);
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  try {
    const r = await listModels({ provider: "ollama", endpoint: base });
    assert.equal(r.source, "provider");
    assert.deepEqual(
      r.models.map((m) => m.id),
      ["all-minilm:33m", "deepscaler:latest", "ornith-1.5:9B"],
    );
  } finally {
    await close(server);
  }
});

test("a failed listing falls back to the catalogue so the dropdown is never empty", async () => {
  const server = await listingServer([], { status: 500 });
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  try {
    const r = await listModels({ provider: "ollama", endpoint: base });
    assert.equal(r.source, "catalogue");
    assert.match(r.error, /HTTP 500/);
  } finally {
    await close(server);
  }
  // Unreachable host, empty catalogue: honest empty list, no invented models.
  const gone = await listModels({
    provider: "ollama",
    endpoint: "http://192.0.2.1:11434/v1",
    timeoutMs: 300,
  });
  assert.equal(gone.source, "catalogue");
  assert.match(gone.error, /unreachable/i);
  assert.deepEqual(gone.models, []);
});

test("listing never sends a credential to an owner-supplied endpoint", async () => {
  // The key belongs to a fixed-URL catalogue provider. If it leaked to a typed
  // endpoint, one endpoint edit would hand it to another host.
  let seen = null;
  const server = await authListingServer((v) => (seen = v), ["local:1b"]);
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  try {
    const r = await listModels({
      provider: "ollama",
      endpoint: base,
      apiKey: "a-secret-key-value",
    });
    assert.equal(r.source, "provider");
    assert.equal(
      seen,
      null,
      "no Authorization header on an owner-supplied endpoint",
    );
  } finally {
    await close(server);
  }
});

test("a catalogue provider does send its key when listing models", async () => {
  let seen = null;
  const server = await authListingServer((v) => (seen = v));
  try {
    // A catalogue provider has a fixed URL, so the key goes only to that host.
    const original = PROVIDERS.zai.baseUrl;
    PROVIDERS.zai.baseUrl = `http://127.0.0.1:${server.address().port}/v4`;
    try {
      const r = await listModels({ provider: "zai", apiKey: "k-123456" });
      assert.equal(r.source, "provider");
      assert.equal(seen, "Bearer k-123456");
    } finally {
      PROVIDERS.zai.baseUrl = original;
    }
  } finally {
    await close(server);
  }
});

test("hostile model names from a listing are discarded", async () => {
  const server = await listingServer([
    "good:1b",
    'evil"injection',
    "with space",
    "x".repeat(200),
    null,
    42,
  ]);
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  try {
    const r = await listModels({ provider: "ollama", endpoint: base });
    // The one well-formed id survives; the rest are dropped, so a hostile name
    // cannot reach the dropdown or the saved selection.
    assert.equal(r.source, "provider");
    assert.deepEqual(
      r.models.map((m) => m.id),
      ["good:1b"],
    );
  } finally {
    await close(server);
  }
});

test("catalogue models carry explicit capabilities", () => {
  for (const [id, p] of Object.entries(PROVIDERS)) {
    // A fixed-URL provider must be HTTPS. An endpoint-driven provider supplies
    // its own URL and is checked separately.
    if (p.endpoint) {
      assert.equal(
        p.baseUrl,
        null,
        `${id} takes an owner endpoint, not a fixed URL`,
      );
      continue;
    }
    assert.ok(p.baseUrl.startsWith("https://"), `${id} must use HTTPS`);
    for (const [m, spec] of Object.entries(p.models)) {
      assert.ok(typeof spec.label === "string" && spec.label.length);
      assert.ok(spec.maxTokens >= 1, `${m} needs an output cap`);
      assert.ok(
        ["disabled", "required", "off-peak-priced"].includes(spec.thinking),
      );
    }
  }
});

test("Ollama is offered as a keyless, endpoint-driven local provider", () => {
  const o = PROVIDERS.ollama;
  assert.equal(o.endpoint, true);
  assert.equal(o.allowNoKey, true);
  assert.equal(o.free, true);
  // Installed models are host-specific, so no static list can be correct.
  assert.deepEqual(o.models, {});
  assert.ok(o.defaultEndpoint.startsWith("http://"));
  assert.equal(allowsNoKey("ollama"), true);
  assert.equal(allowsNoKey("zai"), false);
  assert.equal(needsEndpoint("ollama"), true);
  assert.equal(needsEndpoint("zai"), false);
  const listed = catalogue().find((p) => p.id === "ollama");
  assert.equal(listed.endpoint, true);
  assert.equal(listed.allowNoKey, true);
  assert.deepEqual(listed.models, []);
});

test("local inference is free and named by its id", () => {
  // An Ollama model id uses name:tag and has no catalogue entry.
  const usage = { prompt_tokens: 800, completion_tokens: 120 };
  assert.equal(validModelId("deepscaler:latest"), true);
  assert.equal(validModelId("qwen3-vl:2b"), true);
  assert.equal(costOf(usage, "ollama", "deepscaler:latest"), 0n);
  assert.equal(modelLabel("ollama", "deepscaler:latest"), "deepscaler:latest");
  const spec = modelSpec("ollama", "deepscaler:latest");
  assert.equal(spec.free, true);
  assert.equal(spec.local, true);
  assert.equal(spec.jsonMode, true, "Ollama accepts response_format");
  assert.equal(spec.thinking, undefined, "no thinking flag: Ollama ignores it");
});

test("model ids from a provider listing are bounded", () => {
  for (const ok of [
    "gpt-4o",
    "glm-4.7-flash",
    "deepscaler:latest",
    "qwen3-vl:2b",
    "a/b-c.d",
  ])
    assert.equal(validModelId(ok), true, ok);
  for (const bad of [
    "",
    "x".repeat(129),
    'a"b',
    "a\nb",
    "a b",
    "-flag",
    "<script>",
    null,
    undefined,
    5,
  ])
    assert.equal(validModelId(bad), false, String(bad));
});

test("the standard cloud providers are offered over HTTPS", () => {
  const ids = catalogue().map((p) => p.id);
  for (const id of [
    "openai",
    "openrouter",
    "groq",
    "together",
    "fireworks",
    "mistral",
    "xai",
    "google",
    "deepinfra",
    "cerebras",
    "sambanova",
    "hyperbolic",
    "nebius",
    "novita",
    "moonshot",
    "dashscope",
    "ollama-cloud",
    "zai",
    "deepseek",
    "ollama",
  ])
    assert.ok(ids.includes(id), `missing provider ${id}`);
  // Every fixed-URL provider is HTTPS; only the endpoint provider has no URL.
  for (const p of Object.values(PROVIDERS)) {
    if (p.endpoint) {
      assert.equal(p.baseUrl, null, p.id);
      continue;
    }
    assert.match(String(p.baseUrl), /^https:\/\//, `${p.id} must be HTTPS`);
  }
});

test("cloud providers are dynamic; the built-in ones are not", () => {
  for (const id of [
    "openai",
    "openrouter",
    "groq",
    "ollama-cloud",
    "dashscope",
  ])
    assert.equal(isDynamic(id), true, id);
  for (const id of ["zai", "deepseek", "ollama"])
    assert.equal(isDynamic(id), false, id);
  // Dynamic providers are fixed-URL, so they never take a custom endpoint.
  assert.equal(needsEndpoint("openai"), false);
  assert.equal(needsEndpoint("ollama-cloud"), false);
  assert.equal(needsEndpoint("ollama"), true);
});

test("a dynamic provider lists models from its own /models endpoint", async () => {
  const server = await authListingServer(() => {}, ["gpt-5.1", "o4-mini"]);
  const original = PROVIDERS.openai.baseUrl;
  PROVIDERS.openai.baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await listModels({ provider: "openai", apiKey: "sk-test" });
    assert.equal(r.source, "provider");
    assert.deepEqual(
      r.models.map((m) => m.id),
      ["gpt-5.1", "o4-mini"],
    );
  } finally {
    PROVIDERS.openai.baseUrl = original;
    await close(server);
  }
});
