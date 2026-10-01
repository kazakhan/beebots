# BeeBots changelog

Latest entry first. Do not edit previous entries. Backed-up copies of every file
touched by a release live in `_backups/<version>_<UTC timestamp>/`, so any
version can be restored by copying its backups back over the tree.

Versions are semver-ish: MAJOR changes persisted state or the deployment
contract, MINOR adds user-visible behaviour, PATCH is internal or a fix.

> Version note: the 2.1.1 emergency entry below was released **after** 2.2.0, so
> the sequence in this file is chronological but not monotonic. Per the
> "do not edit previous entries" rule it is left as published. This release is
> 2.3.0, which is greater than both.

---

## [3.1.0] - 2026-10-01 - The Trade Review tunes the strategy, not just the prose

The hourly review is the fine-tuner: Laya (or Jev) plus the decision model
change the bots to beat the control arm (Dice) - more wins, fewer losses. Until
now it could only rewrite prose rubrics and Laya's questions; a self-imposed
"prose only" rule (added in error) kept it away from the numbers that actually
control entry frequency. That rule is gone.

### Added

- **Numeric self-tuning.** New override targets `params.breakout|trend|momentum|control`
  and `runtime`, written by the review like rubrics: entry gates (`rangeAtr`,
  `relativeVolume`, `maxExtensionAtr`, `pullbackBars`, `topFraction`,
  `minBreadth`), risk (`riskPct`, `maxCostRisk`, `stopPct`, `trail*`), the
  **cadence**, **candidate cap**, **signal timeframe** and Scout's **universe
  categories**, plus runtime cadence/candidate budget/model call budget. Each
  key has a hard range (`src/overrides.mjs`); out-of-bounds or unknown keys
  (capital, mode, leverage, stops-off) are refused.
- **A Dice scoreboard** in the review context - per-arm realised P&L, wins/losses
  and each bot's gap to the control - so proposals target the objective.
- **Auto-revert.** Every applied arm-scoped change is tracked; after a shadow
  period it is reverted automatically if the arm is losing to Dice. The loop is
  closed and recursive.
- Dashboard: cards show the **effective, auto-tuned** parameters; the Trade
  Review panel has a **Revert** button per applied change; a stuck halt gets a
  **Clear halt** button (`api/halt/clear`); `api/review/revert` is the endpoint.

### Changed

- **Cadence is 5 minutes for every bot** (was Scout 5 m / Spark 15 m / Keeper
  1 h) and is tunable. **Candidate cap 25** (was 3). Model call budget default 5000.
- **Scout scans every tradeable market**, not only meme/speculative; meme and
  newly listed coins are ranked first. Listing age is tracked by first-seen
  (Coinbase exposes no listing date).
- **Keeper runs a 15-minute signal**; Spark and Keeper ship looser defaults.
- **A paper fill can never set the global halt** (the Dice rounding incident);
  only a real exchange fill can.
- The review gate applies faster: `review.minSample` default 5, and the control
  is the objective, not a hard gate (`review.requireControl`, default false).
- **Laya is uncapped** (it is local and free). The Jev daily cap default is
  raised to 20.

### Verification

- 226 Node tests pass, up from 217: numeric-schema bounds and unknown-key
  refusal, paper-can't-halt vs real-can-halt, numeric proposal apply/revert,
  numeric targets scored against their own arm, Scout accepting any category,
  and the fast gate.

---

## [3.0.4] - 2026-10-01 - Expected refusals are logged as vetoes, not errors

`"Depth impact exceeds risk budget"` and the other risk/market declines are the
engine correctly refusing a trade, but `execute` threw them as plain errors and
the per-bot catch logged them as red `error` events - so ordinary refusals read
as failures.

### Changed

- **A `Refusal` is a decline, not a fault.** New `src/refusal.mjs`; the risk
  layer (`strategy-v2.executionPlan`: depth impact, execution cost, risk distance,
  insufficient depth) and the expected `execute` declines (`entry no longer
qualifies`, `entry changed/expired`, `position limit`, `holds this pair`,
  `position changed`, `insufficient cash/asset`, `below/above product minimum`,
  `risk-sized below minimum`) now throw it. Genuine faults and owner-action
  conditions (identity mismatch, regressed totals, unavailable fee rate,
  `residual holding below exchange minimum; needs owner review`) stay plain
  errors.
- The engine's per-bot, control-arm and protection catches log a **`veto`** for a
  refusal (and clear the status) instead of an `error`.
- The dashboard tints **vetoes amber** and **errors red** (previously both red),
  and the Decision Stream filter gains **Vetoes** and **Errors** options.

### Verification

- 217 Node tests pass (`npm test`), up from 213: `isRefusal` classification,
  `executionPlan` refusals, an engine refusal logged as a veto (not an error),
  and a genuine fault still logged as an error.

### Note

This changes reporting only; the risk guard is unchanged. To let a specific bot
take trades the depth check declines, raise `riskPct` or `maxCostRisk` for it in
`config.json` - not the guard.

---

## [3.0.3] - 2026-10-01 - Exact paper fills; reset-control clears a sticky halt

Root cause of the repeated `"Exchange buy value exceeded requested quote size"`
on the paper control. 3.0.2 stopped rounding paper order sizes to the exchange
increment, so a size could carry 18 decimals. `paperFill` then made the fill
with floats and `toFixed(12)`, which could round **up** above the requested
size; `applyOrder` treats a reported value larger than the requested quote size
as a halt. The halt is persisted and never cleared, so it kept blocking the
arm's entries.

### Fixed

- **`paperFill` is exact fixed-point and never exceeds the request.** The value
  is the requested quote size for a buy and `size * price` for a sell, computed
  with the decimal helpers; the base quantity is floored by integer division; the
  touch price comes from the book's raw decimal string, so sub-micro prices no
  longer hit exponential `String(Number)` notation. No float rounding, no
  overshoot, no halt. (`engine.mjs`)
- **`npm run reset-control` now also clears a sticky halt**, since a halt (once
  persisted) is otherwise permanent, even across restarts. The tool still refuses
  a real control arm and refuses while the runtime owns the ledger.

### Verification

- 213 Node tests pass (`npm test`), up from 208: paper-fill value/quantity never
  exceed the request (including the 13-decimal round-up case and a sub-micro
  price), a paper buy sets no halt, and reset clears a halt.

---

## [3.0.2] - 2026-10-01 - Paper arms ignore exchange increments too

Follow-up to 3.0.1. Exempting paper arms from the exchange _minimum_ was not
enough: the order size was still floored to the product's lot/precision
increment, so a paper position smaller than one lot floored to `0` and
`store.reserve` rejected the close with **"Cannot sell unowned quantity"**.

### Fixed

- **A paper arm is no longer rounded down to exchange increments** (BUY and
  SELL). Its simulated sizes are exactly what the sizing code produced, so a
  sub-lot holding is sold in full instead of becoming an unsellable `0`. Real
  orders keep the increment flooring. (`engine.mjs`, the `step` helper.)

### Verification

- 208 Node tests pass (`npm test`), up from 206: a paper arm closes a holding
  smaller than one lot, and opens a below-increment size where a real arm
  refuses.

---

## [3.0.1] - 2026-10-01 - Paper arms close their own dust; discovery excludes untradeable pairs

Fixes the stuck control arm and the blank Dice balance seen live.

### Fixed

- **A paper arm is no longer bound by exchange minimums.** The BUY/SELL
  minimum-size checks (`base_min_size` / `quote_min_size`) now apply only to a
  real order. A paper position that is dust could never be closed - it threw
  "Residual holding below exchange minimum; needs owner review" - even though
  the simulated fill needs no exchange. It now closes, so the control cannot
  strand its own positions.
- **A held product outside the strategy universe is still reviewed.** The engine
  now always searches the full collected snapshot for held rows, not just the
  strategy universe and not only for legacy positions. A holding that dropped
  out of the universe is quoted again, so it is valued (the Dice card shows its
  balance instead of "—") and can be exited.
- **Discovery excludes listed-but-untradeable products.** `discover()` now
  requires real lot/precision metadata (`base_increment`, `quote_increment`,
  `base_min_size`, `quote_min_size`) - the same fields `assertTradable` enforces
  at submit time. Some Coinbase USDC products are returned online but carry no
  usable sizing, so no order can be placed; they no longer enter the tradable
  universe or show as eligible in Market coverage.

### Added

- **`npm run reset-control`** (`src/reset-control.mjs`): with the service
  stopped, clears a stuck PAPER control arm by refunding each position at its
  recorded cost and emptying the book. It refuses to run on a real control arm
  or while the runtime holds the ledger lock. The pure logic lives in
  `src/control-reset.mjs`.

### Verification

- 206 Node tests pass (`npm test`), up from 199: discovery sizing-metadata
  exclusions, the paper-vs-real minimum behaviour, the held-outside-universe
  review, and the control reset.

---

## [3.0.0] - 2026-10-01 - Public dashboard with owner login, Jev spend card, per-bot paper

The dashboard is now public: the page, its assets and the read-only feeds are
served without credentials, and the gear opens an owner login that gates the
settings and the pause control. This changes the deployment and security
contract, hence a major bump.

### Added

- **Jev spend.** Jev usage is recorded in the same day-scoped ledger as the LLM
  (provider `jev`, billed on input tokens), the daily cap is restored from the
  ledger on restart, and a **Jev spend** summary card appears next to the model
  card whenever the engine uses Jev (`Jev` or `Jev + LLM`) - matching the
  upstream counter: today's spend to four decimals with the cap and call count
  beneath. The model card now shows the LLM only, so the two never double-count.
- **Owner login.** The page and the SSE feed are public; `api/settings*` and
  `api/entries` require the owner login. The gear opens a login dialog when
  signed out and the settings dialog as before when signed in; credentials are
  kept for the browser tab (`sessionStorage`) with a **Log out** button. A 401
  is JSON with no `WWW-Authenticate`, so the browser never shows its native
  prompt.
- **Per-bot real/paper.** `paper` is now validated as a boolean on every bot,
  not only the control.

### Changed

- **Decision stream and order ledger are colour-coded.** Each event row carries
  a tint and a left edge by kind (decision = gold, order/fill = green,
  veto/error = red, analysis = violet, review = teal, status = muted); orders
  are tinted green for buys and amber for sells.
- **REALISED P/L** is green when ahead and red when behind.
- The summary strip's scrolling panels gained a right gutter so the P/L badge
  and the Laya regime labels clear the scrollbar.
- The summary strip aggregates the strategy bots and excludes only the paper
  control arm, so a paper-first install still shows equity.
- `config.example.json` ships the strategy bots as `paper: true` (a fresh
  install is paper). The runtime default for an absent field is unchanged, and
  the live config is not touched.
- `modelConfig` is no longer in the public `api/state` payload; the settings
  dialog reads its redacted selection from the authenticated `api/settings`.

### Verification

- 199 Node tests pass (`npm test`), up from 196: the server auth test now covers
  the public/protected split, and new tests cover Jev ledger recording, cap
  restore, and per-bot `paper` validation.
- Playwright is not installed, so the login flow and the visual result are
  verified with `npm run demo` in a browser.

---

## [2.10.0] - 2026-10-01 - Look and feel: beebots.tech styling and light/dark themes

The layout is unchanged. The dashboard now wears the visual language of the
upstream project - per-bee identity colour with glow, a layered background, and
movement - and ships a **Light** and **Dark** theme.

### Added

- **Light/Dark theme.** A toggle beside the gear flips the theme; the choice is
  remembered in `localStorage`, and a first visit follows the OS preference.
  `public/theme.js` runs before first paint (external, so the strict CSP is
  unchanged) to avoid a flash of the wrong theme.
- **Identity and energy** (colour, type and motion only): a layered radial page
  glow; a 3px accent top edge and a tinted head per bot card; a glowing portrait
  ring; big, tight, tabular equity figures; hover lift and glow on cards, panels
  and controls; a pulsing live badge and a glowing connection light.
- **Movement:** new decision-stream rows slide in once, and a bot card flashes
  green or red for a moment when its equity moves. Everything is disabled under
  `prefers-reduced-motion`.

### Changed

- `public/style.css` is now tokens-first: one dark `:root` and one
  `:root[data-theme="light"]` block hold every colour. The duplicate token block
  was removed and every hard-coded colour replaced with a token. No layout
  property changed.
- Bot accents and the portfolio chart now use the `--bee-<id>` tokens (and their
  glows) instead of hex literals, so they follow the theme. The control portrait
  is transparent-backed so it renders on either theme.
- `public/theme.js` is served by a new static route in `src/server.mjs`.

### Verification

- 196 Node tests pass (`npm test`); no server behaviour changed beyond the
  static route. `npm run demo` serves the theme toggle, `theme.js` and the light
  tokens correctly.
- Playwright is not installed, so the visual result is verified in a browser:
  `npm run demo`, then open the printed URL and try the toggle at desktop,
  tablet and phone widths.

---

## [2.9.0] - 2026-10-01 - Decision-engine selection: Jev, Laya, LLM and hybrids

The original [beebots](https://github.com/imikerussell/beebots) runs every
decision on **Jev**, TypeSafe AI's System One model. This port had replaced it
with Laya analysis plus a provider-backed LLM. Jev is selectable again, and the
component that decides is now a setting.

### Added

- **Decision-engine selection** in the dashboard gear dialog: `Jev`, `Laya`,
  `LLM`, `Jev + LLM`, `Laya + LLM`.
  - `Jev` and `Laya` make the entry decision directly, from one System One
    `choice` over the valid moves plus a `score` for conviction - the original
    beebots contract. Plain code still gates every order.
  - `LLM` is the previous Laya-disabled behaviour: the provider model decides.
  - `Jev + LLM` supplies Jev's proposed move to the LLM as evidence and the LLM
    decides; a Jev failure is not fatal. `Laya + LLM` is the long-standing
    default (Laya's per-candidate classification is the evidence).
- **`src/jev.mjs`**: a dependency-free Jev client over
  `POST https://api.typesafe.ai/v1/systemone` (`state` + `questions` ->
  `choice`/`score`), with a daily USD cap, exponential backoff on 429/529/5xx,
  and fail-closed behaviour: a Jev outage holds the bot and opens nothing.
- **`src/engines.mjs`**: the engine catalogue and the move-menu builder - one
  source of truth for the runtime, the settings file and the dashboard.
- A separate **Jev API key and model** in the dashboard, stored in the 0600
  settings file beside the provider key and masked the same way. The Jev fields
  are shown only when the selected engine actually uses Jev.

### Changed

- The System One menu is built from the current candidates and holdings: one BUY
  per fresh product below the position limit, SELL/HOLD per held product, and
  always SKIP. An off-menu answer is refused rather than guessed at.
- `src/model.mjs` accepts an optional `evidence` argument and includes it in the
  request as `systemOne` when a hybrid engine supplies it.
- Config gains optional `engine` and `jev` (`model`, `timeoutMs`, `dailyUsdCap`,
  `usdPerMTok`) blocks. The dashboard selection overrides the config default; an
  install that sets neither keeps the pre-2.9 behaviour (Laya + LLM, or LLM when
  `layaEnabled` is false).

### Verification

- 196 Node tests pass (`npm test`), up from 171. New `test/jev.test.mjs`
  (choice/conviction, fail-closed, cap, backoff, probe), `test/engines.test.mjs`
  (catalogue, menu, move parsing), `test/engine-selection.test.mjs` (dispatch
  for Laya-only, Jev-only, Jev + LLM and evidence), and engine/Jev persistence
  and masking in `test/settings.test.mjs`.
- No test contacts a provider or an exchange. With no Jev key, Jev is covered by
  a fake client only; the live `/v1/systemone` call is not exercised here.

### Attribution

- The README now introduces the project and links the upstream
  [imikerussell/beebots](https://github.com/imikerussell/beebots), TypeSafe's
  [System One models / Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
  and [Laya](https://huggingface.co/blog/sora-2/laya-ai-model-how-it-works-run-it-locally-and-eval).

---

## [2.8.0] - 2026-10-01 - Trade Review: Laya is a subject, and the gate is relaxed

The Trade Review now assesses **Laya itself**, not only the bots, and can
actually change what Laya is asked — which is what the brief called for.

### Added

- **Laya performance in every review.** The review gathers Laya's label
  distribution for the window, and joins each closed trade's outcome to the
  Laya analysis that preceded its entry — win rate and P&L per `fit` bucket and
  per `regime`. The join is approximate (most recent analysis for the product
  before the entry) and is labelled as such on the card.
- A fifth review head, **`laya_value`** (`helpful`/`neutral`/`misleading`/
  `insufficient`); **`failing_rubric` gains a `laya` criterion** so Laya can be
  named as the weak link; `exit_timing` gains an explicit **`no_exit_event`**
  option so a hold with no trigger is no longer forced into "late".
- A single **override registry** (`src/overrides.mjs`) under
  `<dataDir>/overrides/`, one file per editable target, shared by the engine
  (rubrics), the review, and Laya. Targets:
  - `laya.reviewQuestions` — the heads Laya answers during the review.
  - `laya.analysisQuestions` — the `regime`/`fit`/`quality` questions Laya
    answers during trading analysis (now actually consumed by `laya.analyze`).
  - `rubric.breakout|trend|momentum` — the bot rubrics.
  - `laya.fields` is **removed**: the checkpoint field contract is code.

### Changed

- **Full replacement text, validated before writing.** The review prompt requires
  `proposed` to be the complete document and `current` the exact text replaced.
  `apply()` refuses anything that is not: a rubric must have a heading, a real
  length, and all five safety clauses; a Laya question set must parse as JSON
  with the expected heads and answer types. A fragment can no longer overwrite a
  rubric — this was a real hole, since the old gate only regex-checked five
  phrases.
- **Relaxed, tiered gate.** `review.minSample` default **10** (was 50), counted
  **per target arm** rather than as the minimum across every arm — the control no
  longer pins it. Structural changes (`laya.reviewQuestions`) are **ungated**;
  edge changes (`rubric.*`, `laya.analysisQuestions`) need the arm's sample plus a
  control baseline of the same size. `review.minSample` and `review.autoApply` are
  configurable.
- **The card no longer truncates proposals.** It shows the full
  `current → proposed` in an expandable block, the target tier, the gate reasons,
  and a Laya performance table.
- The review prompt now asks for a Laya assessment explicitly and lists every
  target's current text so the model rewrites rather than describes.

### Verification

- 171 Node tests pass (`npm test`), up from 168. `test/review.test.mjs` rewritten:
  target scope, fragment/JSON validation, structural-vs-edge gating, the control
  pinning only edge changes, the fit→outcome join, the hour-state Laya section,
  override apply/revert/consume. `test/laya-optional.test.mjs` adds analysis
  question overrides and corrupt-override fallback.
- No test contacts a provider or an exchange.

### Deploy

Copy the source, `systemctl restart beebots`. Applied overrides live under
`/var/lib/beebots/overrides/` (writable inside the sandbox). To review them:
`ls /var/lib/beebots/overrides/`. New config knobs are optional.

### Rollback

```sh
cp -a _backups/2.8.0_20261001-073530/. .
rm -rf /var/lib/beebots/overrides
systemctl restart beebots
```

Remove applied overrides as well; they are not part of the backup.

---

## [2.7.0] - 2026-10-01 - Shareable: Coinbase key options, optional Laya, scrub

Preparing the project to be published and run by someone else.

### Added

- **Three ways to supply the Coinbase credential**, resolved in this order:
  1. `COINBASE_KEY_NAME` + `COINBASE_KEY_SECRET` environment variables
     (recommended — nothing secret on disk),
  2. `coinbaseApiKeyName` + `coinbaseApiKeySecret` in `config.json`,
  3. `coinbaseKeyFile` pointing at the CDP JSON key download (`{name, privateKey}`).

  The environment always wins: the Node side never overwrites an environment
  variable with config, so a secret can stay entirely out of `config.json`.
  `coinbase_bridge.py` reads the pair first and falls back to the file. Config
  validation requires at least one usable source and rejects a half-entered pair
  or a relative key-file path.

- **`layaEnabled` (default true).** Laya was effectively mandatory: the strategy
  loop called `laya.analyze` with no per-candidate guard, so without the socket
  every bot cycle aborted — a blocker for anyone without the daemon. Now:
  - `"layaEnabled": false` skips classification entirely; the model decides on
    the price/volume metrics alone, and `health.laya` reports `disabled`.
  - With Laya enabled, a failed classification **degrades that candidate** rather
    than aborting the bot: the candidate is still reviewed, without analysis.

- **`README.md` getting started** — prerequisites (Node 24+, the Python Coinbase
  SDK, a key, an OpenAI-compatible model provider), the three credential paths,
  the steps to generate the password hash and run in observe mode, and a
  prominent **real-money risk warning**.

### Changed

- **Published-tree hygiene.** Added `.gitignore` (config.json, `*.sqlite*`,
  `model.json`, `_backups/`, `node_modules/`, …) and scrubbed personal
  identifiers from code, docs, deploy files and tests — the deployment domain,
  the owner and host names, and the LAN Ollama address — to `example.com`,
  `admin`/`beebots`/`host` and `127.0.0.1`. Verified: zero hits for the known
  secret values (model provider keys, dashboard password hash, portfolio id) and
  zero hits for those identifiers, excluding `_backups/`.
- `CHANGELOG.md` is **sanitised** for publication; the owner authorised editing
  the historical entries for this purpose, overriding the usual
  "do not edit previous entries" rule.
- `config.example.json` uses `example.com`, an `admin` dashboard user, empty
  credential placeholders, and `layaEnabled`.

### Verification

- 168 Node tests pass (`npm test`), up from 163. New
  `test/laya-optional.test.mjs` (3) covers Laya off, Laya failing per-candidate,
  and Laya working; new config tests cover the credential-source rules and
  `layaEnabled` validation.
- The bridge still parses and the Python bridge tests are unchanged.
- No test contacts a provider or an exchange.

### Deploy

Copy the source, then `systemctl restart beebots`. **Nothing needs to change for
the current deployment**: the runtime still reads the existing `config.json`, and
the Coinbase credential keeps working from `coinbaseKeyFile`. The new credential
options are for new installs, not a migration.

The earlier note suggesting the Coinbase key go in `/etc/beebots/model.env` was
wrong — that file holds the **decision-model** key (`BEEBOTS_MODEL_KEY`). If you
later want the Coinbase key out of the key file, add a dedicated
`EnvironmentFile=/etc/beebots/coinbase.env` (holding `COINBASE_KEY_NAME` and
`COINBASE_KEY_SECRET`) to the unit instead.

### Rollback

```sh
cp -a _backups/2.7.0_20261001-070235/. .
systemctl restart beebots
```

The scrubbed identifiers and the sanitised changelog are not restored by the
backup, by design; the backup restores the pre-scrub text.

---

## [2.6.0] - 2026-10-01 - Standard provider catalogue and Ollama Cloud

### Added

- **Twenty decision-model providers**, up from three. The dashboard's provider
  dropdown fills from the server catalogue, so every entry below appears with no
  UI change, and selecting one fetches its models. All are OpenAI-compatible
  `/chat/completions` hosts with a fixed HTTPS base URL, and all were checked to
  expose `GET /models`:

  `openai`, `openrouter`, `groq`, `together`, `fireworks`, `mistral`, `xai`,
  `google` (AI Studio / Gemini), `deepinfra`, `cerebras`, `sambanova`,
  `hyperbolic`, `nebius`, `novita`, `moonshot`, `dashscope` (Qwen), plus the
  existing `zai`, `deepseek` and `ollama` (local).

- **Ollama Cloud** as `ollama-cloud`, base `https://ollama.com/v1`, key required.
  Verified against Ollama's docs: OpenAI-compatible, `GET /v1/models` supported,
  model ids taken from the listing and needing no pull. It is subscription-based
  rather than per-token, so no per-token cost is metered.

- **Dynamic model catalogues.** These providers change their model list weekly,
  so none is baked into the source. The model dropdown is filled from each
  provider's live `GET /models`; `dynamic: true` lets a fetched id be saved
  without a built-in table. `zai` and `deepseek` keep their curated, priced
  tables.

### Fixed

- **An API key could be forwarded to the wrong provider.** `Settings.key()`
  returned the `model.env` key for _any_ provider when no dashboard selection
  existed, so selecting, say, OpenAI would have sent it the configured DeepSeek
  key. The env fallback is now bound to the provider the static config was
  written for and is returned to no other; a non-catalogue config endpoint still
  receives it. `Settings.save` likewise refuses a provider that needs a key when
  none was entered for that provider, instead of silently falling back to the
  wrong credential. Two tests assert the key never crosses providers.

### Changed

- `inferProvider()` now matches a configured base URL against every catalogue
  base URL, not just DeepSeek and Z.ai.
- The provider dropdown is sorted by label so twenty entries stay navigable.
- Unknown models on an unpriced provider report **$0.00** rather than a guessed
  rate, at the owner's direction; the token counts are still shown.

### Not included, and why

- **Anthropic** is not offered: its API is `/v1/messages`, not
  `/chat/completions`, and would need a request/response translation layer.
- **Azure OpenAI** needs a per-deployment resource name, so it cannot be a fixed
  base URL. **Perplexity** does not expose a model listing. Both are omitted
  rather than half-supported.

### Verification

- 163 Node tests pass (`npm test`), up from 157. New: the standard providers are
  present and HTTPS; cloud providers are `dynamic` and fixed-URL while `ollama`
  stays endpoint-driven; a dynamically-listed id saves on a dynamic provider but
  is still refused on a priced one; a dynamic provider lists models from its own
  `/models`; and the env key never reaches a different provider.
- `GET /api/settings` returns 20 providers, 17 dynamic, including `ollama-cloud`.
- No test contacts a provider. **Playwright cannot run here, so the dropdown
  assertions are unexecuted**; verified via the API and served markup.

### Deploy

No config change is required — providers are code. To use one, open the gear,
pick the provider, paste its key, then select a model from the fetched list and
Save. Restart picks up the new code (`src/` is cached at import).

### Rollback

```sh
cp -a _backups/2.6.0_20261001-063021/. .
systemctl restart beebots
```

A selection already saved for a provider that no longer exists in the older
catalogue would fall back per `inferProvider()`; `zai` and `deepseek` selections
are unaffected.

---

## [2.5.1] - 2026-10-01 - Fix: row-2 cards were not equal height

### Fixed

- The **Order ledger**, **Decision stream** and **Laya analysis** cards in the
  second row did not match. Two legacy rules fought the flex layout:
  `.orders { max-height: 155px }` **capped** the order ledger so it could not
  grow to the row, and `.events { height: 340px }` plus a `.panels .events {
height: 260px }` override gave the decision stream its own height. With
  `align-items: stretch` the row was set by the tallest content, leaving the
  order ledger with a large gap.

  The row now has a **viewport-relative** height and each card fills it:

  ```css
  .panels,
  .operations {
    grid-auto-rows: clamp(240px, 32vh, 440px);
  }
  .panels .orders {
    max-height: none;
  }
  .panels .events {
    height: auto;
  }
  ```

  A true `%` height is not usable here: percentage heights resolve against the
  parent's definite height, and `main` is `height: auto`, so `%` collapses to
  `auto`. `vh` is relative to the viewport and behaves as intended; `clamp` keeps
  the row usable on short and tall screens. Each card scrolls internally via the
  existing `flex: 1; min-height: 0; overflow: auto` bodies, so no card overflows
  its own border.

Both rows use the same fraction, so all six panels are uniformly sized and the
cards within each row are exactly equal height.

### Verification

- 157 Node tests still pass; no behaviour changed.
- The demo serves the new `clamp(240px, 32vh, 440px)` rule and four bot cards.
  **Playwright cannot run here (`@playwright/test` not installed), so the visual
  assertion is unexecuted** — verified by served CSS only.
- No JS changed apart from the build id; `public/app.js`, `src/demo.mjs` and
  `package.json` remain Prettier-clean, and `public/style.css` / `src/engine.mjs`
  were already non-Prettier before this change (unchanged status).

### Deploy

Copy `public/style.css` (and the build-id files if you track them), then
`systemctl restart beebots`. Restart preserves entry-pause state and positions.

### Rollback

```sh
cp -a _backups/2.5.1_20261001-060002/. .
systemctl restart beebots
```

---

## [2.5.0] - 2026-10-01 - Fix: adding a bot crashed an existing ledger; layout

### Fixed

- **Adding a configured bot to an existing ledger crashed the runtime on every
  start.** `Store` built the bot roster only when it _created_ a ledger and
  reused the persisted `bots` object verbatim otherwise, so a newly-configured
  bot was never added — and the capital check then dereferenced
  `this.read().bots["control"].capital` on `undefined`:

  ```
  TypeError: Cannot read properties of undefined (reading 'capital')
  ```

  `main.mjs` caught it, released the lock and exited 1; `Restart=on-failure`
  looped the service and lighttpd returned **503** with nothing listening. This
  is why the control arm never appeared.

  `Store.migrateRoster()` now **adds** any bot named in config but absent from
  the persisted state, initialised by a shared `freshBot(id)` helper so first-run
  init and migration cannot drift. The capital check is guarded with
  `this.read().bots[id]?.capital`, so an absent bot can never be dereferenced.
  The migration is idempotent and records no audit event. Verified against a copy
  of the live ledger: `control` added, `momentum`'s BONK-USDC position preserved,
  reopen a no-op.

- **A second, contributing cause of a 503 was removed.** `PRAGMA VACUUM` is
  synchronous and blocks the Node event loop, so running it at startup stalls the
  HTTP server for the duration — the proxy times out regardless of whether it
  runs before or after `listen()`. Automatic vacuuming is gone. `Store.pruneEvents()`
  still runs hourly (a fast `DELETE`), and disk is reclaimed explicitly with
  **`npm run vacuum`** (`src/vacuum.mjs`), intended to be run with the service
  stopped. Opt in to a startup vacuum with `maintenance.vacuumOnStart: true` only
  if you accept the stall.

### Changed

- **Dashboard row order swapped** to the requested layout:
  - Row 1 — four bot cards (Scout, Keeper, Spark, **Dice**)
  - Row 2 — **Order ledger · Decision stream · Laya analysis**
  - Row 3 — **Leaderboard · Market coverage · Trade review**
- **Cards in a row are always equal height.** The rows used `align-items: start`
  (variable heights); they now use `stretch` with `height: 100%` cards, so each of
  the three cards in a row matches the tallest, and tall content scrolls inside
  its own card rather than stretching the row.
- **The summary strip is real money only.** `COMBINED EQUITY` and `REALISED P/L`
  now exclude any bot flagged `paper`, so the control arm's simulated $100 no
  longer inflates them. The paper arm still has its own card and leaderboard row;
  the strip is labelled "excludes the paper control".

### Verification

- 157 Node tests pass (`npm test`), up from 153. New roster-migration tests in
  `test/control.test.mjs`: a three-bot ledger plus a config with `control` opens
  without throwing and gains the bot; the migration is idempotent; no audit event
  is written; a capital change on an _existing_ bot still requires a funding
  migration; and a bot missing from the ledger cannot be dereferenced.
- Verified against a copy of the live three-bot ledger: `control` added with the
  correct funded shape, existing positions untouched.
- Row order and the four bot cards asserted in `test/ui.spec.mjs`. **Playwright
  still cannot run here (`@playwright/test` not installed), so the browser
  assertions are unexecuted** — verified via the demo's API and markup.

### Deploy

The control arm is optional, so this can be deployed with or without it.

1. Copy the source changes into place.
2. To enable the control arm, ensure `/etc/beebots/config.json` contains the
   `control` block (the copy at `/mnt/host/owner/tmp/beebots/config.json` has
   it) — the roster migration will add it to the existing ledger on start.
3. `systemctl restart beebots`.

### Rollback

```sh
cp -a _backups/2.5.0_20261001-054746/. .
systemctl restart beebots
```

If the control arm was added to the ledger, the rolled-back runtime (2.4.0) still
reads `positions` and tolerates the extra bot, so no ledger change is required to
roll back. Do not restore an older ledger over fills that happened after its
snapshot.

---

## [2.4.0] - 2026-10-01 - Control arm and hourly Trade Review

### Added

- **A fourth bot: the control arm (`control`, card name "Dice").** It enters at
  **random** from the union of tradable USDC markets, at the same cadence, with
  the same sizing and the same exits as the live bots, so the only difference
  between arms is entry selection. That is the null baseline "improved
  profitability" is measured against. Randomness is deliberate and uses
  `crypto.randomInt`: any selection rule would reintroduce the entry skill the
  control exists to remove.
- **Paper execution.** `"paper": true` on a bot means `execute()` never calls
  `exchange.create`; it simulates an IOC fill at the touch with the real taker
  fee and books it through the **same** `reserve`/`applyOrder` ledger path a real
  fill uses. Positions, P&L, protective exits and the dashboard behave
  identically. `reconcileBalances` excludes paper arms, so simulated cash never
  demands real funds the account does not hold. Switching to real funds is
  `"paper": false` plus funding the ledger.
- **The hourly Trade Review** (`src/review.mjs`). On the wall clock at `:00` it
  gathers the previous hour — decisions, Laya labels, eligible setups and their
  rejections, and fills — as text and sends it to **Laya** as `state`. Laya
  answers four classified heads (`missed_opportunity` noul, `exit_timing` choice,
  `failing_rubric` choice, `evidence_quality` score). Those answers plus the hour
  go to the decision model, which returns at most three proposals to change the
  Laya question set or a bot's rubric. Rendered in a new **Trade Review** card.
- **`Laya.ask(state, questions)`** — a generic call. The daemon hands `state` and
  `questions` straight to the model, so free text and arbitrary heads
  (`noul`/`choice`/`score`) are supported. The existing `analyze()` uses the same
  transport.
- **`model.review(system, user)`** — a free-form completion with the same
  provider, timeout, retry and endpoint rules as a decision, returning parsed
  JSON plus usage.

### Auto-apply, and its gate

A proposal is applied only when **all** hold:

1. **Scope** — target is one of `laya.questions`, `laya.fields`, or
   `rubric.breakout|trend|momentum`. Numeric risk parameters (`stopPct`,
   `riskPct`, `tradeFraction`, `maxCostRisk`, `maxPositions`), capital, `mode`
   and code are **not reachable** by a proposal.
2. **Protected invariants** — the proposed rubric must retain every safety
   clause: no shorts, Laya is uncalibrated evidence not a decision or
   probability, code controls size and execution, do not alter stops, do not
   force trades. A proposal that drops one is rejected outright.
3. **Sample** — at least **50** closed round-trips on the thinnest arm. With
   today's ledger this refuses every proposal, which is the correct state.
4. One change at a time, each recorded as an audit `change` event.

A **10% relative expectancy improvement over the control arm** and a **24h
shadow** are the promotion bar; until the sample gate is met nothing is applied.
Applied changes live as overrides under the data directory
(`/var/lib/beebots/rubrics/*.md`, `laya-questions.json`) because the sandboxed
service cannot write to the web root. `TradeReview.revert()` restores the
bundled rubric.

### Changed

- **Dashboard relaid out.** Four bot cards across the full width; then a
  Leaderboard / Decision Stream / Laya Analysis row; then Order Ledger / Market
  Coverage / **Trade Review** at the bottom. The `.arena`/`.sidebar` split is
  gone. `#review-body` shows the hour's summary, observations, each proposal with
  its gate verdict, and the sample counts.
- `config.mjs` exports `CONTROL_ID` and `ALL_BOTS`; the control is validated
  separately (no strategy-specific keys) and is optional, so an existing config
  still validates.
- The engine loads rubric overrides at construction and folds them into
  `ruleHash`, so an applied change is attributable in every later decision.
- The control's discretionary exits use the **same** Laya + model review as the
  strategies; only its entry is random.

### Not done in this release

- The **fixture-scoring corpus** (Laya scoring candidate rubrics over a labelled
  held-out set) is specified but not built. It is the step that turns "Laya likes
  this wording" into an evidence-backed promotion, and it is gated behind the
  50-trade sample that does not exist yet. Until then auto-apply cannot fire.
- Per-arm controls. One control over the union universe tests whether entry
  selection beats random in general, not which strategy does; the card notes
  this.

### Verification

- 153 Node tests pass (`npm test`), up from 138. New
  `test/control.test.mjs` (5) and `test/review.test.mjs` (10).
- Control: a paper arm books a position with **zero** exchange calls; a real arm
  submits; the cap and duplicate rules hold; simulated cash is excluded from real
  reconciliation.
- Review: every protected clause asserted indivisible (removing any one is
  refused); numeric/code targets refused; the gate refuses below 50 and opens
  only when sample and invariants are both met; an applied override is written,
  read back, audited and reverted.
- The demo renders four bot cards and a populated Trade Review card; asserted by
  `test/ui.spec.mjs`. **Playwright still cannot run in this environment
  (`@playwright/test` not installed), so the browser assertions are
  unexecuted** — the layout is verified by markup and API inspection only.
- No test contacts a provider or an exchange.

### Deploy

1. Copy `config.json` to `/etc/beebots/config.json` — it adds the `control` bot
   (`paper: true`). `model.env` and `coinbase-key.json` are unchanged.
2. `systemctl restart beebots`. Required: `src/` is cached at import.
3. The control arm starts paper. To fund it for real, set `"paper": false` and
   fund its ledger (an explicit capital migration; the store refuses silent
   changes).

The restart preserves entry-pause state and does not liquidate open positions.
The first Trade Review runs at the next `:00`; before then the card shows
"Waiting for the first hourly review". Applied rubric changes are keyed into
`ruleHash`, so a pending change is visible in the audit trail.

### Rollback

```sh
cp -a _backups/2.4.0_20261001-052008/. .
rm -f /var/lib/beebots/rubrics/*.md /var/lib/beebots/laya-questions.json
systemctl restart beebots
```

Remove any applied overrides as well: they are not part of the backup and a
rolled-back runtime would otherwise still read them. The 2.3.0 migration
(`position` → `positions`) is idempotent and unaffected.

---

## [2.3.0] - 2026-09-30 - Multiple positions per bot; Scout loosened

### Added

- **Up to `maxPositions` concurrent positions per bot** (default 3, validated
  1-5, set per bot in `config.json`). `bot.position` (a single object) becomes
  `bot.positions` (an array). Each position keeps its **own stop and exit
  policy** and is managed independently.
- A one-time **idempotent migration** in the `Store` constructor converts a
  ledger written by an earlier runtime: `position` becomes `[position]`, every
  field including `policy` is preserved, and the scalar field is removed. It runs
  on every start and does nothing to an already-migrated row. It records no
  event, so it does not appear in the audit trail.
- **Event pruning.** `market` events carry a full snapshot per refresh and
  dominated the live ledger (**283 MB of 291 MB**). `Store.pruneEvents()` deletes
  `market` rows older than 24h, at startup and hourly; `vacuumIfLarge()` reclaims
  disk with `VACUUM` at startup once the file exceeds 50 MB. **Audit kinds are
  never pruned** — `decision`, `order`, `fill`, `veto`, `control`, `system`,
  `status`, `error` are all retained. Expected effect: 291 MB → roughly 10 MB.
- A per-position P/L line on each bot card above the chart; the pill shows the
  position count (`3 POSITIONS`), and the strategy panel shows the position
  limit.

### Changed

- **Scout's entry gates loosened.** The live coverage panel showed genuine
  breakout closes held back by four independent edges at once:

  | Gate                   | Was            | Now                  | Motivating rows                        |
  | ---------------------- | -------------- | -------------------- | -------------------------------------- |
  | `rangeAtr`             | 4              | 6                    | SHIB 5.30, FARTCOIN 4.70, USELESS 4.13 |
  | volatility contraction | `atr < median` | `atr < 1.5 × median` | SHIB, PNUT, BASECAT                    |
  | close location         | 0.75           | 0.5                  | PNUT, BASECAT, GHST                    |
  | `maxExtensionAtr`      | 0.5            | 2                    | USELESS, PNUT, NOICE                   |
  | `maxCostRisk`          | 0.2            | 0.4                  | meme spread/depth vetoes               |

  **`relativeVolume` (2×) and `riskPct` (1) are deliberately unchanged** — the
  same candidates ran 8×-43× against the volume threshold, so it was never the
  constraint. **The completed-breakout requirement is not relaxed**: a close
  below the channel high still does not trade. Only the `breakout` (Scout)
  branch is touched; the `trend` and `momentum` strategies are unchanged.

- `Store.value()` sums equity and unrealised P/L across positions and marks a bot
  unknown if _any_ held position lacks a price, rather than understating it. Each
  position also carries its own `unrealised` and `price` for the dashboard.
- The model prompt and holdings validation now describe multiple positions:
  BUY while below the limit and not already held, SELL an actually-held pair,
  HOLD only a held pair. A BUY that would exceed the limit or duplicate a held
  pair is rejected.
- `reserve` enforces the cap and rejects a duplicate pair; `applyOrder` resolves
  the matching position by product for both buys and sells; `protect` works
  positions off sequentially, one order in flight per bot as before.
- **Fixed: per-model token counts were always zero.** `recordModelCall` read
  `usage.tokens`, but `usageCounts()` reports `totalTokens`, so the dashboard's
  "Today by model" table showed `calls: 77, tokens: 0` on the live ledger. Now
  reads the correct field.

### Not changed

- **Sizing.** `riskPct`, `tradeFraction`, `executionPlan` and bot `capital` are
  untouched. Positions come out roughly $33 / $22 / $15 as cash depletes, which
  the owner confirmed is acceptable. No per-position notional cap was added.
- `performance.mjs` needed no change: it derives sale cost basis from the orders
  ledger keyed by `bot:product`, not from `bot.position`, so P/L accounting was
  already multi-position-safe.
- `activate-v2.sh` and the systemd unit are unchanged.

### Verification

- 138 Node tests pass (`npm test`), up from 118. New file
  `test/multi-position.test.mjs` (12) plus 8 Scout tests in
  `test/strategy-v2.test.mjs`.
- **Migration validated against the real live ledger** (a snapshot of
  `beebots.sqlite` taken before this release). It held two open positions:
  `trend` BONK-USDC qty 5144643 and `momentum` PUMP-USDC qty 2794, both with a
  `policy`. After migration both are preserved with their policies and
  `stopPrice` intact, `position` is gone, cash is unchanged, and a reopen is a
  no-op. Those exact shapes are embedded in the test suite.
- Capacity: a 4th entry is refused, a duplicate pair is refused, a second bot may
  hold the same pair, and settling a buy opens a position while a sell closes
  only the matching one.
- Engine candidate logic: held pairs remain in the candidate list for review and
  fresh entries stop being offered at the cap.
- Scout: the exact SHIB/FARTCOIN/USELESS/PNUT shapes are asserted eligible under
  the new defaults and ineligible under the old ones; a close below the channel
  high is still refused.
- Pruning: only stale `market` rows are removed; every audit kind survives and
  SSE replay still yields the trail.
- `config.json` changes validated with the real `loadConfig`.
- No test contacts a provider or an exchange.

### Deploy

1. Copy the updated `config.json` to `/etc/beebots/config.json` — it adds
   `maxPositions: 3` to each bot and the loosened Scout values
   (`rangeAtr` 6, `maxExtensionAtr` 2, `maxCostRisk` 0.4). `model.env` and
   `coinbase-key.json` are unchanged.
2. `systemctl restart beebots`. The restart is required: `src/` is cached at
   import. The ledger migration and the first prune run at startup.
3. The ledger row self-heals on migration; no manual edit of `beebots.sqlite` is
   needed.

The restart preserves the entry-pause state (`engine.start()` only clears
`paused` on a transition _into_ live). It does **not** liquidate the two open
positions. Note that entries were active at the time of writing, so on restart
Keeper and Spark may open up to two further positions each under their existing
rules, and Scout under its loosened rules.

### Rollback

```sh
cp -a _backups/2.3.0_20260930-130738/. .
systemctl restart beebots
```

The previous runtime reads a `positions` array as an absent single position, so
it would not manage existing positions. **Roll back only after closing open
positions, or keep the 2.3.0 runtime managing them.** Do not restore an older
ledger over fills that happened after its snapshot.

---

## [2.1.1] - 2026-09-30 - Emergency fix: legacy ledger row stopped all trading

**This release repairs a fault introduced in 2.1.0 that stopped live trading.
Deploy it before anything else in the 2.x line.**

### The fault

2.1.0 assumed the `modelUsage` state row had the shape it introduced
(`perModel`, `costNanos`, `promptTokens`). The row on the live ledger was written
by the **pre-2.1.0** engine, which set only `{day, calls, tokens}`.

Because the day guard is `if (s.modelUsage?.day !== day)`, a same-day legacy row
was never repaired. Arithmetic on the missing fields produced `NaN`
(`undefined + n`), which serialises to `null`, and this threw outright:

```
Cannot read properties of undefined (reading 'deepseek:deepseek-flash')
```

That throw happened inside the per-bot `catch`, so **every bot aborted its cycle
before recording a decision or placing an order.** The call counter appeared
frozen because `snapshot()` serialised `undefined`/`NaN` fields that the client
then coerced to `0`.

### Fixed

- **`Store.normaliseUsage(u)`** repairs a usage row in place: missing counters
  become `0`, `NaN`/`null` are coerced, a corrupt `perModel` becomes an object,
  and a non-numeric `costNanos` becomes `"0"`. Called at the top of
  `recordModelCall`, so the first cycle heals the live row permanently.
- **Usage accounting is now strictly non-fatal.** The write is wrapped in its own
  try/catch in `engine.mjs` and a failure emits a `status` event instead of
  throwing. _Telemetry must never be able to stop trading_ — putting it on the
  decision path was the architectural error in 2.1.0.
- The budget counter coerces `calls` to a number before incrementing, so a legacy
  row cannot produce `NaN` there either.
- **`snapshot()`** normalises and guards the cost string, so `NaN`, `null` and
  `undefined` can never reach the dashboard card.

### Also fixed: a retired model name was silently substituted

`/etc/beebots/config.json` named `"deepseek-v4-flash"`, a **retired alias** that
is not a catalogue id. `Settings.read()` fell through its chain and silently
substituted **`deepseek-flash`**. A bot placing real orders was therefore using a
model the operator had not selected, with no warning. A typo behaved identically.

`Settings.noteUnknownModel()` now records this and surfaces it as
`unknownModel` in `api/state`, so the dashboard displays the mismatch and names
the valid alternatives. An explicit dashboard selection still wins and suppresses the warning.

**Required config change** — one line in `/etc/beebots/config.json`:

```diff
   "model": {
     "baseUrl": "https://api.deepseek.com",
-    "name": "deepseek-v4-flash",
+    "name": "deepseek-flash",
     "apiKeyEnv": "BEEBOTS_MODEL_KEY",
```

`model.env` and `coinbase-key.json` are unchanged.

### Also fixed: version skew was reported as "connection failed"

`public/` is re-read from disk on every request, but Node caches `src/` at
import. Deploying a frontend-only change therefore leaves the browser on a newer
version than the API — and the 2.2.0 dashboard calling `api/settings/test` against
a pre-2.1.0 backend got a **404**, which it displayed as **"connection failed"
for every provider**. Verified: `probe()` against the real DeepSeek config
returns `{"ok":true,"model":"deepseek-flash"}`, so the model was never the
problem.

`api/state` now carries `build`. The dashboard compares it with the build it was
shipped with and, on mismatch, reports **"restart the service to load the
matching backend"** instead of a misleading connection error.

### Verification

- 114 Node tests pass (`npm test`), up from 101. New file
  `test/usage-migration.test.mjs` (7) plus 3 engine-level tests in
  `test/strategy-v2.test.mjs`, 3 settings tests and 1 build-id test.
- **The regression test I should have written in 2.1.0.** Every 2.1.0 test used a
  _fresh_ ledger. `test/usage-migration.test.mjs` seeds the exact legacy row
  `{day, calls, tokens}` with no `perModel` and asserts the counters advance, the
  `perModel` bucket is created, and no `null` survives the JSON round-trip. One
  test asserts the old lookup still throws, so the regression cannot return
  unnoticed.
- Two engine-level tests run the **full v2 pipeline** against a seeded legacy row
  and assert no bot error, a recorded decision and a submitted order. One forces
  `recordModelCall` to throw and asserts the decision and order still happen.
- Reproduced against the real production row outside the suite: the call that
  previously threw now yields `tokens 121200`, `promptTokens 1000`,
  `costNanos "510600"`, `perModel {deepseek:deepseek-flash}` and no `null`.
- `config.json` fix verified: `deepseek-v4-flash` now raises `unknownModel`;
  `deepseek-flash` raises none.
- No test contacts a provider or an exchange.

### Deploy

```sh
# 1. config.json: the one-line model.name fix shown above
# 2. copy the source changes into place
# 3.
systemctl restart beebots
```

The restart is required: `src/` is cached at import. It does not disturb the
entry-pause state — `engine.start()` only clears `paused` on a transition _into_
live mode, so an already-live restart preserves whatever you have set.

The ledger row self-heals on the first cycle after restart; no migration script
and no manual edit of `beebots.sqlite` is needed.

### Rollback

```sh
cp -a _backups/2.1.1_20260930-070842/. .
systemctl restart beebots
```

Note the 2.2.0 backup directory is **incomplete** — it omits `src/model.mjs`,
`src/demo.mjs`, `README.md` and `deploy/INSTALL.md`, which were edited after the
backup was taken. Rolling back to 2.1.0 requires layering the 2.1.0 backup
(`_backups/2.0.0_20260930-040011/`) for those four files as well.

---

## [2.2.0] - 2026-09-30 - Ollama support; settings moved to a gear dialog

### Fixed

- **The decision-model card no longer sits in the page.** 2.1.0 added it as a
  third panel inside `.operations`, which is a two-column grid: Market coverage
  was pushed to a second row and the layout broke. The form now lives in a native
  `<dialog>` opened from a **gear icon in the header**, next to Pause entries.
  `.operations` is restored to its original two-panel markup and CSS.
- Native `<dialog>` + `showModal()` supplies the focus trap, Esc-to-close and an
  inert backdrop, so there is no hand-rolled overlay, no focus management code,
  and no JS positioning. It also keeps working under the existing
  `script-src 'self'` CSP.

### Added

- **Ollama as a decision-model provider**, flagged `endpoint: true` (owner-supplied
  URL) and `allowNoKey: true` (no credential). Default endpoint
  `http://127.0.0.1:11434/v1`, overridable in the dialog.
- `GET`/`POST` support for an `endpoint` in the settings payload, plus
  `Settings.endpoint()` normalisation: strips a trailing slash so appending
  `/chat/completions` stays well-formed, and refuses a non-http(s) scheme or a URL
  with embedded credentials.
- **`POST /beebots/api/settings/models`** lists what a provider actually offers.
  Made server-side deliberately: the page runs under `connect-src 'self'` so it
  cannot reach `127.0.0.1` at all, and the API key must never reach the
  browser to make a listing call. Falls back to the built-in catalogue on any
  failure, so the dropdown is never empty. Hostile or malformed model names from a
  provider listing are discarded by `validModelId`.
- `providers.mjs` gains `catalogue()`, `listModels()`, `validModelId()`,
  `needsEndpoint()` and `allowsNoKey()`.
- A **Refresh models** button in the dialog, and a live "N models reported by X"
  or "…showing the built-in list" status line.
- Ollama is priced at zero — local inference has no provider bill — and is
  labelled by its own id, since a local model has no catalogue entry to describe
  it. `jsonMode` is enabled (verified accepted); no `thinking` flag is sent,
  because Ollama ignores it.

### Changed

- The dialog shows only the fields a provider uses: the endpoint row appears for
  Ollama and is hidden otherwise, and the API-key row is hidden for a keyless
  provider.
- `Settings.save` takes any well-formed model id for a provider with an
  empty catalogue (host-specific) but still requires a listed model for a
  fixed-URL provider.
- Providers, catalogue and the current selection are fetched lazily when the gear
  is first opened. `renderSettings` only touches the form while the dialog is
  open, so a background refresh cannot clobber a value being typed.
- `createServer` accepts an injectable `listModelsFn` so the demo and the test
  suite never make a real network call.

### Security notes

- **Only the local provider accepts an endpoint.** A fixed-URL provider still
  rejects one, so a catalogue provider's API key still cannot be aimed at another
  host. This is asserted in both the settings and the HTTP tests.
- **No credential is ever sent to an owner-supplied endpoint**, in either the
  listing path or the decision path. `Settings.key()` returns `null` for a keyless
  provider, and `listModels` attaches `Authorization` only for a fixed-URL
  provider. Two tests assert this directly.
- A local provider **refuses** an API key in the save payload rather than storing
  one, and switching from a keyed provider to a local one does not inherit the
  stored key.
- `assertEndpoint` gained a `local` mode: a non-local endpoint still requires
  HTTPS or localhost, while a local provider may be plaintext http on a LAN — which
  is how Ollama is deployed. Credentials embedded in any URL are refused outright.
- The typed endpoint is not written to the audit event, which is replayed to every
  connected view; the record carries provider, model and a `local` flag only.

### Known limitation, accepted by the owner

The owner explicitly chose **any URL** for the Ollama endpoint rather than a
loopback/private-range restriction. Consequence, recorded here rather than hidden:
`POST /api/settings/models` and the decision path will issue server-side requests
to whatever URL is entered. It can therefore reach services on the server's own
network. This is a deliberate owner trade-off, not an oversight; restricting it is a
one-function change in `Settings.endpoint()`. Note the endpoint is still not a
credential-exfiltration path — the API key only ever goes to fixed-URL providers.

### Verification

- 101 Node tests pass (`npm test`), up from 81. New: Ollama catalogue/costing/label
  cases, 5 model-listing cases (including the no-credential-on-typed-endpoint and
  catalogue-fallback cases), 8 settings cases (endpoint normalisation, key refusal,
  local-provider key isolation) and 4 HTTP cases (listing auth/origin, bad endpoint
  rejection, no key leakage to a typed endpoint, Ollama save).
- `listModels` verified against **both** live Ollama hosts through the runtime's
  own helper: `127.0.0.1:11434` returned 2 models and `127.0.0.1:11434`
  returned 4. Manual check, not part of the suite.
- `DecisionModel.decide` verified end to end against the live Ollama at
  `127.0.0.1:11434` using model `ornith:9b`: returned `BUY` / `BTC-USDC` with a
  structured reason, 638 prompt / 46 completion tokens, `costOf() === 0n`, and
  `probe()` reported `ornith:9b`. Manual check.
- **`127.0.0.1` did not return a decision within a 60s budget.** Its models
  respond but are slow enough that the run timed out; `deepscaler:latest` returned
  no completion in 110s and `qwen3-vl:2b` hit its token limit while still
  reasoning. The integration works; that host is simply not fast enough for the
  current 45s `modelTimeoutMs`. If you intend to use it, raise
  `modelTimeoutMs` and expect a much longer decision cycle — and note that
  `all-minilm:33m` is an embedding model, which cannot produce a decision at all.
- `test/ui.spec.mjs` asserts `#model-settings` has count 0, the dialog exists, the
  gear opens it, both dropdowns populate, the endpoint/key rows toggle correctly
  and `.operations > *` still has exactly 2 children. **Playwright could not run
  in this environment — `@playwright/test` is not installed — so these browser
  assertions are unexecuted.** The layout fix is verified by markup inspection and
  by asserting the operations row has two children, not by a rendered screenshot.
- No test in `npm test` contacts a provider or an exchange.

### Rollback

```sh
cd /var/www/example.com/beebots/releases/2.0.0
cp -a _backups/2.2.0_20260930-054535/. .
systemctl restart beebots
```

To roll back two versions, layer the older backup on top. A stored `endpoint` field
in `/var/lib/beebots/model.json` is ignored by 2.1.0 and earlier, so no migration is
needed in either direction.

---

## [2.1.0] - 2026-09-30 - Runtime-selectable decision model, with cost

### Added

- **`src/providers.mjs`** — provider and model catalogue (Z.ai, DeepSeek) with
  per-model capabilities (`thinking`, `jsonMode`, `maxTokens`) and token pricing.
  Costs are integer nano-USD (`usdPer1M * 1000`), never floats. DeepSeek carries
  off-peak and peak rate pairs selected by `isPeakUtc()`: 01:00-04:00 and
  06:00-10:00 UTC, Monday to Friday.
- **`src/settings.mjs`** — dashboard-managed provider/model/key selection,
  persisted to `/var/lib/beebots/model.json` at mode `0600` via a temp file and
  `rename`, then an explicit `chmod` so a permissive umask cannot widen it.
  Falls back to the owner's `config.json` model block and `model.env` when the
  file is absent or unreadable.
- **`GET /beebots/api/settings`**, **`POST /beebots/api/settings`** and
  **`POST /beebots/api/settings/test`** in `src/server.mjs`. The POST routes reuse
  the exact-origin and `X-Beebots-Control` guard from `api/entries`, plus the
  global Basic auth, and are capped at 1 KiB like that route.
- Daily usage now records `promptTokens`, `completionTokens`, `cachedTokens` and
  `costNanos`, with a `perModel` breakdown so switching provider does not hide
  what the previous model already spent. `src/store.mjs:emptyUsage` and
  `recordModelCall` reset all counters together at the UTC day boundary.
- The fifth summary card shows the cost and tokens beneath the call count, and
  names the active model instead of the hardcoded "DEEPSEEK CALLS TODAY". The
  per-bot caption and the market-coverage note are model-driven too.
- A collapsible **Decision model** panel in the operations row: provider select,
  dependent model select, masked key field, Save and Test connection, plus a
  per-model usage table for the day.
- Startup logs the resolved model and whether a key is present.

### Changed

- `src/model.mjs` resolves provider, model and key at **call time** rather than at
  construction, so a dashboard selection applies to the next cycle with no
  restart. It returns `provider`, `providerName` and the raw `usage` block so the
  caller can price the call.
- Request bodies are per-model. `thinking:{"type":"disabled"}` is sent only to
  models that permit it — GLM-4.7-series reason compulsively otherwise, and
  always-reasoning models such as `glm-5.3-flash` reject the field with code 1210.
  `response_format:{"type":"json_object"}` and a `max_tokens` cap are applied where
  supported. An uncatalogued model gets the plain body the runtime always sent.
- Transient failures get one retry inside the existing timeout budget. An
  overloaded backend (HTTP 5xx, Zai in-body 1305) waits 1.5s; a free-tier rate
  limit (HTTP 429 or Zai in-body 1302) waits 8s, and is not retried at all when
  the deadline cannot absorb that pause. Z.ai's overload arrives as HTTP 200 with
  an in-body `error` object, so a 2xx status alone no longer counts as success.
  Authentication and validation failures are never retried.
- `ruleHash` is now computed per decision from the **active** model
  (`Engine.currentRuleHash`) instead of once in the constructor. Previously a
  runtime model change would have left later decisions carrying the previous
  model's hash, misattributing them in the audit trail.
- `api/entries` now shares the `control()` and `jsonBody()` helpers with the new
  routes. Its behaviour is unchanged, including the 413 on an oversized body.
- `src/demo.mjs` carries a synthetic free-model fixture so the cost line and
  provider-driven labels render in the preview; settings writes are refused there.
- `README.md` documents the catalogue, key precedence and pricing caveats.
  `deploy/INSTALL.md` documents the new file, its permissions and the review
  question of whether to allow the write path at all.

### Security notes

- **The API key is never returned by any endpoint.** `Settings.redacted()` exposes
  only `hasKey` and a last-four `keyHint`. A saved key is bound to the provider it
  was entered for, so selecting a different provider never sends it elsewhere and
  never falls through to another provider's `model.env` value.
- **No free-text base URL.** Only catalogue provider/model pairs are accepted, so
  the endpoint cannot be aimed at an arbitrary host with the credential in hand.
  An extra `baseUrl` field in the payload is ignored, not honoured.
- The static `config.json` block may still carry an arbitrary base URL, so
  `model.assertEndpoint` re-applies the HTTPS-or-localhost rule from
  `config.mjs` before any credential is sent.
- The key is kept out of SQLite. `activate-v2.sh` copies the ledger wholesale and
  backup tooling sweeps the data directory; a plaintext key should not travel with
  trading history.
- A settings change writes a `control` audit event naming the provider and model
  only. The event stream is replayed to every connected view, so no key material
  may appear in it.
- `clearKey` is accepted as a legitimate end state; a selection that would leave
  no key source at all is refused instead of silently starting without one.

### Limitations

- **DeepSeek peak pricing does not encode Chinese public holidays.** Those hours
  are charged at the off-peak rate, so cost is understated on a minority of days.
  Stated in the dashboard tooltip and in the deployment notes.
- Reasoning tokens are billed as output, as the providers do. They are already
  inside `completion_tokens` and are not counted twice.
- Cost is an estimate computed from the token counts the provider reports. It is
  a budgeting figure and never enters the capital ledger.
- Switching the model changes who makes **new entry decisions** only. Protective
  exits are pure code in `src/engine.mjs` and never consult the model, so open
  positions are not abandoned — but new entries use the new model immediately.
  Pause entries, switch, then watch a few cycles before resuming.
- `activate-v2.sh` and the systemd unit are unchanged; this release keeps the same
  working directory and does not need a re-activation.

### Verification

- 81 Node tests pass (`npm test`), up from 51. New: `test/providers.test.mjs` (8)
  and `test/settings.test.mjs` (8), plus model capability/retry/usage cases and
  five settings-endpoint cases in the existing files.
- The retry backoff is asserted by elapsed time: a rate-limited retry must take
  measurably longer than an overloaded-backend retry, and must not be attempted
  at all when the deadline is shorter than the wait.
- Verified against the **live Z.ai endpoint** with the BeeBots key, end to end
  through `DecisionModel.decide`: a full-size decision returned
  `action: BUY`, `product: BTC-USDC`, 574 prompt / 67 completion / 61 cached
  tokens, `costOf() === 0n`, and `probe()` reported `glm-4.7-flash`. The
  dashboard's Test-connection path was exercised the same way. This is a manual
  check, not part of the automated suite; no test contacts a provider.
- That live run also surfaced two behaviours worth recording: Zai's free tier
  rate-limits quickly under rapid bursts (code 1302), which is why the retry
  backoff distinguishes it from an overloaded backend; and the model returns
  clean unwrapped JSON only when `response_format` is requested.
- Peak-window boundaries asserted at 00:59/01:00/03:59/04:00/06:00/09:59/10:00 UTC
  and on a weekend; peak is exactly 2× off-peak. Cached tokens are charged at the
  cache rate and never at the full input rate.
- File mode of a saved key asserted as `0600`; the plaintext key asserted absent
  from `redacted()` and from the audit event.
- A BigInt in the persisted state was caught by the JSON round-trip test and fixed:
  `costNanos` is a decimal string in SQLite and a `BigInt` only in memory.
- `npm test` was run against the real Z.ai endpoint by hand during development.
  Those live calls are not part of the automated suite; no test in `npm test`
  contacts a provider or an exchange.
- Not verified: the live dashboard rendering of the new panel. `test/ui.spec.mjs`
  asserts the card and panel contents against the synthetic demo, but Playwright
  was not executed in this environment.

### Rollback

```sh
cd /var/www/example.com/beebots/releases/2.0.0
cp -a _backups/2.0.0_20260930-040011/. .
systemctl restart beebots
```

Also remove `/var/lib/beebots/model.json` if present; the pre-2.1.0 runtime does
not read it. `src/store.mjs` and `src/engine.mjs` are byte-compatible with the
previous state row — the added usage fields are additive, and an older runtime
reading a row containing them simply ignores them.
