// Dashboard-managed decision-model selection.
//
// The API key is stored outside /etc because the service runs with
// ProtectSystem=strict and ReadWritePaths=/var/lib/beebots: it can only write
// below its StateDirectory. The owner's /etc/beebots/config.json model block and
// model.env remain the fallback when no settings file exists.
//
// The key is deliberately kept out of SQLite. The ledger is copied wholesale by
// activate-v2.sh and by backup tooling; a plaintext API key should not travel
// with trading history. It is also never returned by any endpoint - only a
// masked hint is.
import {
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import {
  PROVIDERS,
  isProvider,
  isModel,
  isDynamic,
  validModelId,
  needsEndpoint,
  allowsNoKey,
} from "./providers.mjs";
import { isEngine, engineLabel, DEFAULT_ENGINE } from "./engines.mjs";

const MAX_KEY = 200;
// Owner-supplied endpoints (Ollama) are accepted as typed. The owner asked for
// this explicitly: any http/https URL. This is the documented trade-off recorded
// in CHANGELOG 2.2.0 - the endpoint is never sent an API key.
const MAX_ENDPOINT = 300;

export class Settings {
  constructor({ dataDir, fallback, defaultEngine = DEFAULT_ENGINE }) {
    this.path = join(dataDir, "model.json");
    // An install that has never picked an engine falls back to the one that
    // matches its config: Laya+LLM normally, LLM-only when Laya is disabled.
    this.defaultEngine = isEngine(defaultEngine)
      ? defaultEngine
      : DEFAULT_ENGINE;
    this.fallback = {
      baseUrl: fallback?.baseUrl ?? null,
      name: fallback?.name ?? null,
      apiKeyEnv: fallback?.apiKeyEnv || "BEEBOTS_MODEL_KEY",
      allowNoKey: !!fallback?.allowNoKey,
    };
    // The default Jev model is code, not owner input, so a fresh install has a
    // valid value the moment Jev is selected.
    this.defaultJevModel = "jev-1.13.0";
    // The hourly review uses the LLM by default, independently of the decision
    // engine (which defaults to Laya-only). Owner-toggleable.
    this.defaultReviewLlm = true;
    this.cache = null;
  }

  // Map a pre-catalogue config (base URL + model name) onto a known provider so
  // a configuration written before this release still resolves.
  inferProvider() {
    const base = String(this.fallback.baseUrl ?? "");
    const name = this.fallback.name;
    // Prefer a provider whose fixed base URL prefixes the configured one. This
    // covers the expanded catalogue without enumerating every host by hand.
    for (const p of Object.values(PROVIDERS))
      if (p.baseUrl && base && base.startsWith(p.baseUrl)) return p.id;
    if (isModel("zai", name)) return "zai";
    if (isModel("deepseek", name)) return "deepseek";
    // Legacy shorthand for the two providers that predate the catalogue.
    if (base.includes("deepseek")) return "deepseek";
    if (base.includes("z.ai")) return "zai";
    return null;
  }

  // Record the operator's configured model when it is not in the catalogue.
  // A retired or misspelt name must be visible, never silently swapped for a
  // different model: a bot placing real orders must use the model that was
  // actually configured. Recorded once per resolution.
  noteUnknownModel(providerId, name) {
    if (!name || typeof name !== "string") return;
    const key = `${providerId}:${name}`;
    if (this.unknownModels?.has(key)) return;
    (this.unknownModels ??= new Set()).add(key);
    this.unknownNote = {
      provider: providerId,
      model: name,
      message:
        `Configured model "${name}" is not offered by ${providerId}. ` +
        `Available: ${
          Object.keys(PROVIDERS[providerId]?.models ?? {}).join(", ") || "none"
        }. Update model.name in config.json.`,
    };
  }

  read() {
    if (this.cache) return this.cache;
    let stored = null;
    try {
      stored = JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      stored = null;
    }
    const provider = isProvider(stored?.provider)
      ? stored.provider
      : this.inferProvider();
    // Providers whose model list is not baked in - the local endpoint and the
    // dynamic cloud catalogue - carry whatever id was resolved, because their
    // lists are discovered rather than fixed.
    const hostSpecific = needsEndpoint(provider) || isDynamic(provider);
    const model = hostSpecific
      ? validModelId(stored?.model)
        ? stored.model
        : null
      : isModel(provider, stored?.model)
        ? stored.model
        : isModel(provider, this.fallback.name)
          ? this.fallback.name
          : this.firstModel(provider);
    // Only warn when the operator's own config named something unusable.
    if (
      !hostSpecific &&
      this.fallback.name &&
      !isModel(provider, this.fallback.name)
    )
      this.noteUnknownModel(provider, this.fallback.name);
    // The dashboard key is bound to the provider it was entered for. Sending a
    // DeepSeek key to api.z.ai would disclose one credential to a third party,
    // so a key is only ever returned for a matching provider.
    const storedKey =
      isProvider(stored?.provider) && stored.provider === provider
        ? typeof stored.apiKey === "string"
          ? stored.apiKey
          : null
        : null;
    // The selected engine and the Jev credential are independent of the LLM
    // provider selection: an owner may keep a Jev key while running Laya+LLM.
    // The engine is always a valid id; a stored unknown value falls back.
    const engine = isEngine(stored?.engine)
      ? stored.engine
      : this.defaultEngine;
    const jevApiKey =
      typeof stored?.jevApiKey === "string" ? stored.jevApiKey : null;
    const jevModel = validModelId(stored?.jevModel)
      ? stored.jevModel
      : this.defaultJevModel;
    const reviewLlm =
      typeof stored?.reviewLlm === "boolean"
        ? stored.reviewLlm
        : this.defaultReviewLlm;
    this.cache = {
      provider,
      model,
      endpoint:
        needsEndpoint(provider) && typeof stored?.endpoint === "string"
          ? stored.endpoint
          : null,
      apiKey: storedKey,
      engine,
      jevApiKey,
      jevModel,
      reviewLlm,
      source: stored && isProvider(stored?.provider) ? "dashboard" : "config",
    };
    return this.cache;
  }

  // Normalise an owner-supplied endpoint. Accepts http/https as typed, per the
  // owner's explicit choice in 2.2.0. Credentials embedded in the URL are
  // refused so a saved endpoint cannot smuggle a secret into every request.
  static endpoint(value) {
    if (typeof value !== "string" || !value.trim())
      throw Error("Endpoint is required for a local provider");
    const raw = value.trim();
    if (raw.length > MAX_ENDPOINT) throw Error("Invalid endpoint");
    let u;
    try {
      u = new URL(raw);
    } catch {
      throw Error("Invalid endpoint URL");
    }
    if (u.protocol !== "http:" && u.protocol !== "https:")
      throw Error("Endpoint must be http or https");
    if (u.username || u.password)
      throw Error("Endpoint must not embed credentials");
    // Strip a trailing slash so joining "/chat/completions" stays well-formed.
    return raw.replace(/\/+$/, "");
  }

  // Key precedence: dashboard settings file, then the owner's model.env. The
  // env fallback belongs to the configured provider, so it is only offered when
  // the effective provider is the one the config was written for.
  key(providerId) {
    const s = this.read();
    // A provider that needs no credential must never receive one. Sending the
    // configured provider's key to a local Ollama box would hand it to whatever
    // machine the owner typed into the endpoint field.
    if (allowsNoKey(providerId)) return null;
    // The stored key is bound to its provider by read().
    if (s.apiKey && providerId === s.provider) return s.apiKey;
    // A non-catalogue config endpoint (providerId null) is the owner's own
    // model; hand it the env key as before.
    if (providerId === null)
      return process.env[this.fallback.apiKeyEnv] ?? null;
    // The model.env fallback belongs to the provider the static config was
    // written for. It must only ever go to THAT provider: selecting a different
    // one in the dashboard must not forward, say, a DeepSeek key to OpenAI.
    const configProvider = this.inferProvider();
    if (configProvider && providerId === configProvider)
      return process.env[this.fallback.apiKeyEnv] ?? null;
    return null;
  }

  // Full resolution used by the decision model at call time.
  effective() {
    const s = this.read();
    const provider = isProvider(s.provider) ? s.provider : null;
    const p = provider ? PROVIDERS[provider] : null;
    const endpointProvider = needsEndpoint(provider);
    return {
      provider,
      model: s.model,
      baseUrl: endpointProvider
        ? s.endpoint
          ? s.endpoint
          : this.defaultEndpoint(provider)
        : p
          ? p.baseUrl
          : this.fallback.baseUrl,
      key: this.key(provider),
      allowNoKey:
        endpointProvider || allowsNoKey(provider) || this.fallback.allowNoKey,
      apiKeyEnv: this.fallback.apiKeyEnv,
      endpointProvider,
    };
  }

  // The selected decision engine. Always a valid id.
  engineValue() {
    return this.read().engine;
  }

  // Whether the hourly review uses the LLM, independent of the decision engine.
  reviewLlm() {
    return this.read().reviewLlm !== false;
  }

  // The Jev key precedence: dashboard settings file, then TYPESAFE_API_KEY.
  // Unlike a provider key, there is only one Jev vendor, so the env fallback is
  // never bound to a different provider selection.
  keyJev() {
    const s = this.read();
    if (s.jevApiKey) return s.jevApiKey;
    return process.env.TYPESAFE_API_KEY ?? null;
  }

  // Full resolution for the Jev client at call time. Timeout and daily cap are
  // service config, not dashboard state, so they live with the client.
  effectiveJev() {
    const s = this.read();
    return { model: s.jevModel, key: this.keyJev() };
  }

  // First catalogue entry, used only when nothing is configured. The unknown-name
  // warning is what tells the operator this substitution happened.
  firstModel(providerId) {
    return Object.keys(PROVIDERS[providerId]?.models ?? {})[0] ?? null;
  }

  // Owner-configured default for the local provider. Overridable at runtime.
  defaultEndpoint(providerId) {
    return PROVIDERS[providerId]?.defaultEndpoint ?? null;
  }

  // Public shape for the API. The key never leaves this object.
  redacted() {
    const s = this.read();
    const key = this.key(s.provider);
    const jevKey = this.keyJev();
    return {
      provider: s.provider,
      model: s.model,
      source: s.source,
      hasKey: !!key,
      keyHint: key ? `…${key.slice(-4)}` : null,
      keyEnv: this.fallback.apiKeyEnv,
      apiKeyEnv: this.fallback.apiKeyEnv,
      fallbackName: this.fallback.name,
      endpoint:
        s.endpoint ??
        (needsEndpoint(s.provider) ? this.defaultEndpoint(s.provider) : null),
      defaultEndpoint: needsEndpoint(s.provider)
        ? this.defaultEndpoint(s.provider)
        : null,
      // The decision-engine selection and the separate Jev credential. The Jev
      // key is masked exactly like the provider key: a hint of the last four
      // characters, never the value.
      engine: s.engine,
      engineLabel: engineLabel(s.engine),
      reviewLlm: s.reviewLlm,
      jev: {
        model: s.jevModel,
        modelDefault: this.defaultJevModel,
        hasKey: !!jevKey,
        keyHint: jevKey ? `…${jevKey.slice(-4)}` : null,
        keyEnv: "TYPESAFE_API_KEY",
      },
      // Non-null when config.json named a model this catalogue does not offer.
      // Surfaced so a retired or misspelt name cannot pass unnoticed.
      unknownModel: this.unknownNote ?? null,
    };
  }

  // Validate and persist. Catalogue providers take only a listed model; the
  // local provider takes any well-formed id because its model list is
  // host-specific. A free-text endpoint is accepted only for providers flagged
  // `endpoint`, and never for one that has a fixed catalogue URL - so this
  // cannot aim a catalogue provider's API key at an arbitrary host.
  save({
    provider,
    model,
    apiKey,
    clearKey,
    endpoint,
    engine,
    jevApiKey,
    clearJevKey,
    jevModel,
    reviewLlm,
  }) {
    if (!isProvider(provider)) throw Error("Unknown decision-model provider");
    // A dynamic provider's models are discovered, so any well-formed id from its
    // listing is acceptable; only a custom ENDPOINT is still restricted to the
    // owner-supplied local provider.
    const endpointProvider = needsEndpoint(provider);
    const acceptAnyModel = endpointProvider || isDynamic(provider);
    if (acceptAnyModel ? !validModelId(model) : !isModel(provider, model))
      throw Error("Model is not offered by that provider");
    if (
      endpoint !== undefined &&
      endpoint !== null &&
      endpoint !== "" &&
      !endpointProvider
    )
      throw Error("This provider does not accept a custom endpoint");
    if (clearKey && apiKey)
      throw Error("Cannot set and clear the key together");
    if (engine !== undefined && engine !== null && !isEngine(engine))
      throw Error("Unknown decision engine");
    if (reviewLlm !== undefined && typeof reviewLlm !== "boolean")
      throw Error("Invalid reviewLlm");
    if (jevModel !== undefined && jevModel !== null && !validModelId(jevModel))
      throw Error("Invalid Jev model");
    if (clearJevKey && jevApiKey)
      throw Error("Cannot set and clear the Jev key together");
    if (jevApiKey !== undefined && jevApiKey !== null && jevApiKey !== "") {
      if (typeof jevApiKey !== "string" || jevApiKey.length > MAX_KEY)
        throw Error("Invalid Jev API key");
      if (/\s/.test(jevApiKey)) throw Error("Invalid Jev API key");
    }
    const current = this.read();
    let key = allowsNoKey(provider)
      ? null
      : current.provider === provider && isProvider(provider)
        ? current.apiKey
        : null;
    if (clearKey) key = null;
    if (apiKey !== undefined && apiKey !== null && apiKey !== "") {
      if (typeof apiKey !== "string" || apiKey.length > MAX_KEY)
        throw Error("Invalid API key");
      if (/\s/.test(apiKey)) throw Error("Invalid API key");
      if (allowsNoKey(provider))
        throw Error("This provider does not use an API key");
      key = apiKey;
    }
    const savedEndpoint = endpointProvider
      ? Settings.endpoint(endpoint ?? current.endpoint)
      : null;
    // Clearing is a legitimate end state: it hands the selection back to
    // model.env. Refuse only a selection that would leave the runtime with no
    // key source. A local provider needs no key, so it is always valid, and the
    // env key only counts for the provider the static config was written for.
    const envApplies =
      this.inferProvider() === provider &&
      !!process.env[this.fallback.apiKeyEnv];
    if (!allowsNoKey(provider) && !key && !clearKey && !envApplies)
      throw Error("No API key is configured for this provider");
    // The engine and Jev credential persist independently of the provider key.
    // A blank Jev key field keeps the stored one; clearJevKey removes it.
    const savedEngine = isEngine(engine) ? engine : current.engine;
    const savedJevModel = validModelId(jevModel) ? jevModel : current.jevModel;
    const savedReviewLlm =
      typeof reviewLlm === "boolean" ? reviewLlm : current.reviewLlm;
    let jevKey = current.jevApiKey;
    if (clearJevKey) jevKey = null;
    if (typeof jevApiKey === "string" && jevApiKey) jevKey = jevApiKey;
    this.write({
      provider,
      model,
      apiKey: key,
      endpoint: savedEndpoint,
      engine: savedEngine,
      jevApiKey: jevKey,
      jevModel: savedJevModel,
      reviewLlm: savedReviewLlm,
    });
    return this.redacted();
  }

  write(value) {
    const tmp = this.path + ".tmp";
    writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
    this.cache = null;
    // Enforce the mode explicitly: a permissive umask must not widen the file.
    chmodSync(this.path, 0o600);
  }

  remove() {
    try {
      unlinkSync(this.path);
    } catch {
      // Nothing to remove.
    }
    this.cache = null;
  }
}
