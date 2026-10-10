# BeeBots — what this system is and how it works

This is the single source of truth for the design. Read it before changing the
review, the engines, or the settings. If code and this document disagree, one of
them is a bug.

## Purpose

BeeBots is a **recursive, self-improving spot-trading system**. It runs a small
portfolio of independent strategy bots on Coinbase spot markets and improves
them every hour from their own results.

The objective is concrete and measurable: **increase each strategy bot's
realised P&L (equity)** — more wins, fewer losses, higher profit. Dice is a
random control arm kept as a reference only; the review is **not** asked to
compare against it or to "beat" it.

## The cast

- **Laya** — a local, free classifier. It does analysis, can make the trading
  decision, and can run the hourly review. It never places orders itself.
- **The LLM** — an optional provider-backed model (selected in the dashboard).
  It can make the trading decision, and/or review the review. It never places
  orders itself; code controls size and execution.
- **Three strategy bots**, each running one **pinned strategy template** (3.8.0).
  The template is fixed by the owner; the review may only tune numeric params:
  - `trend` (Keeper) — **Orakelia**: the strongest 7-day momentum coins (top-100
    liquid), bought only while price **and** volume are rising; **code exit** when
    momentum fades or volume drops, then the coin is **paused** for
    `pauseHours` (4) before it can be re-bought. The trailing stop is kept.
  - `momentum` (Spark) — **ConnorsThorp**: a structural pullback in a 1h uptrend
    with **RSI(14) oversold**; **code exit** when RSI returns to neutral or the
    trailing stop. Sized by **Half-Kelly** (win rate x payoff 1.5), capped at 5%
    account risk and 1/maxPositions of cash.
  - `breakout` (Scout) — **Breakout (liquid)**: a completed close above the
    24-bar range high on a relative-volume surge, within an uptrend context.
  - `hexchaser`, `market_mover`, `trend_pullback` remain selectable in the pool
    but are not assigned. The bots differ in what they buy and in their code
    exits; all share the percentage stop / trailing / time stop.

- **`maxCandidates` is fixed at 100 and is not review-tunable.** It is a
  structural cap (how many candidates a bot may assess), so it is locked: not in
  the tunable keys, not in CURRENT TARGETS, pinned in `effectiveRules`/
  `effectiveRuntime`, and any proposal that sets it is refused. The owner set it;
  the loop must not change it.
- **Dice** (`control`) — the random control arm, kept as a reference.

## Out of the box

With **only Laya** (no LLM configured), the system is fully functional:

1. Laya analyses each candidate.
2. Laya makes the decision (BUY / SELL / HOLD / SKIP).
3. Laya runs the hourly review via its own bounded **self-tune** (it selects a
   pre-authored analysis variant and steps one whitelisted numeric parameter by
   one bounded step).

No provider API key is required.

## The two switches

There are exactly two independent places the LLM can be used. They are separate
and must never be coupled:

1. **Decision stream** — the _engine_ selection in the dashboard
   (`jev`, `laya`, `llm`, `jev+llm`, `laya+llm`). `laya` means Laya decides and
   the LLM is not used for trades. This switch affects **trades only**.
2. **Review** — the _"Use the LLM for the review"_ toggle
   (`review.llm`, default **on**). This affects the **4-hourly apply only**; the
   hourly pass is always Laya-only data collection.

   Turning the LLM off for the decision stream (engine = `laya`) **must never**
   turn off the LLM review. If the LLM review is on but unavailable or its reply
   is unusable, the review falls back to Laya's self-tune — it never fails.

## Strategy pool and rotation

Each bot runs one **pinned strategy template** from a **dynamic pool**
(`getTemplates()` in `strategy-v2.mjs`). A template is a **coded rule + universe +
timeframe**; the pool holds `orakelia`, `connors_thorp`, `breakout_liquid`,
`hexchaser`, `market_mover` and `trend_pullback`. The three bots are **pinned**
(3.8.0) to `orakelia` (Keeper), `connors_thorp` (Spark) and `breakout_liquid`
(Scout); `strategyPinned` refuses any proposal that changes a pinned bot's
strategy, and `effectiveRules` enforces the pin. The review may still tune a
pinned bot's numeric params. The liquid templates scan the **top-100** market-cap
universe. `evaluate()` dispatches on the template's rule; the collector applies
its universe (`all`/`top100`/`top20`) and its ranking.

**Shared exits plus code rules (3.8.0).** Every bot - and Dice - exits on the
**percentage protective stop** (`stopPct`), the **trailing stop**
(`trailActivationPct`/`trailPct`) or `maxHoldHours`. On top of those, the pinned
templates have deterministic **code exits**: Orakelia exits on a momentum fade or
a volume drop and then **pauses** that coin; ConnorsThorp exits when RSI returns
to neutral. These are code, never the decider: the deciser is **never offered a
discretionary SELL** for any strategy - HOLD only. `executionPlan` sizes against
`stopPct` (size = `riskPct / stopPct`); ConnorsThorp uses **Half-Kelly** risk,
capped at 5% of the account.

The review's auto-apply can be turned **off** (advisory only): it then shows
proposals but changes nothing. The 4-hourly pass is the only one that applies.

**Losing-streak trigger.** When a bot closes **5 trades in a row at a loss**, the
engine immediately runs a **focused review of just that bot** (once per streak -
re-armed when the streak breaks). That review may only change the streaking bot
(the gate refuses proposals for other bots); it can adjust the bot's numeric
params.

## Recent-close context (no cooldown)

When Laya decides, each candidate that the bot closed recently carries a
`lastClose` (`minsAgo`, `pnlPct`, `win`, `why`) and the BUY option in the menu
says so (e.g. _"closed 38m ago at -0.8%, protective stop"_), with a fixed
guidance rule: prefer SKIP over BUY unless the new setup is clearly stronger —
a stop-out on the same pullback usually whipsaws. **Only the window is tunable**
(`runtime.reentryLookbackBars`, default 24, measured in each bot's own signal
timeframe). There is deliberately **no hard cooldown** — the engine gives Laya
the information and lets it choose. The review receives a per-arm re-entry
summary so the window can be tuned with data.

## Batch analysis

The Laya daemon supports a batched request (`{"batch":[…]}`) and advertises
`batch_ready`. The engine sends batches of at most 32 per bot cycle (chunking
larger sets, since the daemon caps one request at 32) and maps the answers back.
Only entry-eligible and held candidates are quoted live; non-eligible ones are
analysed but never offered a BUY. If a chunk fails it is retried once and then
falls back to serial calls **for that chunk only**. The analysis set may be up to
100, but the **decision prompt is bounded** (`decisionSubset`, 32 candidates:
held + eligible + top-ranked) because Laya's model context is 8192 tokens - a
100-candidate state is ~13k tokens and overruns it. The Laya socket timeout has a
60 s floor so a slow GPU cannot cascade into a serial fallback.

## Control baseline (Dice)

Dice is a random control, but only over a **credible universe**: when a top-100
market-cap list is cached (CoinGecko, daily), the control draws only from those
products. This keeps the baseline meaningful instead of a pick over the long
tail.

## Laya analysis (always runs when Laya is in the engine)

Whenever Laya is part of the decision engine (`laya` or `laya+llm`), it analyses
every entry-qualifying candidate and records the classification. That analysis
is fed into the decision — Laya's own decision when Laya decides, the LLM's when
the LLM decides — and it feeds the review's per-arm performance. It ran from day
one and must **never** be keyed to the LLM engine id: the engine gate for it is
"does this engine use Laya", not "is the engine `laya+llm`". An engine with no
Laya (`llm`, `jev`, `jev+llm`) does not run it.

## The signal timeframe is fixed

A bot's signal timeframe is set by its **template** and is **locked** (3.7.0):
it is out of the tunable key list and `validateOverride` refuses any proposal
that sets it. There is no Timeframe Lab any more - the simulation that used to
gate timeframe changes is gone.

## The review pipeline (two cadences)

The review runs on two schedules. **Hourly** at wall-clock `:00` it is a
**data-collection pass**: Laya reviews the hour (Stage 1) and the record is
stored in `hourlyReviews` (rolling, 48). **No LLM runs and no change is made.**
**Every 4 hours at local 00/04/08/12/16/20** (and once on startup if it has been
>4 h) the **apply** pass runs: the LLM sees the hourly records collected since
the last apply as well as Laya's current read, and this is the **only** pass
that applies changes.

**Stage 1 — Laya reviews the hour.** Laya reads the hour as text and answers a
set of classified heads (the _review questions_). This always runs.

**Stage 2 — the LLM reviews the window.** The model is handed **only Laya's
answers** (never the raw hour) plus the per-arm scoreboard, the applied-change
ledger, the current value of every editable target, and the allowed ranges. It
may change:

- a bot's **rubric** (the written strategy),
- Laya's **review questions** (what Laya is asked to judge),
- the bots' **numeric strategy** (entry gates, risk, cadence, Scout's universe
  categories) and the runtime knobs, and
- the **strategy pool** (`strategyPool`): delete a losing template, or add a new
  template by combining a coded rule with a universe and timeframe. The
  **bot's** timeframe is fixed and cannot be changed.

When the review toggle is off, or when the LLM stage cannot run, Stage 2 is
Laya's self-tune instead. Either way the loop keeps improving.

A **focused** review is still triggered immediately when a bot loses 5 in a row;
it runs Stage 2 at once for that bot only and does not move the apply anchor.

### Output budget (do not break this)

The LLM's reply must fit the model's output cap (for `deepseek-flash`: 8192
tokens). A proposal therefore carries only `proposed`; the server fills
`current` from the target file for display. Do **not** add `current` back to the
requested output: echoing a full 4 KB question set back and forth is exactly what
truncated the reply before. Proposals (one per hour by default), observations,
and the summary are capped for the same reason. The prompt also sends each
current target as a **compact** JSON string (no pretty-printing) — keep it small.

### Failure behaviour (do not break this)

- The dashboard **always renders Laya's stage-1 review** when Laya answered.
- If the LLM stage fails, the last successful review stays on the card and the
  failure is recorded as `lastReviewError` and shown as a note. It is **never**
  replaced by a self-tune line.
- Laya's self-tune runs only when the review LLM toggle is **off**. It is not a
  substitute for a failed LLM review.

## Safety invariants (never proposed away)

Every rubric must retain these, or the proposal is refused:

- no shorts;
- Laya is **uncalibrated evidence**, not a decision and not a probability;
- **code** controls position size and execution;
- stops are never altered or disabled;
- trades are never forced;
- capital, mode, and leverage are never changeable.

## Invariants of the change itself

- Every applied change is written as an **override** under the data directory,
  backed up first, so it can be rolled back.
- Applied changes are gated: numeric/edge changes need a minimum closed-trade
  sample and can require a matured control baseline.
- The loop tracks each applied change on its **own** realised P&L and
  **auto-reverts** a change that is losing money.
- Nothing applied is silent: it appears on the Trade Review card and in the
  change ledger.

## Where things live

- `src/strategy-v2.mjs` — the strategy, gates, execution plan.
- `src/engines.mjs` — the engine catalogue and the action menu.
- `src/engine.mjs` — the trading cycle, execution, protection.
- `src/review.mjs` — the two-stage review (hourly data, 4-hourly apply).
- `src/self-tune.mjs`, `src/analysis-variants.mjs` — Laya's bounded self-tune.
- `src/model.mjs`, `src/providers.mjs` — the optional LLM calls.
- `src/overrides.mjs` — target whitelist, schemas, backup/revert.
- `public/` — the dashboard; `src/server.mjs` — API and auth.
