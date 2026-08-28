# Cost Model Redesign (T3-Code parity)

> **Naming note:** This spec was written under the project name "Conduit". The product is "Relay" in user-visible surfaces as of 2026-08-27 (commit `e9abc7c3`); the crate is still `conduit`. See `README.md` and `AI CONTEXT/RELEASE.md`.
>
> **Status:** design spec, ready for review.
> **Author:** Claude (brainstorming pass, 2026-08-08).
> **Target release:** single PR, after spec sign-off.

## 1. Motivation

The current cost dashboard is a 14-day bar chart + per-project table. Every
event row stores only `(input_tokens, output_tokens, estimated_cost_usd)`, with
the price frozen at insert time. As a result:

- We cannot show a per-model breakdown (no `model_key` is stored).
- We cannot split cache reads from uncached input or reasoning from output
  (those numbers are dropped before the row hits the DB).
- We cannot distinguish Claude Code from Codex from in-app chat in the
  rollup (no `provider`, no `source`).
- We cannot reprice history when Settings rates or default rates change.
- We cannot compute a cache-savings figure (no cache_read data) or a
  cost-quality panel (no `reported_cost_usd`, no `model_key` to count).

The T3 Code reference dashboard (image, 2026-08-08) shows all of the above.
This spec brings Conduit's cost surface to parity with that dashboard in a
single coherent change.

## 2. Goals

- **Per-model breakdown** in the dashboard, sorted by cost desc, with cost,
  share, and tokens per model.
- **Per-provider breakdown** (Claude Code vs. Codex vs. in-app chat vs. Kimi).
- **Cache + reasoning visibility**: separate cards/totals for processed
  tokens, cached input, uncached input, output, reasoning, and a
  cache-savings $ figure.
- **Cost-quality panel** showing what % of events were priced by model, by
  harness-reported USD, or left unpriced.
- **Read-time pricing** so changing a Settings override or a default rate
  reprices history retroactively.
- **Time-range selector** (7d / 30d / 90d, default 30d).
- **Parity between desktop and mobile** cost surfaces.
- **Backwards compatibility** with the existing on-disk format and the
  existing mobile client (graceful degradation, not breakage).

## 3. Non-goals

- A pricing UI for the model rates (Settings still has the existing
  per-model rate overrides; this spec does not add a "view rates" panel).
- A retroactive full-recalc on app start for users with millions of legacy
  events; the rollup is per-request, lazily priced.
- A new IPC command for chat-side cost data; the existing
  `get_cost_rollups` is extended and the existing `get_cost_events` stays.
- A pricing UI for the `settings:updated` → refresh flow; the dashboard
  refetches on every `cost:updated` event, which is what users see in
  practice (rate changes happen rarely; manual refresh is fine for v1).
- Historical cache-savings figures for events whose `cache_read_input_tokens`
  is NULL (legacy rows cannot be retroactively decomposed into
  cache vs. uncached; the cost-quality panel surfaces this as
  "rows with no cache breakdown: X").

## 4. Architecture

```
Harness pty output
   │
   ├──(pty scrape)──>  parse_usage_common ──> UsageInfo ──┐
   │                                                    │
Session log on disk                                     ▼
   │                                       record_usage(provider, source, ...)
   ├──(on-disk sync)──>  parse_session_usage ──> UsageInfo ─┐
   │                                                       │
   │                                                       ▼
   │                                            INSERT INTO cost_events
   │                                            (new columns populated)
   │                                                       │
   │                                                       ▼
   │                                            cost:updated event
   │                                                       │
   │                                                       ▼
   │                                            React dashboard
   │                                            (reads via get_cost_rollups)
   │
   └─(no insert; just config)──>  default_rates ──> price_usage(usage, model_key)
                                                          │
                                                          ▼
                                                  get_cost_rollups
                                                  (read-time pricing)
                                                          │
                                                          ▼
                                                  cost-quality %s,
                                                  cache-savings $,
                                                  per-model rollup
```

Single source of truth for pricing: `harness_adapters::pricing::price_usage`,
called by both the desktop rollup endpoint and the mobile relay.

## 5. Schema changes

### 5.1 `cost_events` (additive migration, runs on app start)

```sql
ALTER TABLE cost_events ADD COLUMN provider TEXT;
ALTER TABLE cost_events ADD COLUMN model_key TEXT;
ALTER TABLE cost_events ADD COLUMN source TEXT NOT NULL DEFAULT 'pty';
ALTER TABLE cost_events ADD COLUMN cache_creation_input_tokens INTEGER;
ALTER TABLE cost_events ADD COLUMN cache_read_input_tokens INTEGER;
ALTER TABLE cost_events ADD COLUMN reasoning_output_tokens INTEGER;
ALTER TABLE cost_events ADD COLUMN reported_cost_usd REAL;
ALTER TABLE cost_events ADD COLUMN pricing_estimated_usd REAL;
ALTER TABLE cost_events DROP COLUMN estimated_cost_usd;
```

Notes:
- `provider`: `'claude_code' | 'kimi_code' | 'opencode'` for harness rows;
  `'chat:<provider>'` for in-app chat rows; `NULL` for legacy rows.
- `model_key`: canonical key from `harness_adapters::canonical_model_key`
  (e.g. `'claude-opus-4-8'`). `NULL` for legacy rows or rows where the
  adapter did not surface a model id.
- `source`: `'pty' | 'on_disk' | 'chat_message' | 'manual'`. Provenance
  for the cost-quality %.
- Cache/reasoning columns: nullable for legacy and pty-source rows (the
  pty scraper does not parse them); populated for on-disk-source rows and
  chat rows.
- `reported_cost_usd`: what the harness itself printed (e.g. the "Total
  cost: $X" line in Claude Code's TUI). Distinct from the read-time
  `price_usage` output. Drives the "provider reported" cost-quality row.
- `pricing_estimated_usd`: the price at insert time. **Write-only** after
  this change — the rollup reads the per-row formula instead, so this
  column is just an audit trail / mobile-relay back-compat. We replace
  the old `estimated_cost_usd` column rather than keep both, to avoid
  two sources of truth.
- `DROP COLUMN` is last in the migration; if any earlier statement fails
  on an old SQLite, the old column is still present and the new code
  path is unused.

### 5.2 `chat_messages` (same shape, smaller scope)

```sql
ALTER TABLE chat_messages ADD COLUMN cache_creation_input_tokens INTEGER;
ALTER TABLE chat_messages ADD COLUMN cache_read_input_tokens INTEGER;
ALTER TABLE chat_messages ADD COLUMN reasoning_output_tokens INTEGER;
ALTER TABLE chat_messages ADD COLUMN provider TEXT;
ALTER TABLE chat_messages ADD COLUMN model_key TEXT;
ALTER TABLE chat_messages ADD COLUMN pricing_estimated_usd REAL;
```

No `reported_cost_usd` (in-app chat has no "what the harness said"
number) and no `source` (all chat rows are `source = 'chat_message'` by
definition).

### 5.3 Schema version

`db::CURRENT_SCHEMA_VERSION` bumps from 17 → 18. (Will verify the exact
current number during implementation.)

### 5.4 Backfill

- `source`: a one-time `UPDATE cost_events SET source = 'on_disk' WHERE
  session_id IN (SELECT id FROM sessions WHERE last_synced_at IS NOT
  NULL)`. Any session that was ever on-disk-synced has its events
  re-inserted with the right source on the next sync tick. Remaining
  rows (legacy, pty-only) keep the `'pty'` default.
- `provider`, `model_key`: best-effort `UPDATE … FROM sessions` for
  rows where the session has a known harness and that harness has a
  single canonical default model. Cases that fail the backfill
  (mixed-model sessions, harnesses without a default) stay NULL. The
  cost-quality panel surfaces these as "unknown model."
- `cache_creation_input_tokens`, `cache_read_input_tokens`,
  `reasoning_output_tokens`: **no backfill** — the data is gone. Legacy
  rows are NULL, which is correct.
- `reported_cost_usd`: **no backfill** — the data is gone. Legacy rows
  are NULL, which is correct.
- `pricing_estimated_usd`: filled by the `record_usage` rewrite for
  every new row; legacy rows are NULL (the read-time formula still
  works on them using NULL cache/reasoning fields and the harness's
  default model).

## 6. Adapter changes

### 6.1 `UsageInfo` v2

```rust
pub struct UsageInfo {
    pub input_tokens: Option<i64>,                  // raw input, excluding cache
    pub output_tokens: Option<i64>,                 // raw output, excluding reasoning
    pub cache_creation_input_tokens: Option<i64>,  // charged at full input rate
    pub cache_read_input_tokens: Option<i64>,      // charged at cache_read_per_mtok
    pub reasoning_output_tokens: Option<i64>,      // counted in output cost
    pub cost_usd: Option<f64>,                     // what the harness itself printed
}
```

`SessionUsage` keeps its existing `model: Option<String>` field.

### 6.2 `parse_session_usage` (Claude Code + Kimi)

Today both adapters do:
```
input += num("input_tokens") + num("cache_creation_input_tokens") + num("cache_read_input_tokens");
output += num("output_tokens");
```

After the change: track the components separately so each cost event
records them in their own columns. Same for Kimi
(`inputCacheRead`, `inputCacheCreation`). Anthropic's wire format also
surfaces a `reasoning_tokens` field on some models — extract into
`reasoning_output_tokens`.

### 6.3 Pty scraper (`parse_usage_common`)

Left conservative. The harness TUIs almost never print cache/reasoning
numbers line-by-line; they only show aggregate at session end. So pty
rows will have NULL cache/reasoning. The cache-savings numbers come
from the on-disk source, which has the full per-message data. The
cost-quality "provider reported" % is therefore ~0 for pty rows; the
"model priced" % reflects on-disk rows.

### 6.4 `record_usage` signature

```rust
fn record_usage(
    &self,
    app: &AppHandle,
    db: &SharedDb,
    usage: UsageInfo,
    model: Option<&str>,
    provider: &'static str,           // 'claude_code' | 'kimi_code' | 'opencode'
    source: &'static str,             // 'pty' | 'on_disk' | 'chat_message'
    session_id_for_record: &str,
);
```

All three call sites (pty scraper, on-disk sync, chat streaming) pass
the right `provider` and `source`. The pty scraper is conservative
(NULL cache/reasoning); on-disk sync fills the full row; chat streaming
fills chat-shaped columns.

### 6.5 Dedup

The on-disk sync today overwrites the `estimated_cost_usd` previously
computed from pty scraping. After this change, pty rows and on-disk
rows are both kept, distinguished by `source`. The dedup in
`last_usage` keys on `(input + cache_creation + cache_read, output +
reasoning, cost)`, so a pty row and an on-disk row for the same call
share a key and the on-disk row wins (because it has the cache/reasoning
data the pty row was missing).

## 7. Pricing model

### 7.1 `ModelRate` v2

```rust
pub struct ModelRate {
    pub input_per_mtok: f64,         // uncached input, USD per 1M tokens
    pub cache_read_per_mtok: f64,   // cached input read, USD per 1M tokens
    pub output_per_mtok: f64,        // output (incl. reasoning), USD per 1M tokens
}
```

`default_rates` keeps the same static map; cache rates default to
`input_per_mtok * 0.1` for Anthropic and the OpenAI-published values
(0.5×) for OpenAI. The cache rate is exact per-model, not estimated
from a formula.

### 7.2 `price_usage`

```rust
pub fn price_usage(
    usage: &UsageInfo,
    model_key: Option<&str>,
    settings_overrides: &HashMap<String, ModelRate>,
) -> Option<f64> { ... }
```

Looks up the canonical key in `default_rates` first, layers Settings
overrides on top, then computes:

```
cost = (
    (input_tokens + cache_creation_input_tokens) * input_per_mtok
  + cache_read_input_tokens * cache_read_per_mtok
  + (output_tokens + reasoning_output_tokens) * output_per_mtok
) / 1e6
```

Unknown model key returns `None`; the rollup then flags that row as
"unpriced" for the cost-quality panel.

This is `pub` from `harness_adapters::pricing` so both
`db::price_cost_events` and `mobile::relay::price_cost_event` use the
same code. Single source of truth for pricing across desktop and
mobile.

### 7.3 Read-time, not insert-time

Pricing runs at read time (when the rollup serves a request) rather
than at insert time. Reasons:

1. **Retroactive re-pricing.** Settings override change or
   `default_rates` correction re-prices the whole history.
2. **Single source of truth.** One function, one set of inputs, no
   possibility of insert-time and read-time disagreeing.
3. **Migrations are easier.** New columns only need to be present.

Trade-off: a row whose `model_key` is now-deprecated reprices as
unpriced. That's a *feature* — the cost-quality panel surfaces it, and
the user knows to fix the override.

### 7.4 `pricing_estimated_usd` (write-only)

- We stop reading it for the rollup aggregates.
- We keep writing it at insert time, for two reasons:
  1. Audit: a row in the DB always has *some* number, even if the
     rollup later decides the model is unpriced.
  2. Mobile relay back-compat (a code path we cannot ship a breaking
     change to on the same day).
- It replaces the old `estimated_cost_usd` column (one source of
  truth, not two).

### 7.5 `reported_cost_usd`

Distinct from the read-time price. The cost-quality "provider
reported" row counts events where this column is non-NULL.

### 7.6 Cache-savings formula

Exact per-row, per-model:

```
cache_savings_usd = sum(
    cache_read_input_tokens
  * (input_per_mtok - cache_read_per_mtok)
  / 1e6
)
```

Uses the same per-model rates as the price formula, so the figure
lines up with how the providers describe the discount.

## 8. `get_cost_rollups` (new shape)

```ts
interface CostRollups {
  // ---- header numbers ----
  totals: {
    rawTokenCostUsd: number;        // "RAW TOKEN COST" big number
    providerReportedUsd: number;    // sum of reported_cost_usd
    estimatedUsd: number;           // sum of priced rows
    unpricedUsd: number;            // rows we couldn't price
  };

  // ---- per-harness rollup (Claude Code vs Codex) ----
  perProvider: Array<{
    provider: string;               // 'claude_code' | 'kimi_code' | 'opencode' | 'chat:<id>'
    costUsd: number;
    tokens: number;
    sharePct: number;               // 0..100, of totals.rawTokenCostUsd
  }>;

  // ---- daily chart ----
  daily: Array<{
    day: string;                    // 'YYYY-MM-DD'
    costUsd: number;
    tokensByProvider: Record<string, number>;  // stacked for the chart
  }>;

  // ---- 5-card stats row ----
  byKind: {
    processedTokens: number;        // sum of input_tokens (non-cache)
    cachedInputTokens: number;      // cache_creation + cache_read
    uncachedInputTokens: number;    // input_tokens only
    outputTokens: number;           // output + reasoning
    reasoningTokens: number;        // subset of outputTokens
    sessions: number;
    responses: number;              // cost events with source IN ('pty','on_disk')
  };

  // ---- per-model breakdown table ----
  perModel: Array<{
    modelKey: string;               // canonical key, or 'unpriced' / 'unknown'
    displayName: string;            // raw model id when known, else the key
    costUsd: number;
    sharePct: number;
    tokens: number;
    provider: string | null;
  }>;

  // ---- cost quality (right panel) ----
  costQuality: {
    providerReportedPct: number;    // rows where reported_cost_usd IS NOT NULL
    modelPricedPct: number;         // rows priced via canonical key
    unpricedPct: number;            // rows we couldn't price
    cacheSavingsUsd: number;        // exact per-row (Section 7.6)
  };

  // ---- existing per-project rollup (kept) ----
  perProject: Array<{
    projectId: string;
    totalCostUsd: number;
    totalInputTokens: number;
    totalOutputTokens: number;
  }>;

  // ---- meta ----
  rangeStart: string;               // ISO date, for "Jul 9 to Aug 7" header
  rangeEnd: string;
  rangeDays: 7 | 30 | 90;
}
```

`get_cost_rollups(range_days?: 7 | 30 | 90) -> CostRollups`; default 30.
Every aggregate uses the same `WHERE timestamp >= strftime('%s', 'now',
'-' || ? || ' days')`.

The rollup unions `cost_events` (harness panes) with `chat_messages`
(in-app chat), so the dashboard treats both sources as one universe
(matches the T3 Code reference, which combines Claude Code, Codex, and
in-app calls).

Old field names (`perProject`, `daily`, `totalCostUsd`) are kept so any
React code that hasn't migrated yet still compiles.

## 9. IPC contract changes

### 9.1 `CONTRACT.md` updates

- `CostEvent` interface gains the new fields (matches Section 5.1).
- `CostRollups` interface is replaced with the new shape (Section 8).
  Old keys are kept as a strict subset; any consumer still using them
  works.
- `get_cost_rollups(rangeDays?: 7 | 30 | 90) -> CostRollups` (new arg,
  default 30).
- `cost:updated` event payload gains a `version: 2` field and includes
  the new `totals`, `byKind`, and `costQuality` blocks. Old mobile
  clients see the new fields, ignore the ones they don't know, and the
  `version` lets the mobile UI detect the new shape and degrade
  gracefully if needed.

### 9.2 Schema version bump

`db::CURRENT_SCHEMA_VERSION` 17 → 18. (Verify current value during
implementation.)

## 10. Mobile relay impact

### 10.1 `relay_ws.rs`

- The cost-events serializer handles the new optional fields — outputs
  them when present, omits when NULL (keeps the wire payload small for
  legacy rows).
- The "cost summary" message type gains the new `CostRollups` shape with
  a `version: 2` guard. Old mobile clients detect the new shape and
  show the existing per-project table only.
- Pricing on the mobile relay: the relay currently trusts
  `estimated_cost_usd` from the DB. After the change, that column is
  write-only. The relay calls the shared `harness_adapters::pricing::
  price_usage` (the same function the desktop uses) to compute the
  mobile-side rollup. Same source of truth, no drift.

### 10.2 `session_chat.rs`

- Mobile → desktop chat cost events populate the new `chat_messages`
  columns from the streaming response usage block.
- Mirrors what the desktop streaming code does in `chat/streaming.rs`.

### 10.3 `ChatMessageRecord` interface

- New optional fields: `cacheCreationInputTokens`,
  `cacheReadInputTokens`, `reasoningOutputTokens`, `provider`,
  `modelKey`, `pricingEstimatedUsd`.

## 11. UI design — `CostDashboard.tsx`

### 11.1 Layout

Single page, eight regions (matches the T3 Code reference):

1. **Header band** — "Usage" title, 7d / 30d / 90d toggle, range label.
2. **Raw token cost hero** — big number ($X,XXX.XX) with the date range.
3. **Per-tool breakdown** — Claude Code / Codex / Kimi / in-app chat rows
   with cost, share, and tokens.
4. **Daily cost chart** — Cost / Tokens toggle, hover tooltips with both
   values, stacked by provider.
5. **5-card stats row** — Processed tokens / Cached input / Uncached
   input / Output / Responses.
6. **Cache savings callout** — "$X,XXX" as a sixth element next to the
   stats row (T3 Code shows it as a sub-line under "Cached input"; we
   promote it to its own card for weight).
7. **Per-model breakdown table** — model, cost, share, tokens; default
   sort cost desc.
8. **Cost quality panel** — three progress bars (Provider reported /
   Model priced / Unpriced) with the cache-savings figure.

### 11.2 Component plan

- `src/components/cost-dashboard/CostDashboard.tsx` (rewrite)
- `src/components/cost-dashboard/RangeToggle.tsx`
- `src/components/cost-dashboard/CostHero.tsx`
- `src/components/cost-dashboard/DailyChart.tsx`
- `src/components/cost-dashboard/StatsRow.tsx`
- `src/components/cost-dashboard/ModelBreakdownTable.tsx`
- `src/components/cost-dashboard/CostQualityPanel.tsx`
- `src/hooks/useCostRollups.ts` (loading / error / refresh on `cost:updated`)

`LocalModelUsagePanel.tsx` is deleted — its content folds into the
per-model table.

### 11.3 Stack

- Recharts (already in `package.json`) for the chart.
- Tailwind + existing color tokens for cards.
- No new dependencies.

### 11.4 States

- **Loading:** skeleton bars in the chart, "—" in the cards,
  "Loading…" in the table.
- **Empty (no events in range):** big "—" in the hero, "No usage in
  this range" in the chart and table.
- **Error:** inline red banner above the hero with a retry button; the
  rest of the page stays.

### 11.5 Responsiveness & a11y

- 5-card row collapses to a 2-column grid on narrow screens.
- Chart has a visually-hidden fallback data table (screen-reader
  accessible).
- Single-column layout below ~900px.

## 12. Migration & rollout

### 12.1 Migration order

1. **DB migration** runs on app start. The `DROP COLUMN` is the last
   statement; if any earlier statement fails, the old column is still
   present and the new code path is unused.
2. **Adapters + `record_usage`** start writing the new columns with
   the new `source` and `provider` arguments. Old call sites fail to
   compile, which is the point — we want zero dual-write.
3. **Rollup endpoint + React UI** ship together. The new shape is a
   strict superset of the old one; the old keys stay.
4. **Mobile relay** gets the new fields and the `version: 2` guard.
   Old mobile clients ignore the new fields.

Single PR, single release.

### 12.2 Backfill

- `source` backfill runs in the migration (Section 5.4).
- `provider` / `model_key` backfill runs in the migration (Section 5.4).
- Cache/reasoning/reported: no backfill; NULL is correct.

## 13. Testing

### 13.1 Migration tests

- Fresh DB: schema is correct after migration.
- Existing DB with 1k events: row count and `input_tokens` /
  `output_tokens` preserved; legacy `estimated_cost_usd` is dropped.
- Backfill: `source` set correctly for on-disk-synced sessions;
  `model_key` set for known-harness sessions; NULL preserved for
  unknown cases.

### 13.2 Pricing tests

Table-driven, per `ModelRate` entry, per combination of input /
cache_creation / cache_read / output / reasoning tokens, verify the
formula matches a hand-computed value to 1e-9. Edge cases:

- Zero tokens.
- All-NULL cache fields.
- Missing model key.
- Settings override that sets a rate to zero.
- Cache-savings formula: `cache_read * (input - cache_read) / 1e6`,
  verified against the rate table.

### 13.3 Rollup tests

Seed a known mix of events + chat messages, run the rollup at 7d /
30d / 90d, verify every aggregate. Verify:

- Per-provider rollup sums to `totals.rawTokenCostUsd`.
- Per-model rollup sums to `totals.rawTokenCostUsd` (modulo unpriced).
- Daily chart sums to `totals.rawTokenCostUsd`.
- `costQuality.{providerReportedPct, modelPricedPct, unpricedPct}`
  add to 100.
- `byKind` aggregates are mutually consistent
  (`processedTokens + uncachedInputTokens = cachedInputTokens` if
  those are the same row's fields; the test documents the relationship).
- Per-model table is sorted by cost desc.

### 13.4 Standard checks

- `cargo check` clean.
- `cargo clippy -- -D warnings` clean.
- `cargo test` clean.
- `tsc --noEmit` clean.
- `pnpm lint` clean.
- `pnpm test` clean.
- `pnpm build` clean.

## 14. File-by-file change list

### Backend (Rust)

- `src-tauri/src/db/cost.rs` — schema bump, new column reads, rollup
  rewrite.
- `src-tauri/src/db/chat.rs` — `chat_messages` schema bump, new
  column reads.
- `src-tauri/src/db/migrations/0009_cost_events_v2.sql` (new) — the
  migration.
- `src-tauri/src/harness_adapters/mod.rs` — `pub mod pricing`.
- `src-tauri/src/harness_adapters/pricing.rs` (new) — `price_usage`,
  `ModelRate` v2.
- `src-tauri/src/harness_adapters/claude_code.rs` — `parse_session_usage`
  tracks cache/reasoning separately.
- `src-tauri/src/harness_adapters/kimi_code.rs` — same.
- `src-tauri/src/pty/mod.rs` — `record_usage` signature change.
- `src-tauri/src/chat/streaming.rs` — populate new `chat_messages`
  columns.
- `src-tauri/src/chat/commands.rs` — `get_cost_rollups(range_days?)`.
- `src-tauri/src/mobile/relay_ws.rs` — new fields, `version: 2`.
- `src-tauri/src/mobile/relay.rs` — use shared `price_usage`.
- `src-tauri/src/mobile/session_chat.rs` — populate new
  `chat_messages` columns.
- `src-tauri/src/types.rs` — `CostEvent`, `CostRollups` shape updates.
- `src-tauri/Cargo.toml` — no new deps expected.

### Frontend (TypeScript / React)

- `src/components/cost-dashboard/CostDashboard.tsx` — rewrite.
- `src/components/cost-dashboard/RangeToggle.tsx` (new).
- `src/components/cost-dashboard/CostHero.tsx` (new).
- `src/components/cost-dashboard/DailyChart.tsx` (new).
- `src/components/cost-dashboard/StatsRow.tsx` (new).
- `src/components/cost-dashboard/ModelBreakdownTable.tsx` (new).
- `src/components/cost-dashboard/CostQualityPanel.tsx` (new).
- `src/components/cost-dashboard/LocalModelUsagePanel.tsx` — deleted.
- `src/hooks/useCostRollups.ts` (new).
- `src/lib/ipc.ts` — `getCostRollups(rangeDays?)`.
- `src/types.ts` — `CostEvent`, `CostRollups` shape updates.
- `src/test/costRollups.test.ts` (new) — shape + sort invariants.
- `src/test/costDashboard.test.tsx` (new) — range toggle, loading,
  error, empty states.

### Docs

- `AI CONTEXT/CONTRACT.md` — `CostEvent`, `CostRollups`,
  `get_cost_rollups` signature, `cost:updated` event payload.
- `AI CONTEXT/BUILD_LOG.md` — new entry summarizing this change.
- `AI CONTEXT/AI_CONTEXT.md` — command count and section updates.

## 15. Resolved open calls (from the brainstorming sections)

- **Section 3 (a)** — cache rates are per-model in `default_rates`, not
  estimated.
- **Section 4 (a)** — `version: 2` on the IPC payload; old mobile
  clients degrade gracefully.
- **Section 4 (b)** — `chat_messages` are included in the rollup
  union.
- **Section 5 (a)** — cache-savings is a sixth element next to the
  stats row, not a sub-line under "Cached input."
- **Section 5 (b)** — current component split (8 files + 1 hook).
- **Section 5 (c)** — `useCostRollups` lives at
  `src/hooks/useCostRollups.ts`.
- **Section 6 (a)** — rename `estimated_cost_usd` →
  `pricing_estimated_usd`.
- **Section 6 (b)** — `cache_creation` charged at full input rate
  (Anthropic's policy; OpenAI deviation noted as a follow-up if
  needed).
- **Section 6 (c)** — skip the "view rates" UI for v1.
- **Section 7 (a)** — `DROP COLUMN estimated_cost_usd` in the same
  migration, as the last statement.
- **Section 7 (b)** — option 1 + best-effort backfill (NULL preserved
  for unknown cases; "unknown" bucket is documented in the cost-quality
  panel).
- **Section 7 (c)** — skip the `settings:updated → refresh` nicety for
  this PR; ship as a follow-up.
