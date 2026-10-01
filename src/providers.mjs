// Decision-model providers, model capabilities and token pricing.
//
// Costs are held as integer nano-USD per single token, derived as
// usdPerMillion * 1000. Integers keep the ledger-style fixed-point discipline of
// decimal.mjs: no float ever accumulates into persisted state. Costs are computed
// for display and budgeting only and never touch bot capital.

const NANO = 1000n;

// usdPer1M -> nano-USD per token. Rates are published per million tokens;
// 1 USD/1M tokens is 1000 nano-USD per token.
const rate = (usdPer1M) => BigInt(Math.round(Number(usdPer1M) * Number(NANO)));

// DeepSeek bills peak hours at exactly double the off-peak rate.
// Peak is 01:00-04:00 and 06:00-10:00 UTC, Monday to Friday. Chinese public
// holidays are not encoded here, so those hours are charged at the off-peak
// rate. That understates cost on a minority of days; the dashboard says so.
export function isPeakUtc(at = Date.now()) {
  const d = new Date(at);
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  const h = d.getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}

// A provider whose model catalogue is fetched live rather than baked in. Their
// lists change weekly, so the dashboard fills the model dropdown from the
// provider's own GET /models and `dynamic: true` lets a fetched id be saved
// without a built-in table. All are OpenAI-compatible /chat/completions hosts.
const dynamicProvider = (id, label, baseUrl) => ({
  id,
  label,
  baseUrl,
  dynamic: true,
  models: {},
});

export const PROVIDERS = {
  zai: {
    id: "zai",
    label: "Z.ai",
    baseUrl: "https://api.z.ai/api/paas/v4",
    // Documented 29 September 2026. GLM-4.7-Flash is free on every token class,
    // which is the reason it is offered as the default recommendation.
    models: {
      "glm-4.7-flash": {
        label: "GLM-4.7-Flash (free)",
        free: true,
        // GLM-4.7 series reasons compulsively unless thinking is switched off;
        // left enabled it burns latency and returns reasoning_content.
        thinking: "disabled",
        jsonMode: true,
        maxTokens: 2048,
        input: 0,
        cachedInput: 0,
        output: 0,
      },
      "glm-4.5-flash": {
        label: "GLM-4.5-Flash (free)",
        free: true,
        thinking: "disabled",
        jsonMode: true,
        maxTokens: 2048,
        input: 0,
        cachedInput: 0,
        output: 0,
      },
      "glm-4.7-flashx": {
        label: "GLM-4.7-FlashX ($0.07 in / $0.40 out per 1M)",
        free: false,
        thinking: "disabled",
        jsonMode: true,
        maxTokens: 2048,
        input: rate(0.07),
        cachedInput: rate(0.01),
        output: rate(0.4),
      },
      "glm-4.7": {
        label: "GLM-4.7 ($0.60 in / $2.20 out per 1M)",
        free: false,
        thinking: "disabled",
        jsonMode: true,
        maxTokens: 4096,
        input: rate(0.6),
        cachedInput: rate(0.11),
        output: rate(2.2),
      },
      "glm-5.3-flash": {
        label: "GLM-5.3-Flash ($0.15 in / $0.50 out per 1M)",
        free: false,
        // Always reasons; passing thinking:disabled is rejected with code 1210.
        thinking: "required",
        jsonMode: true,
        maxTokens: 8192,
        input: rate(0.15),
        cachedInput: rate(0.03),
        output: rate(0.5),
      },
    },
  },
  // Local inference. The endpoint is owner-supplied because the host differs per
  // deployment, and Ollama needs no credential. It carries no static model list:
  // installed models are host-specific, so an empty catalogue is correct and the
  // dashboard lists what /v1/models actually reports.
  ollama: {
    id: "ollama",
    label: "Ollama (local)",
    baseUrl: null,
    endpoint: true,
    allowNoKey: true,
    // Local inference costs nothing. Keep the flags aligned with what Ollama's
    // OpenAI-compatible endpoint accepts: json mode yes, thinking control no.
    models: {},
    free: true,
    // Configurable at runtime from the dashboard. Ollama's OpenAI-compatible
    // surface is at /v1, so this is the full prefix, not a bare host.
    defaultEndpoint: "http://127.0.0.1:11434/v1",
  },
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    models: {
      "deepseek-flash": {
        label: "DeepSeek Flash (DeepSeek-V4.1-Flash)",
        free: false,
        thinking: "off-peak-priced",
        jsonMode: true,
        maxTokens: 8192,
        // Off-peak / peak pairs, USD per 1M tokens.
        rates: {
          offPeak: {
            cachedInput: rate(0.003),
            input: rate(0.15),
            output: rate(0.6),
          },
          peak: {
            cachedInput: rate(0.006),
            input: rate(0.3),
            output: rate(1.2),
          },
        },
      },
      "deepseek-v4-pro": {
        label: "DeepSeek V4 Pro",
        free: false,
        thinking: "off-peak-priced",
        jsonMode: true,
        maxTokens: 8192,
        rates: {
          offPeak: {
            cachedInput: rate(0.022),
            input: rate(0.66),
            output: rate(1.98),
          },
          peak: {
            cachedInput: rate(0.044),
            input: rate(1.32),
            output: rate(3.96),
          },
        },
      },
    },
  },
  // Standard OpenAI-compatible providers. Every base URL below is a fixed HTTPS
  // host resolved from the catalogue, never a caller-supplied URL, so an API key
  // can only reach the provider it was configured for.
  openai: dynamicProvider("openai", "OpenAI", "https://api.openai.com/v1"),
  openrouter: dynamicProvider(
    "openrouter",
    "OpenRouter",
    "https://openrouter.ai/api/v1",
  ),
  groq: dynamicProvider("groq", "Groq", "https://api.groq.com/openai/v1"),
  together: dynamicProvider(
    "together",
    "Together AI",
    "https://api.together.xyz/v1",
  ),
  fireworks: dynamicProvider(
    "fireworks",
    "Fireworks AI",
    "https://api.fireworks.ai/inference/v1",
  ),
  mistral: dynamicProvider(
    "mistral",
    "Mistral AI",
    "https://api.mistral.ai/v1",
  ),
  xai: dynamicProvider("xai", "xAI (Grok)", "https://api.x.ai/v1"),
  google: dynamicProvider(
    "google",
    "Google AI Studio (Gemini)",
    "https://generativelanguage.googleapis.com/v1beta/openai",
  ),
  deepinfra: dynamicProvider(
    "deepinfra",
    "DeepInfra",
    "https://api.deepinfra.com/v1/openai",
  ),
  cerebras: dynamicProvider(
    "cerebras",
    "Cerebras",
    "https://api.cerebras.ai/v1",
  ),
  sambanova: dynamicProvider(
    "sambanova",
    "SambaNova",
    "https://api.sambanova.ai/v1",
  ),
  hyperbolic: dynamicProvider(
    "hyperbolic",
    "Hyperbolic",
    "https://api.hyperbolic.xyz/v1",
  ),
  nebius: dynamicProvider(
    "nebius",
    "Nebius AI Studio",
    "https://api.studio.nebius.com/v1",
  ),
  novita: dynamicProvider(
    "novita",
    "Novita AI",
    "https://api.novita.ai/v3/openai",
  ),
  moonshot: dynamicProvider(
    "moonshot",
    "Moonshot AI",
    "https://api.moonshot.ai/v1",
  ),
  dashscope: dynamicProvider(
    "dashscope",
    "Qwen (DashScope)",
    "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  ),
  // Ollama Cloud: hosted models, no pull required, subscription rather than a
  // per-token meter. OpenAI-compatible at /v1; model ids come from /v1/models.
  "ollama-cloud": dynamicProvider(
    "ollama-cloud",
    "Ollama Cloud",
    "https://ollama.com/v1",
  ),
};

export function isProvider(id) {
  return typeof id === "string" && Object.hasOwn(PROVIDERS, id);
}

// A provider that takes an owner-supplied endpoint instead of a fixed one.
export function needsEndpoint(id) {
  return isProvider(id) && PROVIDERS[id].endpoint === true;
}

// A provider whose models are discovered from the provider, not a built-in
// table. Any well-formed model id from a listing may be selected.
export function isDynamic(id) {
  return isProvider(id) && PROVIDERS[id].dynamic === true;
}

export function allowsNoKey(id) {
  return isProvider(id) && PROVIDERS[id].allowNoKey === true;
}

export function isModel(providerId, modelId) {
  return (
    isProvider(providerId) &&
    typeof modelId === "string" &&
    Object.hasOwn(PROVIDERS[providerId].models, modelId)
  );
}

// An unknown model is deliberately not priced. Returning null keeps an
// unrecognised model visible rather than silently reporting a free call. The
// local provider is the exception: inference on the owner's own hardware has no
// provider billing at all.
export function modelSpec(providerId, modelId) {
  if (!isModel(providerId, modelId)) {
    if (PROVIDERS[providerId]?.free === true && validModelId(modelId))
      return { id: modelId, free: true, jsonMode: true, local: true };
    return null;
  }
  return PROVIDERS[providerId].models[modelId];
}

// Resolve the effective per-token rates for a model at a given instant.
export function ratesFor(providerId, modelId, at = Date.now()) {
  // Local inference has no provider bill. Zero by definition, not by omission.
  if (PROVIDERS[providerId]?.free === true)
    return { cachedInput: 0n, input: 0n, output: 0n, peak: false };
  const spec = modelSpec(providerId, modelId);
  if (!spec) return null;
  if (spec.rates) {
    const band = isPeakUtc(at) ? "peak" : "offPeak";
    return {
      cachedInput: BigInt(spec.rates[band].cachedInput),
      input: BigInt(spec.rates[band].input),
      output: BigInt(spec.rates[band].output),
      peak: band === "peak",
    };
  }
  // Free models declare literal 0 here, so normalise to BigInt before any
  // multiplication in costOf.
  return {
    cachedInput: BigInt(spec.cachedInput),
    input: BigInt(spec.input),
    output: BigInt(spec.output),
    peak: false,
  };
}

// Token counts as non-negative safe integers. Providers report numbers; a
// malformed or absent usage block must not poison a running total.
function tokens(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? BigInt(n) : 0n;
}

// Cost of one call in nano-USD. Reads prompt/completion/cached tokens, which
// both providers populate. reasoning_tokens are already inside completion_tokens
// and are billed as output, so they are not added again.
// Returns null when the model has no published rate in this catalogue.
export function costOf(usage, providerId, modelId, at = Date.now()) {
  const rates = ratesFor(providerId, modelId, at);
  // An unknown model is left visibly unpriced rather than reported as free.
  if (!rates) return null;
  const u = usage && typeof usage === "object" ? usage : {};
  const prompt = tokens(u.prompt_tokens);
  const completion = tokens(u.completion_tokens);
  const cached = tokens(u.prompt_tokens_details?.cached_tokens);
  // Cached tokens are a subset of prompt tokens; never charge the full input
  // rate on a token that was billed at the cache rate.
  const uncached = prompt > cached ? prompt - cached : 0n;
  return (
    cached * rates.cachedInput +
    uncached * rates.input +
    completion * rates.output
  );
}

export function usageCounts(usage) {
  return {
    promptTokens: tokens(usage?.prompt_tokens),
    completionTokens: tokens(usage?.completion_tokens),
    cachedTokens: tokens(usage?.prompt_tokens_details?.cached_tokens),
    totalTokens: tokens(usage?.total_tokens),
  };
}

// Provider-labelled model string for the dashboard and audit records.
// Model ids arrive from a provider listing, so they are not restricted to a fixed
// alphabet: Ollama uses "name:tag" ("deepscaler:latest") and community names can
// carry slashes and dots. Bound the length and reject anything that could alter
// the request shape or escape a JSON string.
const MODEL_ID = /^[A-Za-z0-9._:@/+-]{1,128}$/;

export function validModelId(id) {
  return typeof id === "string" && MODEL_ID.test(id) && !id.startsWith("-");
}

// Providers as offered by the dashboard: label, whether the endpoint is
// owner-supplied, whether a key is needed, and the known models. Ollama has an
// empty model list because its models are host-specific.
export function catalogue() {
  return Object.values(PROVIDERS).map((p) => ({
    id: p.id,
    label: p.label,
    endpoint: p.endpoint === true,
    dynamic: p.dynamic === true,
    allowNoKey: p.allowNoKey === true,
    free: p.free === true,
    defaultEndpoint: p.defaultEndpoint ?? null,
    models: Object.entries(p.models).map(([id, m]) => ({
      id,
      label: m.label,
      free: m.free === true,
    })),
  }));
}

// List the models a provider actually offers. The call is made server-side so an
// API key never reaches the browser and the page stays within its
// connect-src 'self' policy.
// Returns { models, source } where source is "provider" or "catalogue"; a failed
// listing falls back to the catalogue so the dropdown is never empty.
export async function listModels({
  provider,
  endpoint,
  apiKey,
  timeoutMs = 8000,
}) {
  if (!isProvider(provider))
    return { models: [], source: "error", error: "Unknown provider" };
  const p = PROVIDERS[provider];
  const fallback = Object.entries(p.models).map(([id, m]) => ({
    id,
    label: m.label,
  }));
  if (p.endpoint && !endpoint)
    return {
      models: fallback,
      source: "catalogue",
      error: "Enter an endpoint to list models",
    };
  const base = (p.endpoint ? endpoint : p.baseUrl)?.replace(/\/+$/, "");
  const headers = { Accept: "application/json" };
  // Never send a credential to an owner-supplied endpoint. The key belongs to a
  // catalogue provider whose URL is fixed.
  if (!p.endpoint && apiKey) headers.Authorization = `Bearer ${apiKey}`;
  let response;
  try {
    response = await fetch(base + "/models", {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return {
      models: fallback,
      source: "catalogue",
      error: "Provider unreachable",
    };
  }
  if (!response.ok)
    return {
      models: fallback,
      source: "catalogue",
      error: `Provider returned HTTP ${response.status}`,
    };
  let body;
  try {
    body = await response.json();
  } catch {
    return {
      models: fallback,
      source: "catalogue",
      error: "Invalid model list",
    };
  }
  const listed = Array.isArray(body?.data)
    ? body.data
        .map((m) => (typeof m === "string" ? m : m?.id))
        .filter((id) => validModelId(id))
    : [];
  // A provider that answers with nothing usable is treated as a failed listing
  // rather than an empty dropdown.
  if (!listed.length)
    return {
      models: fallback,
      source: "catalogue",
      error: "Provider listed no usable models",
    };
  // Deduplicate and sort so repeated listings do not reshuffle the dropdown.
  return {
    models: [...new Set(listed)]
      .sort((a, b) => a.localeCompare(b))
      .map((id) => ({ id, label: id })),
    source: "provider",
  };
}

export function modelLabel(providerId, modelId) {
  const spec = modelSpec(providerId, modelId);
  // A local model has no published label; its id is the useful description.
  if (!spec || !spec.label) return modelId ?? "unknown";
  return spec.label;
}
