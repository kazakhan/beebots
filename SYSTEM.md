# BeeBots — what this system is and how it works

This is the single source of truth for the design. Read it before changing the
review, the engines, or the settings. If code and this document disagree, one of
them is a bug.

## Purpose

BeeBots is a **recursive, self-improving spot-trading system**. It runs a small
portfolio of independent strategy bots on Coinbase spot markets and improves
them every hour from their own results.

The objective is concrete and measurable: **each strategy bot must beat Dice**,
the random control arm — more wins, fewer losses, higher realised P&L. Dice
places random buys on the same products, so "beating Dice" is the bar for a bot
being better than luck.

## The cast

- **Laya** — a local, free classifier. It does analysis, can make the trading
  decision, and can run the hourly review. It never places orders itself.
- **The LLM** — an optional provider-backed model (selected in the dashboard).
  It can make the trading decision, and/or review the review. It never places
  orders itself; code controls size and execution.
- **Three strategy bots**, each with a permanently distinct strategy. Since
  3.3.8 all three share **Keeper's core** — a **1-hour uptrend context**
  (`contextClose > ema50 && ema20 > ema50`) and an orderly EMA20 pullback on the
  signal timeframe — and differ in their trigger, timeframe and universe:
  - `trend` (Keeper) — the baseline: the core plus a **resumption close** above
    the prior high and the signal EMA20, on 15m.
  - `breakout` (Scout) — the core plus a **breakout above the pre-breakout range
    on a relative-volume surge**, on 5m, over meme/speculative markets.
  - `momentum` (Spark) — the core plus **positive 24h/7d momentum, price above
    hourly EMA20 and a continuation breakout**, ranked to the top quintile.
    The three trigger/timeframe/universe combinations must always stay distinct;
    never merge them.

  The context is the **1-hour** frames, not the 4-hour. Keeper's original
  4-hour/250-bar stack needed ~41 days of history and starved every other market;
  do not reintroduce it.

- **`maxCandidates` is fixed at 100 and is not review-tunable.** It is a
  structural cap (how many candidates a bot may assess), so it is locked: not in
  the tunable keys, not in CURRENT TARGETS, pinned in `effectiveRules`/
  `effectiveRuntime`, and any proposal that sets it is refused. The owner set it;
  the loop must not change it.
- **Dice** (`control`) — the random control arm and the objective baseline.

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
2. **Review** — the _"Use the LLM for the hourly review"_ toggle
   (`review.llm`, default **on**). This affects the **hourly review only**.

   Turning the LLM off for the decision stream (engine = `laya`) **must never**
   turn off the LLM review. If the LLM review is on but unavailable or its reply
   is unusable, the review falls back to Laya's self-tune — it never fails.

## Strategy pool and rotation

Each bot runs one **strategy template** from a fixed, pre-authored pool
(`STRATEGY_POOL` in `strategy-v2.mjs`), selected by `params.<bot>.strategy`:

`trend_pullback` (Keeper), `momentum_leaders` (Spark), `momentum_rotation_fast`
(Scout), `mean_reversion`, `breakout_retest`, `volatility_compression`,
`range_mean_return`.

The defaults keep the three bots distinct: **Keeper = `trend_pullback`**,
**Spark = `momentum_leaders`** (blend of 24h + 7d momentum, top-3 leaders over
the top-100 market cap), **Scout = `momentum_rotation_fast`** (4h + 24h
momentum, top-3 leaders over the full universe). The rotation templates have no
pullback/breakout gate: they hold the top-3 leaders and **exit as soon as a coin
leaves the leader set** (which frees the slot to rotate into the new leader -
Laya still chooses). `evaluate()` dispatches on the selected template.

The Trade Review may reassign a bot to a different template, and is **required**
to do so when the bot is flagged: after **10 closed trades** without beating Dice
on realised P&L, the review replaces the losing strategy rather than nudging it.
Open positions are left to resolve; new entries use the new strategy.
`maxCandidates` is never review-tunable.

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

## Timeframe evidence (the Timeframe Lab)

A bot's signal timeframe (`timeframe`: 5m / 15m / 1h) is review-editable, but a
timeframe change is never allowed on a hunch. Before each review, code re-runs
each bot's **own strategy** (`evaluate`) over the candles already held, at every
timeframe, and simulates the bot's **own exits** (protective stop, trailing stop,
`maxHoldHours`) to produce, per arm per timeframe, the trades/wins/losses and net
return over the window. This is the Timeframe Lab (`src/timeframe-lab.mjs`).

- It is a **simulation** over closed bars (bid/ask approximated by the bar close),
  bounded by a product cap, an evaluation cap and a time budget. A capped sample
  is marked `partial`.
- The review sees the table and must cite it. A `params.<arm>` proposal that
  changes `timeframe` is **refused by code** unless the lab shows the proposed
  timeframe with a sufficient sample (>= 3 trades, not partial) and a net return
  at least the current timeframe's. The model cannot guess past this gate.
- The lab is deterministic and side-effect free: no orders, no LLM.

## The hourly review pipeline

The review runs every hour at `:00`, and once on startup for the hour that just
closed. It has **two stage**:

**Stage 1 — Laya reviews the hour.** Laya reads the previous hour as text and
answers a set of classified heads (the _review questions_). This always runs.

**Stage 2 — the LLM reviews Laya's review.** The model is handed **only Laya's
answers** (never the raw hour) plus the per-arm scoreboard, the applied-change
ledger, the current value of every editable target, and the allowed ranges. It
may change:

- a bot's **rubric** (the written strategy),
- Laya's **review questions** (what Laya is asked to judge), and
- the bots' **numeric strategy** (entry gates, risk, cadence, candidate cap,
  signal timeframe, Scout's universe categories) and the runtime knobs.

When the review toggle is off, or when the LLM stage cannot run, Stage 2 is
Laya's self-tune instead. Either way the loop keeps improving.

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
- The loop tracks each applied change against Dice and **auto-reverts** a change
  that is losing.
- Nothing applied is silent: it appears on the Trade Review card and in the
  change ledger.

## Where things live

- `src/strategy-v2.mjs` — the strategy, gates, execution plan.
- `src/engines.mjs` — the engine catalogue and the action menu.
- `src/engine.mjs` — the trading cycle, execution, protection.
- `src/review.mjs` — the two-stage hourly review.
- `src/self-tune.mjs`, `src/analysis-variants.mjs` — Laya's bounded self-tune.
- `src/model.mjs`, `src/providers.mjs` — the optional LLM calls.
- `src/overrides.mjs` — target whitelist, schemas, backup/revert.
- `public/` — the dashboard; `src/server.mjs` — API and auth.
