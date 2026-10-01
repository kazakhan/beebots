# Deployment handover — permission required

Nothing here has been executed on the server. Do not run the upstream Docker
Compose stack; that launches the original OKX/Jev application.

## Values the owner must supply

- Decision model name and OpenAI-compatible `/chat/completions` base URL, plus
  its key through `/etc/beebots/model.env` (`BEEBOTS_MODEL_KEY=...`).
- Initial USDC allocations for Scout, Keeper and Spark. Example config has zero
  allocations deliberately; these are not proposed deposits.
- A **Coinbase credential**, one of: `COINBASE_KEY_NAME` + `COINBASE_KEY_SECRET`
  in the service environment (recommended), `coinbaseApiKeyName` +
  `coinbaseApiKeySecret` in the config, or `coinbaseKeyFile` at the CDP JSON key
  path. The environment wins, so the key need not live in `config.json`.
- The explicit Coinbase portfolio UUID accessible by the reused API credential.
  This can be the existing portfolio. All three bots have independent internal
  ledgers within it; there is no requirement to create three exchange portfolios.
- Dashboard password hash (generate locally with `npm run password` and stdin).
- Confirmation of the candidate product list and proposed strategy/execution parameters.
- Whether Laya is available. Set `layaEnabled: false` to run without it; the
  decision model then uses the price/volume metrics alone.

## Layout and ownership

Copy the contents of **coinbase-app/** to `/var/www/example.com/beebots/`.
Keep upstream LICENSE alongside it. Directory/files owner `www-data:www-data`,
directories 0755 and source/assets 0644. The backend runs as a dedicated `beebots`
system user; grant supplementary `laya` group through the service unit.

Keep `/etc/beebots` and `/var/lib/beebots` outside the web root. Config/model.env
and Coinbase key: root:beebots 0640; directories 0750. The dashboard-written
`/var/lib/beebots/model.json` is beebots:beebots 0600 and holds an API key. Reuse
a tightly permissioned copy of the existing Coinbase credential (or an approved
scoped credential), not a public file and not a credential embedded in the
source. No exchange transfers.
The existing Python SDK interpreter is `/opt/coinbase/venv/bin/python`; check
traverse/read access for `beebots` before start. Do not recursively change ownership
of `/opt/coinbase` or `/opt/laya`.

## Runtime and lighttpd

Node 24+ is required (built-in SQLite); production has **no npm dependencies**.
The inspected Node executable was in Morgan's nvm home directory. Resolve an
appropriate root-managed executable and update ExecStart before installation;
ProtectHome deliberately prevents depending on a home-directory runtime.

Review `beebots.service`, provision the service user, configure the selected Node
path, and install the unit only after permission. Do not restart Laya or change
its GPU environment. Connect to `/run/laya/laya.sock` directly.

Review the lighttpd snippet with the existing vhost. Verify its syntax with
`lighttpd -tt -f /etc/lighttpd/lighttpd.conf` before an authorised reload. All
`/beebots/` routes proxy to the local backend, which checks authentication for
HTML, assets, API and events. Verify 401 without credentials on all of those.
Check that the existing site redirects HTTP to HTTPS before a password is entered.
Ensure there is no alternate vhost/alias exposing the application directory as
files. Do not serve the source directory as a static root.

## Initial start and validation

Set final initial capital allocations and portfolio before the first runtime
start: the database binds them and rejects silent changes later. Use `mode:observe`
for deployment validation. `npm run check` only validates configuration; it does
not connect to services or trade. Start the service, verify Laya ping/readiness,
real market data, model schema, authenticated streaming and account reads.
Observe mode performs analysis and records decisions but cannot submit orders.

If an observe-only database was initialized with the wrong allocations, back it
up and explicitly reset that unused ledger before launch; never delete a ledger
that owns real orders/positions. Live ledger funding changes require a reviewed
migration; they are intentionally not inferred from an edited config file.

## Real activation — a separate permission step

The owner controls pausing the existing trader. Confirm the specific USDC capital
available for BeeBots and any holdings assigned to it. Existing holdings are not
automatically adopted or sold. No old services/schedules are touched by this app.

After live activation permission, set `mode:live` and
`liveAcknowledgement:ENABLE_REAL_COINBASE_ORDERS`, verify positive allocations and
the portfolio ID, then restart this service. Live startup enables entries on the
first transition from observe. Later restarts preserve a dashboard entry pause.
Observe is NOT a live-position maintenance mode: changing a live instance to
observe prevents all submissions, including exits. Use **Pause entries** instead.

## Decision-model selection at runtime

The dashboard can change the decision provider, model and API key without a
restart. This adds one new file and one new trust path:

- `/var/lib/beebots/model.json`, mode `0600`, owner `beebots`. The service can
  only write below its `StateDirectory`, which is why this is not `/etc/beebots`.
  Treat it as a secret file: back it up separately, and do not copy it into a
  ledger snapshot or a web-served directory.
- `POST /beebots/api/settings` requires the same session as everything else plus
  an exact `Origin: https://example.com` and `X-Beebots-Control: 1`. It accepts
  only catalogue providers and their own models — there is no free-text base URL,
  so the endpoint cannot be aimed at another host. A saved key is bound to its
  provider and is never sent elsewhere or returned by any GET; only a masked
  last-four hint is exposed.
- The key never enters SQLite. The ledger is copied wholesale by
  `activate-v2.sh` and by backup tooling; a plaintext API key should not travel
  with trading history.
- An audit `control` event records each selection change with the provider and
  model name only.

Review whether you want this write path at all. If not, leave the settings file
absent: with no file present the owner's `config.json` and `model.env` apply
unchanged and the runtime behaves exactly as this release's predecessor.

**Providers.** The gear dialog offers the providers in `src/providers.mjs` —
twenty OpenAI-compatible hosts including OpenAI, OpenRouter, Groq, Together,
Mistral, xAI, Google, and **Ollama Cloud** (`https://ollama.com/v1`). Selecting a
provider fetches its model list from that provider's `GET /models` server-side;
the API key never reaches the browser. Only **Ollama (local)** takes a
owner-supplied endpoint (default `http://127.0.0.1:11434/v1`); every cloud
provider is a fixed HTTPS base URL, so a saved key can only go to the provider it
was entered for. The `model.env` key is bound to the provider named by
`config.json` and is never forwarded when you select a different provider in the
dashboard — enter that provider's key in the dialog.

The settings UI lives in a dialog behind the gear icon in the header, outside the
page layout. **Ollama** takes an owner-typed endpoint (default
`http://127.0.0.1:11434/v1`) and no credential, so it is exempt from the
HTTPS-or-localhost rule. Its models are listed by querying that endpoint
server-side; no credential is sent to it. The owner chose to allow any URL rather
than restricting it to loopback and private ranges, so the server will issue
requests to whatever is typed. That is a deliberate trade-off, not an oversight —
`Settings.endpoint()` is the single place to restrict it if you change your mind.

Switching the model changes who makes **new entry decisions**. Protective exits
are pure code in `src/engine.mjs` and are unaffected, so open positions are not
abandoned — but new entries immediately use the new model. Pause entries, switch,
watch a few cycles, then resume.

## Positions and ledger size

Each bot holds up to `maxPositions` concurrent positions (default 3, per bot).
A ledger written before 2.3.0 is migrated in place at startup: the single
`position` becomes `positions[0]` with its policy intact, and nothing is
liquidated. The migration is idempotent and runs on every start.

`market` events are pruned after 24h at startup and hourly, and the database is
vacuumed at startup once it exceeds 50 MB. Audit rows (decision, order, fill,
veto, control, system, status, error) are never pruned. Verify after the first
start:

```sh
sudo -u beebots sqlite3 /var/lib/beebots/beebots.sqlite \
  "select kind, count(*) from events group by kind;"
```

`sqlite3` may not be installed; the same is visible in the dashboard's decision
stream. A `VACUUM` on a large ledger rewrites the whole file and needs free
space roughly equal to its size — check `df` before the first restart.

## Ledger maintenance

`market` telemetry is pruned after 24h, hourly, in-process — a fast `DELETE`.
Reclaiming the file size is **not** done automatically: `VACUUM` is synchronous
and blocks the event loop, which would stall the dashboard and return 503 for the
duration. Run it deliberately, with the service stopped:

```sh
sudo systemctl stop beebots
sudo -u beebots BEEBOTS_CONFIG=/etc/beebots/config.json \
  /opt/beebots-runtime/node /var/www/example.com/beebots/releases/2.0.0/src/vacuum.mjs
sudo systemctl start beebots
```

`maintenance.vacuumOnStart: true` opts into a startup vacuum if you accept the
stall. Pruning alone stops the ledger growing; the file only shrinks on a vacuum.

## Control arm and Trade Review

The fourth bot is a **control arm** that enters at random to provide a null
baseline. It is `"paper": true` by default: fills are simulated and no exchange
order is submitted. Switching to real funds requires `"paper": false` **and**
funding its ledger — an explicit capital migration, because the store refuses
silent capital changes. It is validated separately from the strategies and is
optional; a config without `control` still validates.

An **hourly Trade Review** runs on the wall clock at `:00`, using the decision
model and Laya. Applied changes are written as overrides under the state
directory — `/var/lib/beebots/rubrics/*.md` and
`/var/lib/beebots/laya-questions.json` — because the sandboxed service can only
write below `ReadWritePaths=/var/lib/beebots`. Do **not** expect rubric changes
in the web root; the bundled `strategies/v2/*.md` are the fallback.

Auto-apply is gated: prose targets only, protected safety clauses retained, and
at least 50 closed trades on the thinnest arm. Review each applied change from
the `change` events and the Trade Review card. `TradeReview.revert()` restores
the bundled rubric; deleting the override files does the same by hand.

Review budget: the review is one model call per hour (24/day) against
`model.maxCallsPerDay` (currently 1000). The control arm runs in the same loop
and adds model calls for its exits when holding.

## Operations and limits

- Dashboard Pause entries stops new buys while protective exits continue.
- Protective exits run in the backend independently of the decision model/Laya.
  They are market orders, not exchange-hosted stops. Backend/server/network downtime
  can delay them; do not stop the service assuming stops remain on the exchange.
- IOC partial fills are booked incrementally. Uncertain submissions remain
  reserved and are searched by their existing client ID; they are never resubmitted.
  An unresolved order requires investigation, not deleting the database or lock.
- Amounts use 18-decimal fixed-point arithmetic. Indicators and UI use floats.
- Sub-minimum residual holdings remain owned and visible, with an error requiring
  owner review; they are not silently written off or assigned to another bot.
- One position per bot. Three bots may own separate portions of the same asset.
- The configured universe is explicit (BTC/ETH/SOL examples). It does not claim
  to scan all Coinbase assets. Expand the list with request/load testing.
- Each bot analyses at most three liquid candidates per cycle, ranked first by
  its numerical setup proximity and then by Laya fit. Near-misses are analysed
  and displayed too, but cannot bypass the exact entry requirements.
- No leverage, shorting, exchange transfers, forced activity or upstream Hive upload.
  The private leaderboard is based on actual bot-ledger equity after fees.
- Default numerical strategy parameters are reviewable proposals, not backtested
  claims. Period turnover means the completed **15-minute** signal candle; 24h
  turnover is a separate admission threshold. This app never imports old settings.
- Laya queueing, warm inference and actual SDK/version compatibility must be checked
  on the server after deployment permission. Local fixtures do not prove them.
- The decision-model cost is an estimate. DeepSeek peak-hour pricing assumes no
  Chinese public holidays, so those hours bill at the off-peak rate and understate
  cost. Free Zai models report zero. An uncatalogued model shows tokens without a
  cost rather than a fabricated one.
- Back up SQLite via its online backup API or with the service stopped. Copying only
  the DB file while WAL is live can lose recent transactions. Keep encrypted backups
  outside the host and protect model.env/key files separately.

## Rollback

Pause entries, reconcile pending orders and choose how to manage/close this app's
positions before stopping it. Roll back the app and lighttpd route from backups;
never replace a live ledger with a stale copy to roll back code. The owner decides
whether/when the old trader resumes. No automatic liquidation or resume occurs.
