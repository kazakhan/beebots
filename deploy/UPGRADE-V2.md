# Strategy v2 release

This release implements automatic USDC discovery and separate Scout, Keeper and Spark
rules. It is staged separately so the running trader's imports and Python bridge
are not overwritten mid-cycle. It does not reset the ledger or activate itself.

## Changed behaviour

- Catalogue discovery uses account-tradability metadata and deduplicates aliases.
  Exchange acceptance remains authoritative; catalogue visibility alone is not a guarantee.
- Scout selects identity-matched meme assets from sourced registry/category data,
  Coinbase descriptions, and owner-sourced speculative overrides. Unclassified assets
  are displayed for review; ticker-name guesses are not used.
- Keeper evaluates four-hour trends and hourly pullback/resumption setups.
- Spark ranks a same-hour cohort by 24h and 7d returns and checks a 15m continuation.
- No inherited absolute candle or daily turnover floors apply to v2 entries.
- Proposed initial risk is 1% of each flat bot's cash/equity, with a 90% cash cap.
  Exchange-depth, fees and exit-impact estimates can veto an order that is too costly.
- Hard/ATR/setup exits are saved with each new position. Existing v1 positions retain
  their saved original exits and original decision instructions until closed.
- Four persistent read-only SDK workers reuse HTTP sessions. A shared scheduler
  allows at most two market reads per second. Portfolio reads and protective execution
  use a separate transport. Workers cannot place/cancel orders or transfer assets.
- Catalogue, classification and candle data are cached outside the web root.
  Missing candles are repaired only from bounded trade-history queries; an empty
  verified interval is explicitly tagged and has zero volume. No volume is invented.
  Unresolved gaps, provider rate limits and inadequate warm-up remain visible.
- The dashboard shows discovered/eligible/warmed counts, Scout membership, candidate
  evidence, exclusions, model calls and token usage. It does not claim that every
  discovered product has usable history.

The 5m/1h/15m schedules apply to Scout/Keeper/Spark respectively. Existing v1 positions
retain five-minute model review. Calls are skipped without candidates and deduplicated
by bot and bar interval. The initial daily call cap is 1,000; it is separate from
protective exits. ATR uses a simple mean of 14 true ranges; it is not Wilder smoothing.

## Owner-controlled switch

After server integration verification, run on the server:

```sh
sudo sh /var/www/example.com/beebots/releases/2.0.0/deploy/activate-v2.sh
```

The script backs up the live ledger through SQLite's online backup API, copies the
current configuration for rollback, creates the v2 configuration while preserving
mode/portfolio/capital/credentials, installs a service override pointing to this
release, and restarts BeeBots. It preserves the current entry-pause state.
It does not stop or modify the separate old coinbase service.

The owner executes this step because restarting a live configuration resumes
autonomous real-money execution. Do not run the shadow validator against the live
ledger directory. Do not copy a stale shadow ledger into production.

## Verification and limits

Unit/contract tests cover discovery, category identity, signal boundaries, missing
data, depth/risk sizing, migration and preserved position exits. Browser tests cover
desktop coverage display and mobile overflow. The separate shadow scanner only reads
market data; it has no financial execution path.

Historical profitability evaluation from the research plan has not been completed.
The numerical strategy settings are experimental starting points, not proven profits.
There is no streaming trade collector in this release: paced incremental REST and
cached intervals implement the market scanner. Initial whole-universe warm-up and
gap repair can take longer than one bar; per-product readiness is shown. Trade
history may itself be incomplete or rate-limited, in which case that data is excluded.
Category-provider rate limiting can leave classification partial until a later retry.
Sourced owner overrides in `scanner.assetOverrides` provide a reviewable correction.

Do not revert to the legacy runtime while it owns v2 positions: that runtime does
not understand their exit policy. A rollback must retain v2 position management or
wait until those positions and pending orders are resolved. Never restore an old
ledger over orders/fills that happened after its snapshot.
