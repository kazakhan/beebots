# BeeBots · Coinbase

A self-hosted, paper-first spot-trading bot for Coinbase. Three named agents
trade independent USDC ledgers on live market data; every decision is recorded
before it acts, and a password-protected dashboard shows each order, fill, fee
and decision as it happens. Protective exits are plain code, and the runtime
submits real orders only when explicitly configured to.

**How the system is meant to work — read [SYSTEM.md](SYSTEM.md) first.** It
describes the recursive loop, the Laya/LLM roles, the two switches (decision
engine and the hourly LLM review), and the safety invariants. It is the source of
truth for the design.

**Strategy v2:** automatic USDC discovery, speculative breakout Scout, trend-pullback
Keeper and cross-market momentum Spark. See [v2 release and migration](deploy/UPGRADE-V2.md).
The original v1 runtime/config remain compatible for existing positions and tests;
the paragraphs below describe the initial deployment where they mention a fixed universe.

This is a **Coinbase rebase of [beebots](https://github.com/imikerussell/beebots)
by Mike Russell** (MIT) — the OKX perpetuals project in which every decision came
from **Jev**, TypeSafe AI's System One decision model
([introducing System One models](https://typesafe.ai/blog/introducing-system-one-models-and-jev);
Laya is the open-weights equivalent:
[laya, how it works](https://huggingface.co/blog/sora-2/laya-ai-model-how-it-works-run-it-locally-and-eval)).
Upstream snapshot `5ddd6d18e9646f068c5ee2f5703d1e829461c76a`. The original OKX/Jev
source is retained in the parent repository for provenance.

This directory is the deployable Coinbase runtime. It keeps the upstream idea — a
System One engine reads structured state, plain code gates every order, and the
ledger is the record — and adds an independent spot ledger, a Unix-socket Laya
integration, an OpenAI-compatible decision model, and a selectable **decision
engine**:

| Engine       | Decides        | Notes                                            |
| ------------ | -------------- | ------------------------------------------------ |
| `Jev`        | Jev (TypeSafe) | the original beebots engine; needs a Jev API key |
| `Laya`       | Laya (local)   | the open-weights System One model                |
| `LLM`        | provider model | an OpenAI-compatible chat model                  |
| `Jev + LLM`  | LLM            | Jev's proposed move is supplied as evidence      |
| `Laya + LLM` | LLM            | Laya's classification is evidence (the default)  |

It does not load the upstream futures engine, forced-entry rules, Hive uploader
or portraits.

**Access.** The dashboard and its live feed are public; anyone can watch. The
gear opens an **owner login** that gates the settings and the pause control, and
the login is remembered for the browser tab. Set the credentials with
`npm run password` (see `deploy/INSTALL.md`).

**Money mode.** Each bot is real or paper per its `paper` flag, and
`config.example.json` ships the strategy bots as `paper: true`, so a fresh
install trades a simulated ledger on live prices. Real orders additionally
require `mode: "live"` and the explicit acknowledgement; a paper bot never
touches the exchange. If a paper control arm strands simulated dust whose market
is gone, or a halt is stuck, clear it with `npm run reset-control` while the
service is stopped (it refunds positions at cost and clears the halt).

> **This can trade real money.** With `mode: "live"` and a bot set to
> `paper: false`, it submits live market orders on Coinbase. It is not investment
> advice, comes with no warranty, and the shipped strategy parameters are
> unproven starting points rather than backtested promises. Run it in
> `mode: "observe"` first, fund small, and read `deploy/INSTALL.md` before
> enabling live orders. You are responsible for every order it places.

## Getting started

Prerequisites:

- **Node 24+** (the runtime uses the built-in `node:sqlite`).
- **Python 3** with the [Coinbase Advanced Trade SDK](https://github.com/coinbase/coinbase-advanced-py)
  (`pip install coinbase-advanced-py`); point `coinbasePython` at that interpreter.
- **A Coinbase CDP API key** with trade scope on a portfolio you are willing to
  spend. Supply it one of three ways — the environment always wins:
  1. `COINBASE_KEY_NAME` + `COINBASE_KEY_SECRET` in the environment (recommended), or
  2. `coinbaseApiKeyName` + `coinbaseApiKeySecret` in `config.json`, or
  3. `coinbaseKeyFile` pointing at the CDP JSON key download (`{name, privateKey}`).
- **An OpenAI-compatible decision model.** Pick any provider from the gear dialog
  in the dashboard and paste its key, or set `BEEBOTS_MODEL_KEY` and the `model`
  block in the config.
- **Laya (optional).** The original pipeline adds a local classifier over a Unix
  socket as extra evidence. Without one, set `"layaEnabled": false` and the model
  decides on price/volume metrics alone.

```sh
cp config.example.json /secure/path/config.json   # never commit this file
# edit: mode, portfolio id, Coinbase credential, model, capital, auth
npm run password                                  # prints auth.passwordHash
BEEBOTS_CONFIG=/secure/path/config.json npm run check
BEEBOTS_CONFIG=/secure/path/config.json npm start # observe mode first
```

Then open the dashboard, use the gear to select a decision model, and stay in
`observe` until you have watched it make decisions you agree with. `config.json`
holds credentials and is listed in `.gitignore`; keep it out of version control.

## Local commands (Node 24+)

```text
npm test
npm run demo
```

The demo is localhost-only, synthetic, in-memory, clearly labelled DEMO, and has
no exchange/model connection. Its local-only login is printed in the terminal.

For real configuration, copy `config.example.json` to a private location, supply
the required values, and set `BEEBOTS_CONFIG` to its path:

```text
npm run check
npm start
```

Example allocations are unset, the decision model is unspecified, and order
submission defaults to disabled (`observe`). These are intentional launch inputs,
not a substitute for real execution: the live route submits real Coinbase orders.
Nothing installs, deploys, funds accounts or activates trading automatically.

## Components

| File                        | Responsibility                                                                 |
| --------------------------- | ------------------------------------------------------------------------------ |
| `src/laya.mjs`              | Serial NDJSON socket client, health/readiness, deadlines and answer validation |
| `src/model.mjs`             | Stronger-model decisions from strategy and evidence; no Laya trade actions     |
| `src/providers.mjs`         | Provider/model catalogue, per-model capabilities and token pricing             |
| `src/settings.mjs`          | Dashboard-managed provider, model and API key; 0600, never echoed back         |
| `src/market.mjs`            | Closed candles, separate period/24h turnover, three setup families             |
| `strategies/`               | Bot instructions; numeric parameters reside in the explicit config             |
| `src/engine.mjs`            | Analysis loop, independent exit loop, execution checks and reconciliation      |
| `src/store.mjs`             | Atomic SQLite state/audit, cash reservations and cumulative fill accounting    |
| `src/decimal.mjs`           | Exact ledger arithmetic and exchange increment rounding                        |
| `src/coinbase_bridge.py`    | Narrow SDK transport using private credential files                            |
| `src/server.mjs`, `public/` | Authenticated dashboard/API/SSE, rankings, analysis and decision stream        |
| `deploy/`                   | Reviewed installation plan, service and lighttpd templates                     |

## Decision model

The decision model is any catalogue provider in `src/providers.mjs`, selected at
runtime from the **gear icon** in the header. The dropdown fills from that
catalogue and **fetching models is automatic**: selecting a provider queries its
own `/models` server-side and populates the model list, falling back to the
built-in catalogue if the call fails.

Twenty providers are offered: `openai`, `openrouter`, `groq`, `together`,
`fireworks`, `mistral`, `xai`, `google`, `deepinfra`, `cerebras`, `sambanova`,
`hyperbolic`, `nebius`, `novita`, `moonshot`, `dashscope` (Qwen), **`ollama-cloud`**
(hosted, key required, `https://ollama.com/v1`), plus the priced `zai` and
`deepseek` tables. These are all OpenAI-compatible and expose `GET /models`, so
their model lists are discovered live rather than baked in.

**Ollama (local)** is the exception: it takes an owner-supplied endpoint (default
`http://127.0.0.1:11434/v1`) because the host differs per deployment, and
needs no API key. Every cloud provider is a fixed HTTPS host from the catalogue,
never a caller-supplied URL, so a key can only reach the provider it was
configured for.

Selection and key precedence:

1. `/var/lib/beebots/model.json`, written by the dashboard (`0600`, owner
   `beebots`). A key saved there is bound to the provider it was entered for and
   is never sent to a different provider.
2. Otherwise `/etc/beebots/model.env` (`BEEBOTS_MODEL_KEY`), matching the
   configured `model.baseUrl`/`model.name`.

With neither, the owner's `config.json` model block is used exactly as before —
this release is a no-op until a selection is saved.

Costs are estimates in USD, accumulated as integer nano-USD per day and shown
beside the call count. DeepSeek peak hours (01:00–04:00 and 06:00–10:00 UTC,
Mon–Fri) are priced at double the off-peak rate; **Chinese public holidays are not
encoded**, so those hours bill as off-peak and slightly understate cost. Zai's
free models report zero. An unrecognised model counts its tokens but shows no
cost rather than a fabricated one.

Request parameters follow each model's capabilities. GLM-4.7-series models reason
compulsively unless sent `thinking:{"type":"disabled"}`; always-reasoning models
such as `glm-5.3-flash` reject that field with code 1210 and must not receive it.
Transient overload (HTTP 429/5xx, Zai in-body code 1305) is retried once within
the existing timeout budget; authentication and validation failures are not. A
free-tier rate limit (HTTP 429 or Zai in-body 1302) waits 8s before its single
retry rather than the 1.5s an overloaded backend gets, and the retry is skipped
when the deadline cannot absorb the wait.

An owner-supplied endpoint is accepted for Ollama as typed, and the owner chose
that explicitly over a loopback/private-range restriction. It is therefore not a
credential-exfiltration path — a key only ever goes to a fixed-URL provider — but
it does let the server issue requests to any reachable URL. Restrict it in
`Settings.endpoint()` if that trade-off changes. Ollama is plaintext `http` on a
LAN by design and is exempt from the HTTPS-or-localhost rule applied to every
other endpoint; no credential is ever sent to it.

Switching the model affects **new entry decisions only**. Protective exits are
computed in `src/engine.mjs` and never consult the model. Pause entries before
switching while positions are open, then watch a few cycles before resuming.

All bots initially use a single explicitly selected Coinbase portfolio, with
internal quantity and cash ownership enforced by one coordinator. Unallocated
assets are not adopted. Capital changes and historical ledger migrations are
explicit operational tasks; config edits cannot rewrite performance history.

## Positions, strategy and ledger size

Each bot holds up to **`maxPositions`** concurrent positions (default 3,
per-bot in `config.json`, validated 1-5), each with its own stop and exit
policy. Positions are keyed by product, so a bot cannot hold the same pair
twice. Only one order is in flight per bot at a time; protective exits are
worked off sequentially. A ledger written before 2.3.0 (where a bot had a single
`position`) is migrated in place at startup — the open position and its policy
are preserved and nothing is liquidated.

**Scout's entry gates were loosened in 2.3.0** (`rangeAtr` 6, volatility
contraction within 1.5× the median, close location 0.5, `maxExtensionAtr` 2,
`maxCostRisk` 0.4). `relativeVolume` (2×) and `riskPct` (1) are unchanged, and
the completed-breakout requirement is not relaxed. Keeper and Spark are
unchanged. Expect more false breakouts as the direct cost of the wider gates;
the decision model still reviews every candidate before an order.

The ledger's growth is bounded: `market` telemetry older than 24h is pruned at
startup and hourly, and disk is reclaimed on demand with `npm run vacuum` (run
with the service stopped, since `VACUUM` blocks). Audit rows — `decision`,
`order`, `fill`, `veto`, `control`, `system`, `status`, `error` — are never
pruned. The summary strip's equity and P/L exclude the paper control arm; only
real bots are aggregated.

## The control arm and Trade Review

A fourth bot, the **control arm**, enters at random from the union of tradable
USDC markets with the same sizing and exits as the live bots. Its only difference
is entry selection, so it is the null baseline the strategies are measured
against. It runs on a **paper** ledger by default (`"paper": true`): fills are
simulated at the touch with the real taker fee and booked through the same ledger
path, never touching the exchange. Setting `"paper": false` and funding its
ledger switches it to real funds.

The **Trade Review** runs on two cadences. **Hourly at `:00`** it collects data
only: Laya reads the hour and the record is stored, with no LLM and no changes.
**Daily at 06:00 local** the decision model reviews the accumulated day and is
the only pass that applies changes: at most three proposals that adjust a bot's
numeric strategy, a bot's rubric, **Laya's own question sets**, or the
**strategy pool** (delete a losing template / add a new combination of a coded
rule + universe + timeframe). The review judges Laya as well as the bots, using
a table of Laya's label distribution and the win rate / P&L its pre-entry `fit`
tracked.

A proposal is applied only when it stays in scope (prose only — never risk
numbers, capital, mode or code), is a **complete validated document** (a rubric
with a heading and every safety clause, or a JSON question set with the expected
heads), and passes the evidence gate:

- `laya.reviewQuestions` (the review's own questions) is **structural** and
  ungated — it cannot affect trading.
- `rubric.*` and `laya.analysisQuestions` are **edge** changes: they need
  `review.minSample` (**25** since 3.6.0) closed trades on the target arm.

Applied changes are files under `/var/lib/beebots/overrides/`, feed `ruleHash`,
and can be reverted individually. `review.minSample` and `review.autoApply` are
configurable.

See [deployment handover](deploy/INSTALL.md) for activation, limitations and
permissions. The app is built locally; no server deployment or real trade has
been performed as part of the build.

## API references used

- [Create order](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/orders/create-order)
- [Get order](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/orders/get-order)
- [Product metadata](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/products/get-product)
- [Coinbase Python SDK](https://github.com/coinbase/coinbase-advanced-py)
- Laya socket contract: owner-provided daemon handover (27 September 2026).
