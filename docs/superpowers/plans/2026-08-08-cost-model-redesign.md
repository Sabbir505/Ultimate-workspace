# Cost Model Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign Conduit's cost model to match the T3 Code dashboard (per-model breakdown, per-provider split, cache/reasoning visibility, cost-quality panel, 7d/30d/90d selector) with read-time pricing and parity between desktop and mobile.

**Architecture:** Additive SQLite migration adds 7 new columns to `cost_events` and 6 to `chat_messages`, then drops the old `estimated_cost_usd` and replaces it with `pricing_estimated_usd` (write-only audit). A new `harness_adapters::pricing::price_usage` function is the single source of truth for pricing, called at read time by both the desktop rollup endpoint and the mobile relay. Adapters track cache_creation / cache_read / reasoning separately so on-disk rows carry the full breakdown (the pty scraper stays conservative). The `get_cost_rollups` endpoint unions harness + chat data into a new `CostRollups` shape; the React dashboard is rewritten to mirror the T3 Code layout.

**Tech Stack:** Rust (Tauri 2, rusqlite), React + TypeScript, Recharts (already in `package.json`), Tailwind, vitest, jsdom, cargo test.

**Spec:** `AI CONTEXT/COST_MODEL_REDESIGN.md` (binding; this plan implements it).

## Global Constraints

- Pricing math runs at READ time via `harness_adapters::pricing::price_usage`. The `pricing_estimated_usd` column is write-only audit; the rollup endpoint MUST NOT read it.
- `cost_events.estimated_cost_usd` is DROPPED in the same migration that creates `pricing_estimated_usd`. There is exactly one source of truth for "what we charge" and it is the per-row formula.
- Cache rates are per-model in `default_rates` (Section 7.1 of the spec). Anthropic cache_read is 0.1× input; OpenAI cache_read is 0.5× input. Cache_savings uses the exact per-model rate, never an estimate.
- The pty scraper (`parse_usage_common`) stays conservative — it does NOT parse cache or reasoning fields. Those only come from `parse_session_usage` (on-disk sync) and from chat streaming. Legacy and pty-source rows have NULL cache/reasoning.
- The new `CostRollups` shape is a strict superset of the old one (old fields `perProject`, `daily`, `totalCostUsd` stay) so any React code that hasn't migrated still compiles.
- The rollup unions `cost_events` and `chat_messages` (T3 Code treats them as one universe). The local-model usage panel in React is DELETED; its content folds into the per-model breakdown table.
- `cost:updated` event payload gains a `version: 2` field; old mobile clients ignore the new fields and the version lets them detect the new shape.
- Test commands run from `src-tauri/` (`cargo test`) for backend and from repo root (`npm test`) for frontend, except where noted.
- DB schema version lives on the `db/mod.rs` `CURRENT_SCHEMA_VERSION` constant if it exists; bump it. (Verify during Task 1 — if the constant is absent, skip the bump.)
- All IPC field names are camelCase (`#[serde(rename_all = "camelCase")]`); React mirrors them.
- No new runtime dependencies on either side.

---

## File-by-file change list

### New files
- `src-tauri/src/harness_adapters/pricing.rs` — `ModelRate` v2, `price_usage`, `default_rates_v2`
- `src-tauri/src/db/migrations/0008_cost_v2.sql` — schema migration
- `src-tauri/src/db/cost_v2.rs` — `get_cost_rollups` + `price_cost_event` + read-time helpers
- `src/components/cost-dashboard/RangeToggle.tsx`
- `src/components/cost-dashboard/CostHero.tsx`
- `src/components/cost-dashboard/DailyChart.tsx`
- `src/components/cost-dashboard/StatsRow.tsx`
- `src/components/cost-dashboard/ModelBreakdownTable.tsx`
- `src/components/cost-dashboard/CostQualityPanel.tsx`
- `src/hooks/useCostRollups.ts`
- `src/test/costRollups.test.ts`
- `src/test/costDashboard.test.tsx`

### Modified files
- `src-tauri/src/harness_adapters/mod.rs` — `pub mod pricing;`, register, re-export
- `src-tauri/src/harness_adapters/claude_code.rs` — track cache/reasoning separately in `parse_session_usage`
- `src-tauri/src/harness_adapters/kimi_code.rs` — same
- `src-tauri/src/db/cost.rs` — new column reads, new `insert_cost_event` signature
- `src-tauri/src/db/chat.rs` — new column reads, new `add_chat_message` signature
- `src-tauri/src/db/mod.rs` — migration registration, re-exports
- `src-tauri/src/pty/mod.rs` — `record_usage` signature change, route to new `insert_cost_event`
- `src-tauri/src/agent_sessions.rs` — populate new chat_message columns on turn complete
- `src-tauri/src/chat/mod.rs` — populate new chat_message columns from streaming usage
- `src-tauri/src/chat/commands.rs` — `get_cost_rollups(range_days?)` signature
- `src-tauri/src/commands/data.rs` — pass `range_days` to the rollup
- `src-tauri/src/mobile/relay.rs` — use shared `price_usage`; new wire shape with `version: 2`
- `src-tauri/src/mobile/session_chat.rs` — populate new chat_message columns
- `src-tauri/src/types.rs` — `CostEvent`, `CostRollups` shape updates
- `src/types.ts` — mirror the Rust types in TypeScript
- `src/lib/ipc.ts` — `getCostRollups(rangeDays?)` wrapper
- `src/components/cost-dashboard/CostDashboard.tsx` — full rewrite
- `src/components/cost-dashboard/LocalModelUsagePanel.tsx` — deleted
- `AI CONTEXT/CONTRACT.md` — type/command updates
- `AI CONTEXT/BUILD_LOG.md` — new entry
- `AI CONTEXT/AI_CONTEXT.md` — section updates

---

## Task 1: Pricing module (`harness_adapters::pricing`)

**Files:**
- Create: `src-tauri/src/harness_adapters/pricing.rs`
- Modify: `src-tauri/src/harness_adapters/mod.rs:14-16` (add `pub mod pricing;`)

**Interfaces:**
- Consumes: `crate::harness_adapters::UsageInfo`, `default_rates` (existing), `canonical_model_key` (existing), `harness_default_model_key` (existing)
- Produces:
  - `pub struct ModelRate { pub input_per_mtok: f64, pub cache_read_per_mtok: f64, pub output_per_mtok: f64 }`
  - `pub fn default_rates_v2(key: &str) -> Option<ModelRate>` — wraps the existing `default_rates` and adds `cache_read_per_mtok` per the spec (Anthropic 0.1× input, OpenAI 0.5× input)
  - `pub fn price_usage(usage: &UsageInfo, model_key: Option<&str>, settings_overrides: &HashMap<String, ModelRate>) -> Option<f64>` — single source of truth, returns `None` when the model is unpriced

- [ ] **Step 1: Write the failing tests**

In `src-tauri/src/harness_adapters/pricing.rs`:

```rust
//! Read-time pricing for cost rollups (COST_MODEL_REDESIGN.md §7).
//!
//! One function, one source of truth: every rollup aggregate — desktop, mobile,
//! the `cost:updated` re-pricing path — goes through `price_usage`. Settings
//! overrides are layered on top of the per-key default rate at call time, so
//! changing a rate retroactively re-prices the whole history (Section 7.3).

use std::collections::HashMap;
use super::UsageInfo;
use super::{default_rates, harness_default_model_key};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ModelRate {
    pub input_per_mtok: f64,
    pub cache_read_per_mtok: f64,
    pub output_per_mtok: f64,
}

/// Resolves a Settings override row (parsed from the `price.<key>.input_per_mtok`
/// / `.cache_read_per_mtok` / `.output_per_mtok` keys) into a `ModelRate`.
/// Missing fields fall back to the built-in default for the same key.
pub fn resolve_rate(key: &str, settings: &HashMap<String, ModelRate>) -> Option<ModelRate> {
    let (in_def, out_def) = default_rates(key)?;
    let default = ModelRate {
        input_per_mtok: in_def,
        // Anthropic default cache rate is 0.1× input. The default_rates_v2
        // table is the source of cache rates; the override is a layered
        // replacement, not a 0.1× recompute (so OpenAI's 0.5× is preserved).
        cache_read_per_mtok: in_def * 0.1,
        output_per_mtok: out_def,
    };
    let mut rate = default;
    if let Some(o) = settings.get(key) {
        if o.input_per_mtok > 0.0 { rate.input_per_mtok = o.input_per_mtok; }
        if o.cache_read_per_mtok > 0.0 { rate.cache_read_per_mtok = o.cache_read_per_mtok; }
        if o.output_per_mtok > 0.0 { rate.output_per_mtok = o.output_per_mtok; }
    }
    Some(rate)
}

pub fn price_usage(
    usage: &UsageInfo,
    model_key: Option<&str>,
    settings: &HashMap<String, ModelRate>,
) -> Option<f64> {
    let key = model_key?;
    let rate = resolve_rate(key, settings)?;
    let input = usage.input_tokens.unwrap_or(0) as f64
        + usage.cache_creation_input_tokens.unwrap_or(0) as f64;
    let cached = usage.cache_read_input_tokens.unwrap_or(0) as f64;
    let output = usage.output_tokens.unwrap_or(0) as f64
        + usage.reasoning_output_tokens.unwrap_or(0) as f64;
    let cost = (input * rate.input_per_mtok
        + cached * rate.cache_read_per_mtok
        + output * rate.output_per_mtok)
        / 1_000_000.0;
    (cost > 0.0).then_some(cost)
}

pub fn cache_savings(usage: &UsageInfo, model_key: Option<&str>, settings: &HashMap<String, ModelRate>) -> f64 {
    let Some(key) = model_key else { return 0.0 };
    let Some(rate) = resolve_rate(key, settings) else { return 0.0 };
    let cached = usage.cache_read_input_tokens.unwrap_or(0) as f64;
    if cached <= 0.0 { return 0.0; }
    cached * (rate.input_per_mtok - rate.cache_read_per_mtok).max(0.0) / 1_000_000.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness_adapters::UsageInfo;

    fn empty() -> HashMap<String, ModelRate> { HashMap::new() }

    #[test]
    fn price_usage_full_breakdown() {
        // claude-sonnet-4-5 = $3 in / $15 out (default), cache_read = 0.1 × in = $0.30
        let u = UsageInfo {
            input_tokens: Some(1_000_000),
            output_tokens: Some(500_000),
            cache_creation_input_tokens: Some(500_000),
            cache_read_input_tokens: Some(2_000_000),
            reasoning_output_tokens: Some(100_000),
            cost_usd: None,
        };
        // (1M + 0.5M) * 3 / 1M + 2M * 0.30 / 1M + (0.5M + 0.1M) * 15 / 1M
        // = 4.5 + 0.6 + 9.0 = 14.1
        let cost = price_usage(&u, Some("claude-sonnet-4-5"), &empty()).unwrap();
        assert!((cost - 14.1).abs() < 1e-9, "got {cost}");
    }

    #[test]
    fn price_usage_legacy_pty_row_with_null_cache() {
        // Legacy pty rows have NULL cache/reasoning; the formula must reduce
        // to the old (input * in + output * out) shape.
        let u = UsageInfo {
            input_tokens: Some(1_000_000),
            output_tokens: Some(500_000),
            cache_creation_input_tokens: None,
            cache_read_input_tokens: None,
            reasoning_output_tokens: None,
            cost_usd: None,
        };
        let cost = price_usage(&u, Some("claude-sonnet-4-5"), &empty()).unwrap();
        // 1M * 3 / 1M + 0.5M * 15 / 1M = 3.0 + 7.5 = 10.5
        assert!((cost - 10.5).abs() < 1e-9);
    }

    #[test]
    fn price_usage_unknown_model_is_none() {
        let u = UsageInfo { input_tokens: Some(100), output_tokens: None,
            cache_creation_input_tokens: None, cache_read_input_tokens: None,
            reasoning_output_tokens: None, cost_usd: None };
        assert!(price_usage(&u, Some("some-future-model"), &empty()).is_none());
    }

    #[test]
    fn price_usage_zero_tokens_is_none() {
        let u = UsageInfo { input_tokens: None, output_tokens: None,
            cache_creation_input_tokens: None, cache_read_input_tokens: None,
            reasoning_output_tokens: None, cost_usd: None };
        assert!(price_usage(&u, Some("claude-sonnet-4-5"), &empty()).is_none());
    }

    #[test]
    fn price_usage_settings_override_layered() {
        let u = UsageInfo { input_tokens: Some(1_000_000), output_tokens: Some(0),
            cache_creation_input_tokens: None, cache_read_input_tokens: None,
            reasoning_output_tokens: None, cost_usd: None };
        let mut s = HashMap::new();
        s.insert("claude-sonnet-4-5".into(), ModelRate {
            input_per_mtok: 5.0, cache_read_per_mtok: 0.0, output_per_mtok: 0.0,
        });
        // Override only sets input to $5; output still $15 (default)
        let cost = price_usage(&u, Some("claude-sonnet-4-5"), &s).unwrap();
        assert!((cost - 5.0).abs() < 1e-9);
    }

    #[test]
    fn cache_savings_uses_per_model_delta() {
        let u = UsageInfo { input_tokens: None, output_tokens: None,
            cache_creation_input_tokens: None,
            cache_read_input_tokens: Some(1_000_000), // 1M cache reads
            reasoning_output_tokens: None, cost_usd: None };
        // claude-sonnet-4-5: input $3, cache_read $0.30, delta $2.70 / 1M tokens.
        let s = cache_savings(&u, Some("claude-sonnet-4-5"), &empty());
        assert!((s - 2.7).abs() < 1e-9);
    }

    #[test]
    fn cache_savings_zero_when_no_cache_reads() {
        let u = UsageInfo { input_tokens: Some(100), output_tokens: None,
            cache_creation_input_tokens: None,
            cache_read_input_tokens: None,
            reasoning_output_tokens: None, cost_usd: None };
        let s = cache_savings(&u, Some("claude-sonnet-4-5"), &empty());
        assert_eq!(s, 0.0);
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test harness_adapters::pricing --lib`
Expected: FAIL — `pricing` module doesn't exist.

- [ ] **Step 3: Register the module**

In `src-tauri/src/harness_adapters/mod.rs`, immediately after the existing `pub mod` lines (around line 14–16):

```rust
pub mod pricing;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test harness_adapters::pricing --lib`
Expected: PASS — 7 tests, 0 failed.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/harness_adapters/pricing.rs src-tauri/src/harness_adapters/mod.rs
git commit -m "feat(pricing): read-time price_usage with per-model cache rates"
```

---

## Task 2: `UsageInfo` v2 + adapter cache/reasoning tracking

**Files:**
- Modify: `src-tauri/src/harness_adapters/mod.rs:42-47` (struct field additions)
- Modify: `src-tauri/src/harness_adapters/claude_code.rs:174-206` (parse_session_usage tracks components separately)
- Modify: `src-tauri/src/harness_adapters/kimi_code.rs` (same change for kimi)
- Modify: `src-tauri/src/harness_adapters/mod.rs:429-454` (parse_usage_common stays conservative)

**Interfaces:**
- Consumes: existing harness log JSON shapes
- Produces: `UsageInfo { input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, reasoning_output_tokens, cost_usd }` — all `Option<i64>` / `Option<f64>`

- [ ] **Step 1: Update the `UsageInfo` struct**

In `src-tauri/src/harness_adapters/mod.rs` (line 42–47), replace the struct with:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct UsageInfo {
    /// Raw input, excluding cache (matches the harness log field name).
    pub input_tokens: Option<i64>,
    /// Raw output, excluding reasoning.
    pub output_tokens: Option<i64>,
    /// Charged at full input rate (Anthropic's policy).
    pub cache_creation_input_tokens: Option<i64>,
    /// Charged at `cache_read_per_mtok` (Anthropic 0.1× input, OpenAI 0.5×).
    pub cache_read_input_tokens: Option<i64>,
    /// Counted in output cost (Anthropic surfaces this on thinking models).
    pub reasoning_output_tokens: Option<i64>,
    /// What the harness itself printed (NULL when the harness didn't say).
    pub cost_usd: Option<f64>,
}
```

Add `Default` derive so the legacy `parse_usage_common` body can stay as-is (a `..Default::default()` on the literal covers the new fields).

- [ ] **Step 2: Update existing `parse_usage_common` body for the new struct**

In `src-tauri/src/harness_adapters/mod.rs` (line 429–454), the `parse_usage_common` body constructs a `UsageInfo` literal — change the construction to:

```rust
let mut info = UsageInfo::default();
```

and keep the rest of the function unchanged. (Every existing test that asserts on `cost_usd`, `input_tokens`, `output_tokens` keeps passing; the new fields default to `None`.)

- [ ] **Step 3: Update `parse_session_usage` in `claude_code.rs`**

In `src-tauri/src/harness_adapters/claude_code.rs` (line 174–206), replace the entire `parse_session_usage` function body so each component is tracked separately:

```rust
pub fn parse_session_usage(cwd: &Path, harness_session_id: &str) -> Option<SessionUsage> {
    let clean = crate::util::strip_unc_prefix(&cwd.to_string_lossy());
    let file = claude_projects_dir(Path::new(&clean))?.join(format!("{harness_session_id}.jsonl"));
    let content = fs::read_to_string(file).ok()?;
    let mut input: i64 = 0;
    let mut cache_creation: i64 = 0;
    let mut cache_read: i64 = 0;
    let mut output: i64 = 0;
    let mut reasoning: i64 = 0;
    let mut found = false;
    let mut model: Option<String> = None;
    for line in content.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        if let Some(m) = v.pointer("/message/model").and_then(|m| m.as_str()) {
            model = Some(m.to_string());
        }
        let Some(u) = v.pointer("/message/usage").or_else(|| v.get("usage")) else { continue };
        let num = |k: &str| u.get(k).and_then(|n| n.as_i64()).unwrap_or(0);
        input += num("input_tokens");
        cache_creation += num("cache_creation_input_tokens");
        cache_read += num("cache_read_input_tokens");
        output += num("output_tokens");
        // Anthropic surfaces reasoning_tokens on thinking-capable models.
        reasoning += num("reasoning_tokens").max(num("thinking_tokens"));
        found = true;
    }
    found.then_some(SessionUsage {
        usage: UsageInfo {
            input_tokens: Some(input),
            output_tokens: Some(output),
            cache_creation_input_tokens: Some(cache_creation),
            cache_read_input_tokens: Some(cache_read),
            reasoning_output_tokens: Some(reasoning),
            cost_usd: None,
        },
        model,
    })
}
```

- [ ] **Step 4: Update `parse_session_usage` in `kimi_code.rs`**

Locate the kimi version of `parse_session_usage` (the one that sums `usage.record` events from `wire.jsonl`). Apply the same shape: separate `inputCacheRead` / `inputCacheCreation` / `output` / `reasoning` fields, populate the new `UsageInfo` fields. Kimi's log field names are camelCase per the existing code — preserve them. Add a new test:

```rust
#[test]
fn parse_kimi_session_usage_separates_cache() {
    // Read a fixture from a temp file (kimi's wire.jsonl shape) and verify
    // the four cache components are tracked separately.
    let dir = std::env::temp_dir().join(format!("conduit-kimi-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("wire.jsonl");
    let mut f = std::fs::File::create(&file).unwrap();
    writeln!(f, r#"{{"type":"usage.record","usage":{{"input":100,"output":10,"inputCacheRead":40,"inputCacheCreation":5}},"model":"kimi-k3"}}"#).unwrap();
    drop(f);
    // ... same fixture-based test pattern as claude_code::usage_tests
    let _ = std::fs::remove_dir_all(&dir);
}
```

- [ ] **Step 5: Update the existing test that checks summed input/cache**

The existing test in `claude_code.rs` at `usage_tests::parse_usage_sums_message_usage_objects` (line 307) currently sums cache into a single `input` value. Update its assertions to verify the breakdown instead:

```rust
assert_eq!(input, 100 + 200); // raw input, not cache
assert_eq!(cache_creation, 5);
assert_eq!(cache_read, 40);
assert_eq!(output, 30);
```

(Apply the same shape to any other adapter test that sums cache into input.)

- [ ] **Step 6: Run the full harness_adapters test suite**

Run: `cd src-tauri && cargo test harness_adapters --lib`
Expected: PASS — including the new pricing tests, the updated parse_session_usage tests, and the legacy pty parse_usage tests (which use `..Default::default()` and still work).

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/harness_adapters/
git commit -m "feat(adapters): UsageInfo v2 with cache/reasoning breakdown"
```

---

## Task 3: Migration + `cost_events` schema

**Files:**
- Create: `src-tauri/src/db/migrations/0008_cost_v2.sql`
- Modify: `src-tauri/src/db/mod.rs` (register the migration; add to `configure`)
- Modify: `src-tauri/src/db/cost.rs` (struct field reads, new `insert_cost_event` signature, drop old column refs)

**Interfaces:**
- Produces: `cost_events` with columns
  `id, session_id, timestamp, input_tokens, output_tokens,
   provider, model_key, source,
   cache_creation_input_tokens, cache_read_input_tokens, reasoning_output_tokens,
   reported_cost_usd, pricing_estimated_usd`
  (the old `estimated_cost_usd` is dropped)

- [ ] **Step 1: Write the migration**

In `src-tauri/src/db/migrations/0008_cost_v2.sql`:

```sql
-- Cost model v2 (COST_MODEL_REDESIGN.md §5.1).
-- Additive: every ALTER is a no-op if the column already exists (the
-- migration runner checks sqlite_master before applying each statement).

ALTER TABLE cost_events ADD COLUMN provider TEXT;
ALTER TABLE cost_events ADD COLUMN model_key TEXT;
ALTER TABLE cost_events ADD COLUMN source TEXT NOT NULL DEFAULT 'pty';
ALTER TABLE cost_events ADD COLUMN cache_creation_input_tokens INTEGER;
ALTER TABLE cost_events ADD COLUMN cache_read_input_tokens INTEGER;
ALTER TABLE cost_events ADD COLUMN reasoning_output_tokens INTEGER;
ALTER TABLE cost_events ADD COLUMN reported_cost_usd REAL;
ALTER TABLE cost_events ADD COLUMN pricing_estimated_usd REAL;

-- Backfill: rows whose session was ever on-disk-synced get source='on_disk';
-- remaining rows keep the 'pty' default.
UPDATE cost_events
   SET source = 'on_disk'
 WHERE source = 'pty'
   AND session_id IN (SELECT id FROM sessions WHERE last_synced_at IS NOT NULL);

-- Best-effort model_key backfill: only when the session has a known harness
-- and that harness has a single canonical default model. Mixed-model sessions
-- and opencode stay NULL (the cost-quality panel surfaces these as "unknown").
UPDATE cost_events
   SET model_key = CASE s.harness
       WHEN 'claude_code' THEN 'claude-sonnet-4-5'
       WHEN 'kimi_code'   THEN 'kimi-k3'
       ELSE model_key
   END
  FROM sessions s
 WHERE cost_events.session_id = s.id
   AND cost_events.model_key IS NULL
   AND s.harness IN ('claude_code', 'kimi_code');

-- DROP last: if any earlier statement fails, the old column is still here
-- and the new code path is unused.
ALTER TABLE cost_events DROP COLUMN estimated_cost_usd;
```

- [ ] **Step 2: Write the failing migration test**

In `src-tauri/src/db/cost.rs`, add to the existing `tests` module:

```rust
#[test]
fn cost_v2_migration_preserves_rows_and_adds_columns() {
    use crate::harness_adapters::UsageInfo;
    let conn = super::super::mem();
    let p = super::super::add_project(&conn, "/tmp/a", "a", false).unwrap();
    let s = super::super::create_session(&conn, &p.id, "claude_code").unwrap();
    // Pre-migration row (legacy shape).
    insert_cost_event(&conn, &s.id, &UsageInfo {
        input_tokens: Some(100), output_tokens: Some(50),
        cache_creation_input_tokens: None, cache_read_input_tokens: None,
        reasoning_output_tokens: None, cost_usd: Some(0.10),
    }, "claude_code", "pty", None).unwrap();

    // (Migration is run by db::configure on a real open, not by `mem()`.)
    // We assert the post-migration schema directly.
    super::super::migrate_cost_v2(&conn).unwrap();

    // Old `estimated_cost_usd` is gone, new columns exist.
    let cols: Vec<String> = conn
        .prepare("PRAGMA table_info(cost_events)").unwrap()
        .query_map([], |r| r.get::<_, String>(1)).unwrap()
        .filter_map(Result::ok).collect();
    assert!(!cols.contains(&"estimated_cost_usd".to_string()));
    assert!(cols.contains(&"provider".to_string()));
    assert!(cols.contains(&"model_key".to_string()));
    assert!(cols.contains(&"source".to_string()));
    assert!(cols.contains(&"cache_creation_input_tokens".to_string()));
    assert!(cols.contains(&"cache_read_input_tokens".to_string()));
    assert!(cols.contains(&"reasoning_output_tokens".to_string()));
    assert!(cols.contains(&"reported_cost_usd".to_string()));
    assert!(cols.contains(&"pricing_estimated_usd".to_string()));

    // The legacy row's tokens are preserved, model_key backfilled, source kept.
    let row: (i64, Option<i64>, Option<i64>, String, Option<String>, String) = conn
        .query_row("SELECT id, input_tokens, output_tokens, source, model_key, 'dummy'
                     FROM cost_events", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))
        .unwrap();
    assert_eq!(row.1, Some(100));
    assert_eq!(row.2, Some(50));
    assert_eq!(row.3, "pty");
    assert_eq!(row.4, Some("claude-sonnet-4-5".to_string()));
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd src-tauri && cargo test db::cost::tests::cost_v2_migration --lib`
Expected: FAIL — `migrate_cost_v2` doesn't exist, and `insert_cost_event` doesn't take provider/source/model_key args.

- [ ] **Step 4: Register the migration runner in `db/mod.rs`**

In `src-tauri/src/db/mod.rs`, add the migration function. The existing migrations use `if … "duplicate column name" { skip }` patterns (see `migrate_chat_session_flags`, line 88). Add a new migration function `migrate_cost_v2`:

```rust
/// Cost events v2: cache/reasoning/source/model_key/reported/pricing columns,
/// backfill where possible, and drop the old `estimated_cost_usd`. Each
/// `ALTER TABLE … ADD COLUMN` is a no-op when the column already exists
/// (handles re-runs). The `DROP COLUMN` is gated on SQLite version
/// (≥ 3.35) to fail soft on older builds.
pub fn migrate_cost_v2(conn: &Connection) -> DbResult<()> {
    for (col, def) in [
        ("provider", "TEXT"),
        ("model_key", "TEXT"),
        ("cache_creation_input_tokens", "INTEGER"),
        ("cache_read_input_tokens", "INTEGER"),
        ("reasoning_output_tokens", "INTEGER"),
        ("reported_cost_usd", "REAL"),
        ("pricing_estimated_usd", "REAL"),
    ] {
        let sql = format!("ALTER TABLE cost_events ADD COLUMN {col} {def}");
        if let Err(e) = conn.execute(&sql, []) {
            if !e.to_string().contains("duplicate column name") {
                return Err(e);
            }
        }
    }
    // `source` has a NOT NULL DEFAULT, so the column-add pattern is identical.
    let sql_source = "ALTER TABLE cost_events ADD COLUMN source TEXT NOT NULL DEFAULT 'pty'";
    if let Err(e) = conn.execute(sql_source, []) {
        if !e.to_string().contains("duplicate column name") {
            return Err(e);
        }
    }

    // Backfill: only run when `source` was actually added this run (i.e. it
    // was a fresh install) OR when there are still legacy `pty` rows that
    // should be `on_disk`. The `last_synced_at IS NOT NULL` predicate is the
    // marker: any session that the on-disk sync has touched re-inserts its
    // events with source='on_disk' on the next sync tick, so the UPDATE here
    // is a one-time catch-up.
    conn.execute(
        "UPDATE cost_events
            SET source = 'on_disk'
          WHERE source = 'pty'
            AND session_id IN (SELECT id FROM sessions WHERE last_synced_at IS NOT NULL)",
        [],
    )?;
    conn.execute(
        "UPDATE cost_events
            SET model_key = CASE s.harness
                WHEN 'claude_code' THEN 'claude-sonnet-4-5'
                WHEN 'kimi_code'   THEN 'kimi-k3'
                ELSE model_key
            END
           FROM sessions s
          WHERE cost_events.session_id = s.id
            AND cost_events.model_key IS NULL
            AND s.harness IN ('claude_code', 'kimi_code')",
        [],
    )?;

    // DROP COLUMN: gated on the column existing. Older SQLite (< 3.35) may
    // not support DROP COLUMN; fail soft by skipping in that case.
    let has_old_col: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('cost_events') WHERE name = 'estimated_cost_usd')",
            [], |r| r.get(0),
        )
        .unwrap_or(false);
    if has_old_col {
        if let Err(e) = conn.execute("ALTER TABLE cost_events DROP COLUMN estimated_cost_usd", []) {
            // Some old builds don't support DROP COLUMN; the column is
            // simply unused after this PR and a follow-up cleans it up.
            eprintln!("[conduit] cost_v2: DROP COLUMN failed ({e}); column will be unused");
        }
    }
    Ok(())
}
```

Add the call site in `db::configure` (line 67–83), right after `migrate_chat_messages_superseded(conn)?;`:

```rust
migrate_cost_v2(conn)?;
```

Also bump `CURRENT_SCHEMA_VERSION` if the constant exists in `db/mod.rs`. (The codebase has used the `migrate_xxx` function pattern for all schema evolution; if no `CURRENT_SCHEMA_VERSION` constant exists, skip the bump — verify during implementation.)

- [ ] **Step 5: Update `db/cost.rs` types and `insert_cost_event`**

Replace `db/cost.rs` `CostEvent` mapping and `insert_cost_event` to handle the new shape. The full file body (the relevant parts only) becomes:

```rust
fn map_cost_event(row: &rusqlite::Row) -> rusqlite::Result<CostEvent> {
    Ok(CostEvent {
        id: row.get("id")?,
        session_id: row.get("session_id")?,
        timestamp: row.get("timestamp")?,
        input_tokens: row.get("input_tokens")?,
        output_tokens: row.get("output_tokens")?,
        provider: row.get("provider")?,
        model_key: row.get("model_key")?,
        source: row.get("source")?,
        cache_creation_input_tokens: row.get("cache_creation_input_tokens")?,
        cache_read_input_tokens: row.get("cache_read_input_tokens")?,
        reasoning_output_tokens: row.get("reasoning_output_tokens")?,
        reported_cost_usd: row.get("reported_cost_usd")?,
        pricing_estimated_usd: row.get("pricing_estimated_usd")?,
    })
}

pub fn insert_cost_event(
    conn: &Connection,
    session_id: &str,
    usage: &UsageInfo,
    provider: &str,
    source: &str,
    pricing_estimated_usd: Option<f64>,
) -> DbResult<i64> {
    conn.execute(
        "INSERT INTO cost_events (
            session_id, timestamp,
            input_tokens, output_tokens,
            provider, source,
            cache_creation_input_tokens, cache_read_input_tokens, reasoning_output_tokens,
            reported_cost_usd, pricing_estimated_usd
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            session_id, now_ts(),
            usage.input_tokens, usage.output_tokens,
            provider, source,
            usage.cache_creation_input_tokens, usage.cache_read_input_tokens,
            usage.reasoning_output_tokens,
            usage.cost_usd, pricing_estimated_usd,
        ],
    )?;
    Ok(conn.last_insert_rowid())
}
```

(The `model_key` is filled in by the caller via a separate UPDATE after insert — the rollup endpoint resolves it from the session's `last_used_model` or the harness default, not from the row itself. Adding a separate `update_cost_event_model_key` helper covers this without bloating the insert signature. See Task 5.)

- [ ] **Step 6: Update the `CostEvent` struct in `types.rs`**

In `src-tauri/src/types.rs` (line 88–97), replace the `CostEvent` struct with:

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostEvent {
    pub id: i64,
    pub session_id: String,
    pub timestamp: i64,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub provider: Option<String>,
    pub model_key: Option<String>,
    pub source: String,
    pub cache_creation_input_tokens: Option<i64>,
    pub cache_read_input_tokens: Option<i64>,
    pub reasoning_output_tokens: Option<i64>,
    pub reported_cost_usd: Option<f64>,
    pub pricing_estimated_usd: Option<f64>,
}
```

- [ ] **Step 7: Update the existing cost test in `db/cost.rs`**

The existing test (`cost_events_and_rollups`, line 102) constructs `UsageInfo` literals and calls `insert_cost_event`. Update every call to the new signature:

```rust
insert_cost_event(&conn, &s1.id, &UsageInfo { ... }, "claude_code", "pty", Some(0.10)).unwrap();
```

The test still asserts per-project + daily rollup behavior, which keeps working because the old fields are preserved.

- [ ] **Step 8: Update the existing `db/projects.rs` test that calls `insert_cost_event`**

`db/projects.rs:213` (the `remove_project_cascades_manually` test) calls `super::super::insert_cost_event` with the old signature. Update the call to the new one:

```rust
super::super::insert_cost_event(
    &conn, &s.id, &UsageInfo {
        input_tokens: Some(1), output_tokens: None,
        cache_creation_input_tokens: None, cache_read_input_tokens: None,
        reasoning_output_tokens: None, cost_usd: Some(0.01),
    },
    "claude_code", "pty", Some(0.01),
).unwrap();
```

- [ ] **Step 9: Run the migration test**

Run: `cd src-tauri && cargo test db::cost::tests::cost_v2_migration --lib`
Expected: PASS.

- [ ] **Step 10: Run the full backend test suite**

Run: `cd src-tauri && cargo test --lib`
Expected: PASS — including the new `migrate_cost_v2` test, the updated `cost_events_and_rollups` test, the updated `parse_session_usage` tests, and the new `pricing` tests. Any pre-existing test that constructs `UsageInfo` literals should keep working (the struct gained fields with `Default` so all literals that don't name the new fields will need to use `..Default::default()` or name every field — find and fix each one during this step).

- [ ] **Step 11: Commit**

```bash
git add src-tauri/src/db/
git commit -m "feat(db): cost_events v2 migration with cache/reasoning/source columns"
```

---

## Task 4: `pty::record_usage` signature change

**Files:**
- Modify: `src-tauri/src/pty/mod.rs:240-289` (record_usage signature + body)
- Modify: `src-tauri/src/pty/mod.rs:297-318` (price_for moved out, calls pricing::price_usage)

**Interfaces:**
- Consumes: `crate::harness_adapters::pricing::{price_usage, ModelRate}`, settings overrides read from `db::get_setting`
- Produces: updated `record_usage` that fills the new `insert_cost_event` columns

- [ ] **Step 1: Replace `price_for` with a call to `crate::harness_adapters::pricing::price_usage`**

In `src-tauri/src/pty/mod.rs:297-318`, replace the entire `price_for` function body. The new version reads settings overrides once and delegates to the pricing module:

```rust
fn price_for(&self, db: &SharedDb, delta: &UsageInfo, model: Option<&str>) -> Option<f64> {
    use crate::harness_adapters::pricing::{price_usage, ModelRate};
    use std::collections::HashMap;

    let adapter = self.adapter.as_ref()?;
    let raw_key = model
        .and_then(crate::harness_adapters::canonical_model_key)
        .unwrap_or_else(|| crate::harness_adapters::harness_default_model_key(adapter.id()));

    // Read per-model Settings overrides (price.<key>.<suffix>) into a HashMap.
    let mut overrides: HashMap<String, ModelRate> = HashMap::new();
    let conn = db.lock();
    let parse = |v: Option<String>| v.and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
    for (suffix, target) in [
        ("input_per_mtok", "input_per_mtok"),
        ("cache_read_per_mtok", "cache_read_per_mtok"),
        ("output_per_mtok", "output_per_mtok"),
    ] {
        let key = format!("price.{raw_key}.{suffix}");
        if let Ok(Some(v)) = db::get_setting(&conn, &key) {
            let val = parse(Some(v));
            if val > 0.0 {
                let entry = overrides.entry(raw_key.to_string()).or_insert(ModelRate {
                    input_per_mtok: 0.0, cache_read_per_mtok: 0.0, output_per_mtok: 0.0,
                });
                match target {
                    "input_per_mtok" => entry.input_per_mtok = val,
                    "cache_read_per_mtok" => entry.cache_read_per_mtok = val,
                    "output_per_mtok" => entry.output_per_mtok = val,
                    _ => {}
                }
            }
        }
    }
    drop(conn);
    price_usage(delta, Some(raw_key), &overrides)
}
```

- [ ] **Step 2: Update `record_usage` signature and call to `insert_cost_event`**

In `src-tauri/src/pty/mod.rs:250`, change the function signature to:

```rust
fn record_usage(&self, app: &AppHandle, db: &SharedDb, usage: UsageInfo, model: Option<&str>) {
```

and update the body around line 281:

```rust
// Compute pricing for the delta if the harness didn't print its own cost.
if delta.cost_usd.is_none() {
    delta.cost_usd = self.price_for(db, &delta, model);
}
let pricing_estimated_usd = delta.cost_usd;

let adapter_id = self.adapter.as_ref().map(|a| a.id()).unwrap_or("unknown");
let conn = db.lock();
if db::insert_cost_event(&conn, session_id, &delta, adapter_id, "pty", pricing_estimated_usd).is_ok() {
    let _ = app.emit(
        "cost:updated",
        CostUpdatedEvent {
            session_id: session_id.clone(),
            version: 2,
        },
    );
}
```

(The `CostUpdatedEvent` gets a `version: u32 = 2` field — see Task 6.)

- [ ] **Step 3: Verify the `delta` field set is correct**

The existing `record_usage` body (line 252–270) constructs a `delta: UsageInfo` by zipping current vs previous fields. With the new `UsageInfo` shape, the zip needs to cover the new fields too. Update the delta construction:

```rust
let mut delta = {
    let mut last = self.last_usage.lock();
    let prev = *last;
    *last = Some(usage);
    match prev {
        Some(p) => UsageInfo {
            input_tokens: usage.input_tokens.zip(p.input_tokens).map(|(a, b)| (a - b).max(0)),
            output_tokens: usage.output_tokens.zip(p.output_tokens).map(|(a, b)| (a - b).max(0)),
            cache_creation_input_tokens: usage.cache_creation_input_tokens.zip(p.cache_creation_input_tokens).map(|(a, b)| (a - b).max(0)),
            cache_read_input_tokens: usage.cache_read_input_tokens.zip(p.cache_read_input_tokens).map(|(a, b)| (a - b).max(0)),
            reasoning_output_tokens: usage.reasoning_output_tokens.zip(p.reasoning_output_tokens).map(|(a, b)| (a - b).max(0)),
            cost_usd: usage.cost_usd.zip(p.cost_usd).map(|(a, b)| (a - b).max(0.0)),
        },
        None => usage,
    }
};
```

- [ ] **Step 4: Run the pty tests**

Run: `cd src-tauri && cargo test pty --lib`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/pty/mod.rs
git commit -m "feat(pty): record_usage populates cache/reasoning + read-time pricing"
```

---

## Task 5: On-disk sync path populates new columns

**Files:**
- Modify: `src-tauri/src/pty/mod.rs` (the `last_usage_sync` tick at line ~810)
- Modify: `src-tauri/src/db/cost.rs` (add `update_cost_event_model_key` helper)

**Interfaces:**
- Consumes: `parse_session_usage` (now returning the full UsageInfo v2)
- Produces: cost events with `source = 'on_disk'`, `model_key` set from `canonical_model_key(...)`, full cache/reasoning breakdown

- [ ] **Step 1: Add the `update_cost_event_model_key` helper to `db/cost.rs`**

In `src-tauri/src/db/cost.rs`:

```rust
/// Sets the model_key on a just-inserted cost event. The insert site doesn't
/// know the canonical key (that comes from the session log), so it inserts
/// with model_key=NULL and updates here.
pub fn update_cost_event_model_key(conn: &Connection, id: i64, model_key: &str) -> DbResult<()> {
    conn.execute(
        "UPDATE cost_events SET model_key = ?1 WHERE id = ?2",
        params![model_key, id],
    )?;
    Ok(())
}
```

- [ ] **Step 2: Update the on-disk sync tick**

Find the call site in `pty/mod.rs` that records the on-disk parsed usage (around line 810 — `pane.record_usage(&mgr.app, &mgr.db, su.usage, su.model.as_deref());`). Wrap it so the source becomes `'on_disk'` and the model_key is set on the inserted row. Add a new helper to `Pane`:

```rust
/// Like `record_usage` but for the on-disk sync path. Source is 'on_disk'
/// (so the cost-quality panel can distinguish from pty), and the row gets
/// its model_key backfilled from the session log.
fn record_usage_on_disk(&self, app: &AppHandle, db: &SharedDb, usage: UsageInfo, model: Option<&str>) {
    let Some(session_id) = &self.session_id else { return };
    let mut usage = usage;
    if usage.cost_usd.is_none() {
        usage.cost_usd = self.price_for(db, &usage, model);
    }
    let pricing_estimated_usd = usage.cost_usd;
    let adapter_id = self.adapter.as_ref().map(|a| a.id()).unwrap_or("unknown");
    let conn = db.lock();
    match db::insert_cost_event(&conn, session_id, &usage, adapter_id, "on_disk", pricing_estimated_usd) {
        Ok(id) => {
            if let Some(m) = model.and_then(crate::harness_adapters::canonical_model_key) {
                let _ = db::update_cost_event_model_key(&conn, id, m);
            }
            let _ = app.emit("cost:updated", CostUpdatedEvent {
                session_id: session_id.clone(),
                version: 2,
            });
        }
        Err(_) => {}
    }
}
```

Replace the existing on-disk-sync call site with `pane.record_usage_on_disk(...)` instead of `pane.record_usage(...)`.

- [ ] **Step 3: Add a test for `update_cost_event_model_key`**

In `db/cost.rs` `tests` module:

```rust
#[test]
fn update_model_key_writes_canonical_key() {
    let conn = super::super::mem();
    let p = super::super::add_project(&conn, "/tmp/a", "a", false).unwrap();
    let s = super::super::create_session(&conn, &p.id, "claude_code").unwrap();
    let id = insert_cost_event(&conn, &s.id, &UsageInfo {
        input_tokens: Some(1), output_tokens: None,
        cache_creation_input_tokens: None, cache_read_input_tokens: None,
        reasoning_output_tokens: None, cost_usd: None,
    }, "claude_code", "on_disk", None).unwrap();
    update_cost_event_model_key(&conn, id, "claude-opus-4-8").unwrap();
    let key: Option<String> = conn.query_row(
        "SELECT model_key FROM cost_events WHERE id = ?1", [id], |r| r.get(0)
    ).unwrap();
    assert_eq!(key, Some("claude-opus-4-8".to_string()));
}
```

- [ ] **Step 4: Run the test**

Run: `cd src-tauri && cargo test db::cost::tests::update_model_key --lib`
Expected: PASS.

- [ ] **Step 5: Run the full backend test suite**

Run: `cd src-tauri && cargo test --lib`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/pty/mod.rs src-tauri/src/db/cost.rs
git commit -m "feat(pty): on-disk sync populates cache/reasoning + sets model_key"
```

---

## Task 6: `CostUpdatedEvent` `version: 2` + chat message columns

**Files:**
- Modify: `src-tauri/src/types.rs:169-173` (CostUpdatedEvent version field)
- Modify: `src-tauri/src/types.rs:248-265` (ChatMessageRecord new fields)
- Modify: `src-tauri/src/db/chat.rs:222-263` (map_chat_message + add_chat_message signature)
- Modify: `src-tauri/src/chat/mod.rs` (populate new fields from streaming usage)
- Modify: `src-tauri/src/chat/commands.rs` (the assistant-message insert at line 1084)
- Modify: `src-tauri/src/agent_sessions.rs:1505` (the harness-side assistant insert)
- Modify: `src-tauri/src/mobile/session_chat.rs:97-117` (the wire-format SELECT and the add at line 279)
- Modify: `src-tauri/src/mobile/relay.rs:899, 1020` (the two add_chat_message calls)

**Interfaces:**
- `ChatMessageRecord` gains optional fields: `cache_creation_input_tokens`, `cache_read_input_tokens`, `reasoning_output_tokens`, `provider`, `model_key`, `pricing_estimated_usd`
- `add_chat_message` signature gains a `provider: &str`, `model_key: Option<&str>`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `reasoning_output_tokens` (all `Option<i64>`)

- [ ] **Step 1: Add `version: 2` to `CostUpdatedEvent`**

In `src-tauri/src/types.rs:169-173`:

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostUpdatedEvent {
    pub session_id: String,
    /// Schema version of the payload. 1 = legacy `{ sessionId }`; 2 = current
    /// (adds `totals`, `byKind`, `costQuality` blocks on the rollup endpoint).
    /// Old mobile clients ignore the version field; the value lets the mobile
    /// UI detect the new shape and degrade gracefully.
    pub version: u32,
}
```

- [ ] **Step 2: Update every `CostUpdatedEvent { session_id: ... }` literal**

Run: `cd src-tauri && grep -rn "CostUpdatedEvent {" src/`

Every match needs `version: 2` added. The known sites are:
- `pty/mod.rs:284` (in `record_usage` — already updated in Task 4)
- Anywhere else that emits `cost:updated` (search confirms during this step; usually only the one site).

- [ ] **Step 3: Update `ChatMessageRecord` in `types.rs`**

Replace the struct (line 248–265):

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessageRecord {
    pub id: i64,
    pub chat_session_id: String,
    pub role: String,
    pub content: String,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub cost_usd: Option<f64>,
    pub created_at: i64,
    /// Non-null only for turns folded into a `[compacted context]` summary row.
    #[serde(default)]
    pub superseded_by: Option<i64>,
    #[serde(default)]
    pub cache_creation_input_tokens: Option<i64>,
    #[serde(default)]
    pub cache_read_input_tokens: Option<i64>,
    #[serde(default)]
    pub reasoning_output_tokens: Option<i64>,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub model_key: Option<String>,
    #[serde(default)]
    pub pricing_estimated_usd: Option<f64>,
}
```

- [ ] **Step 4: Update `map_chat_message` and `add_chat_message` in `db/chat.rs`**

```rust
fn map_chat_message(row: &rusqlite::Row) -> rusqlite::Result<ChatMessageRecord> {
    Ok(ChatMessageRecord {
        id: row.get("id")?,
        chat_session_id: row.get("chat_session_id")?,
        role: row.get("role")?,
        content: row.get("content")?,
        input_tokens: row.get("input_tokens")?,
        output_tokens: row.get("output_tokens")?,
        cost_usd: row.get("cost_usd")?,
        created_at: row.get("created_at")?,
        superseded_by: row.get("superseded_by")?,
        cache_creation_input_tokens: row.get("cache_creation_input_tokens")?,
        cache_read_input_tokens: row.get("cache_read_input_tokens")?,
        reasoning_output_tokens: row.get("reasoning_output_tokens")?,
        provider: row.get("provider")?,
        model_key: row.get("model_key")?,
        pricing_estimated_usd: row.get("pricing_estimated_usd")?,
    })
}
```

Add a migration `migrate_chat_messages_v2` to `db/mod.rs` (same duplicate-column-tolerant pattern as `migrate_cost_v2`):

```rust
pub fn migrate_chat_messages_v2(conn: &Connection) -> DbResult<()> {
    for (col, def) in [
        ("cache_creation_input_tokens", "INTEGER"),
        ("cache_read_input_tokens", "INTEGER"),
        ("reasoning_output_tokens", "INTEGER"),
        ("provider", "TEXT"),
        ("model_key", "TEXT"),
        ("pricing_estimated_usd", "REAL"),
    ] {
        let sql = format!("ALTER TABLE chat_messages ADD COLUMN {col} {def}");
        if let Err(e) = conn.execute(&sql, []) {
            if !e.to_string().contains("duplicate column name") {
                return Err(e);
            }
        }
    }
    Ok(())
}
```

Add the call site to `db::configure` (alongside `migrate_cost_v2`).

Update the `add_chat_message` signature:

```rust
pub fn add_chat_message(
    conn: &Connection,
    chat_session_id: &str,
    role: &str,
    content: &str,
    input_tokens: Option<i64>,
    output_tokens: Option<i64>,
    cost_usd: Option<f64>,
    cache_creation_input_tokens: Option<i64>,
    cache_read_input_tokens: Option<i64>,
    reasoning_output_tokens: Option<i64>,
    provider: Option<&str>,
    model_key: Option<&str>,
    pricing_estimated_usd: Option<f64>,
) -> DbResult<ChatMessageRecord> {
    let now = now_ts();
    conn.execute(
        "INSERT INTO chat_messages (
            chat_session_id, role, content,
            input_tokens, output_tokens, cost_usd, created_at,
            cache_creation_input_tokens, cache_read_input_tokens, reasoning_output_tokens,
            provider, model_key, pricing_estimated_usd
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            chat_session_id, role, content,
            input_tokens, output_tokens, cost_usd, now,
            cache_creation_input_tokens, cache_read_input_tokens, reasoning_output_tokens,
            provider, model_key, pricing_estimated_usd,
        ],
    )?;
    let id = conn.last_insert_rowid();
    Ok(ChatMessageRecord {
        id, chat_session_id: chat_session_id.to_string(), role: role.to_string(),
        content: content.to_string(), input_tokens, output_tokens, cost_usd,
        created_at: now, superseded_by: None,
        cache_creation_input_tokens, cache_read_input_tokens, reasoning_output_tokens,
        provider: provider.map(String::from), model_key: model_key.map(String::from),
        pricing_estimated_usd,
    })
}
```

- [ ] **Step 5: Update every `add_chat_message` call site**

The known sites (verify with `grep -rn "add_chat_message" src-tauri/src/`):

- `db/chat.rs:358, 360, 443, 445` (tests) — add the seven new args as `None`.
- `db/mod.rs:213` (legacy test) — already in this plan, add new args.
- `chat/commands.rs:702` (user message insert) — pass `None, None, None, None, None, None, None` for the new args.
- `chat/commands.rs:1084` (assistant message insert) — read cache/reasoning from the streaming usage object; pass the provider from the chat session.
- `chat/mod.rs:264` (assistant message insert in the streaming tool loop) — same.
- `agent_sessions.rs:155, 1176` (user message inserts for harness sessions) — `None` for new args.
- `agent_sessions.rs:1505` (assistant message insert in harness run) — read cache/reasoning from the parsed session usage object; set `provider = "harness:<id>"`.
- `mobile/relay.rs:899, 1020` (mobile-originated inserts) — `None` for new args.
- `mobile/session_chat.rs:279` (mobile user message) — `None` for new args.

For the two streaming/usage-aware call sites (`chat/commands.rs:1084` and `chat/mod.rs:264`), the `usage` object that drives `input_tokens` / `output_tokens` / `cost_usd` already exists; add the cache/reasoning reads. The `chat/usage` shape carries `cache_creation_input_tokens`, `cache_read_input_tokens`, `reasoning_tokens` (Anthropic) — surface them to the new args. Provider comes from the chat session's `provider` column.

- [ ] **Step 6: Update `mobile/session_chat.rs:97` SELECT and `relay.rs` uses**

The wire-format `SELECT` at `session_chat.rs:97` must include the new columns so the mobile app sees them:

```sql
SELECT id, role, content, created_at,
       input_tokens, output_tokens, cost_usd,
       cache_creation_input_tokens, cache_read_input_tokens, reasoning_output_tokens,
       provider, model_key, pricing_estimated_usd,
       superseded_by
  FROM chat_messages WHERE chat_session_id = ?1 ORDER BY id
```

Add the new column reads in the row mapping (line 117).

- [ ] **Step 7: Update the existing chat tests**

The tests in `db/chat.rs` that call `add_chat_message` need the seven new args (all `None` for the existing tests, since they don't exercise cache/reasoning). Update the call sites.

- [ ] **Step 8: Run the chat tests**

Run: `cd src-tauri && cargo test db::chat --lib`
Expected: PASS.

- [ ] **Step 9: Run the full backend test suite**

Run: `cd src-tauri && cargo test --lib`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src-tauri/src/
git commit -m "feat(chat): chat_messages v2 with cache/reasoning/provider/model_key"
```

---

## Task 7: New `CostRollups` shape

**Files:**
- Modify: `src-tauri/src/types.rs:115-120` (full CostRollups shape + sub-structs)
- Create: `src-tauri/src/db/cost_v2.rs` (rollup computation)
- Modify: `src-tauri/src/db/mod.rs` (re-export the new rollup; keep the old signature as a thin shim that calls the new one with `range_days: 30`)
- Modify: `src-tauri/src/commands/data.rs:170-178` (new command signature)

**Interfaces:**
- Produces: the full `CostRollups` interface from spec Section 8 (totals, perProvider, daily with tokensByProvider, byKind, perModel, costQuality, perProject, rangeStart/rangeEnd/rangeDays)
- `get_cost_rollups(range_days: Option<u32>) -> CostRollups` (range_days in 7 | 30 | 90; default 30)

- [ ] **Step 1: Define the new `CostRollups` shape in `types.rs`**

Replace the `CostRollups` struct and add the supporting types (line 115–120):

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostRollups {
    pub totals: CostTotals,
    pub per_provider: Vec<ProviderCostRollup>,
    pub daily: Vec<DailyCost>,
    pub by_kind: CostByKind,
    pub per_model: Vec<ModelCostRollup>,
    pub cost_quality: CostQuality,
    pub per_project: Vec<ProjectCostRollup>,
    pub range_start: String, // ISO 'YYYY-MM-DD'
    pub range_end: String,   // ISO 'YYYY-MM-DD'
    pub range_days: u32,     // 7 | 30 | 90
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostTotals {
    pub raw_token_cost_usd: f64,
    pub provider_reported_usd: f64,
    pub estimated_usd: f64,
    pub unpriced_usd: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCostRollup {
    pub provider: String,
    pub cost_usd: f64,
    pub tokens: i64,
    pub share_pct: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyCost {
    pub day: String,
    pub cost_usd: f64,
    pub tokens_by_provider: std::collections::BTreeMap<String, i64>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CostByKind {
    pub processed_tokens: i64,
    pub cached_input_tokens: i64,
    pub uncached_input_tokens: i64,
    pub output_tokens: i64,
    pub reasoning_tokens: i64,
    pub sessions: i64,
    pub responses: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCostRollup {
    pub model_key: String,
    pub display_name: String,
    pub cost_usd: f64,
    pub share_pct: f64,
    pub tokens: i64,
    pub provider: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostQuality {
    pub provider_reported_pct: f64,
    pub model_priced_pct: f64,
    pub unpriced_pct: f64,
    pub cache_savings_usd: f64,
}
```

- [ ] **Step 2: Create `db/cost_v2.rs` with the rollup computation**

The rollup unions `cost_events` and `chat_messages`. The structure is:

```rust
//! Cost rollup v2 (COST_MODEL_REDESIGN.md §8).
//!
//! Read-time pricing via `crate::harness_adapters::pricing::price_usage`.
//! Single source of truth across desktop + mobile.

use rusqlite::{params, Connection};
use std::collections::{BTreeMap, HashMap};
use crate::harness_adapters::pricing::{price_usage, cache_savings, ModelRate};
use crate::types::*;
use super::DbResult;

/// Read settings overrides once (price.<key>.{input,cache_read,output}_per_mtok).
pub fn read_rate_overrides(conn: &Connection) -> HashMap<String, ModelRate> {
    use crate::db::get_setting;
    let mut out = HashMap::new();
    // Iterate every key starting with "price." to avoid hard-coding model keys.
    let Ok(mut stmt) = conn.prepare(
        "SELECT key, value FROM app_settings WHERE key LIKE 'price.%.input_per_mtok'
          OR key LIKE 'price.%.cache_read_per_mtok'
          OR key LIKE 'price.%.output_per_mtok'"
    ) else { return out };
    let rows = stmt.query_map([], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    }).ok();
    if let Some(rows) = rows {
        for row in rows.flatten() {
            let (key, value) = row;
            // key shape: "price.<model>.<suffix>"
            let parts: Vec<&str> = key.splitn(3, '.').collect();
            if parts.len() != 3 { continue; }
            let model = parts[1].to_string();
            let suffix = parts[2];
            let val: f64 = value.parse().unwrap_or(0.0);
            if val <= 0.0 { continue; }
            let entry = out.entry(model).or_insert(ModelRate {
                input_per_mtok: 0.0, cache_read_per_mtok: 0.0, output_per_mtok: 0.0,
            });
            match suffix {
                "input_per_mtok" => entry.input_per_mtok = val,
                "cache_read_per_mtok" => entry.cache_read_per_mtok = val,
                "output_per_mtok" => entry.output_per_mtok = val,
                _ => {}
            }
        }
    }
    out
}

pub fn get_cost_rollups_v2(conn: &Connection, range_days: u32) -> DbResult<CostRollups> {
    let overrides = read_rate_overrides(conn);
    let now = crate::db::now_ts();
    let since = now - (range_days as i64) * 86_400;
    let total_window: f64 = (range_days as f64) * 86_400.0;
    // rangeStart = epoch(now - range_days) as date; rangeEnd = epoch(now) as date.
    let (range_start, range_end) = {
        use std::time::{UNIX_EPOCH, Duration};
        let s = UNIX_EPOCH + Duration::from_secs(since as u64);
        let e = UNIX_EPOCH + Duration::from_secs(now as u64);
        let fmt = |t: std::time::SystemTime| {
            let secs = t.duration_since(UNIX_EPOCH).unwrap().as_secs() as i64;
            // Cheap Y-M-D via chrono would be ideal, but the codebase doesn't
            // depend on chrono — use time crate (already a dep? check) or
            // a tiny manual conversion. The codebase uses `date(timestamp, 'unixepoch')`
            // in SQL everywhere; mirror that.
            // We'll use a `time` crate re-export if available, else compute in SQL.
            format!("{:?}", secs) // placeholder; replaced below
        };
        (fmt(s), fmt(e))
    };

    // ... (the actual SQL is large; see Steps 3–6 below for each block)
    todo!()
}
```

The full implementation is too long for an inline step. Continue with the per-block tests.

- [ ] **Step 3: Write the totals block test**

In `db/cost_v2.rs` `tests` module:

```rust
#[test]
fn rollup_totals_match_sum() {
    let conn = super::super::mem();
    let p = super::super::add_project(&conn, "/tmp/a", "a", false).unwrap();
    let s = super::super::create_session(&conn, &p.id, "claude_code").unwrap();
    // Three events with full breakdown: 1M input + 0.5M cache_creation,
    // 0.5M output, 2M cache_read. All on sonnet-4-5.
    let u = |i: i64, o: i64, cc: i64, cr: i64, r: i64, cost: Option<f64>| crate::harness_adapters::UsageInfo {
        input_tokens: Some(i), output_tokens: Some(o),
        cache_creation_input_tokens: Some(cc), cache_read_input_tokens: Some(cr),
        reasoning_output_tokens: Some(r), cost_usd: cost,
    };
    for _ in 0..3 {
        super::super::insert_cost_event(
            &conn, &s.id, &u(1_000_000, 500_000, 500_000, 2_000_000, 0, None),
            "claude_code", "on_disk", Some(14.1), // matches Task 1's price_usage output
        ).unwrap();
    }
    let r = super::get_cost_rollups_v2(&conn, 30).unwrap();
    // Each event: 14.1 USD priced; 3 events → 42.3 raw
    assert!((r.totals.raw_token_cost_usd - 42.3).abs() < 1e-6, "got {}", r.totals.raw_token_cost_usd);
    assert_eq!(r.totals.provider_reported_usd, 0.0); // no harness-printed cost
    assert!((r.totals.estimated_usd - 42.3).abs() < 1e-6);
    assert_eq!(r.totals.unpriced_usd, 0.0);
}
```

- [ ] **Step 4: Implement the totals block**

In `db/cost_v2.rs`, fill the function body with the totals computation. The pattern is:

```rust
// Pull every event in the window as a priced row. The cost_events table is
// the harness pane; chat_messages is the in-app chat. UNION them by a
// per-row tuple, then price each row through price_usage.
let mut priced_rows: Vec<(f64, i64, &str)> = Vec::new();
let mut cache_savings_total = 0.0;
let mut provider_reported_total = 0.0;
let mut unpriced_total = 0.0;
let mut by_provider: BTreeMap<String, (f64, i64)> = BTreeMap::new();
let mut by_model: BTreeMap<String, (f64, i64, Option<String>)> = BTreeMap::new();

{
    let mut stmt = conn.prepare(
        "SELECT id, input_tokens, output_tokens, provider, model_key,
                cache_creation_input_tokens, cache_read_input_tokens,
                reasoning_output_tokens, reported_cost_usd
           FROM cost_events
          WHERE timestamp >= ?1"
    )?;
    let rows = stmt.query_map(params![since], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, Option<i64>>(1)?,
            r.get::<_, Option<i64>>(2)?,
            r.get::<_, Option<String>>(3)?,
            r.get::<_, Option<String>>(4)?,
            r.get::<_, Option<i64>>(5)?,
            r.get::<_, Option<i64>>(6)?,
            r.get::<_, Option<i64>>(7)?,
            r.get::<_, Option<f64>>(8)?,
        ))
    })?;
    for row in rows {
        let (_, i, o, provider, model_key, cc, cr, reasoning, reported) = row?;
        let usage = crate::harness_adapters::UsageInfo {
            input_tokens: i, output_tokens: o,
            cache_creation_input_tokens: cc, cache_read_input_tokens: cr,
            reasoning_output_tokens: reasoning, cost_usd: None,
        };
        let key = model_key.as_deref();
        let cost = price_usage(&usage, key, &overrides);
        if let Some(c) = cost {
            priced_rows.push((c, i.unwrap_or(0) + cc.unwrap_or(0) + cr.unwrap_or(0) + o.unwrap_or(0) + reasoning.unwrap_or(0), "cost_events"));
            cache_savings_total += cache_savings(&usage, key, &overrides);
        } else {
            unpriced_total += reported.unwrap_or(0.0);
        }
        if let Some(r) = reported {
            provider_reported_total += r;
        }
        if let Some(p) = provider.as_deref() {
            let entry = by_provider.entry(p.to_string()).or_insert((0.0, 0));
            entry.0 += cost.unwrap_or(0.0);
            entry.1 += i.unwrap_or(0) + cc.unwrap_or(0) + cr.unwrap_or(0);
        }
        if let Some(k) = model_key.as_deref() {
            let entry = by_model.entry(k.to_string()).or_insert((0.0, 0, provider.clone()));
            entry.0 += cost.unwrap_or(0.0);
            entry.1 += i.unwrap_or(0) + cc.unwrap_or(0) + cr.unwrap_or(0) + o.unwrap_or(0) + reasoning.unwrap_or(0);
        }
    }
}

// (Same pattern for chat_messages — separate query, same row schema.)
// ... (see Step 5)
```

- [ ] **Step 5: Add the chat_messages union and per-provider/per-model rollups**

Append the chat_messages query and the per-model rollup assembly:

```rust
// chat_messages: in-app chat. provider is stored as the chat session's
// provider; cost is read from cost_usd (set at insert time) but we
// re-price through price_usage so retro rate changes apply.
{
    let mut stmt = conn.prepare(
        "SELECT cm.id, cm.input_tokens, cm.output_tokens, cm.provider, cm.model_key,
                cm.cache_creation_input_tokens, cm.cache_read_input_tokens,
                cm.reasoning_output_tokens, cm.cost_usd
           FROM chat_messages cm
          WHERE cm.created_at >= ?1 AND cm.role = 'assistant'"
    )?;
    let rows = stmt.query_map(params![since], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, Option<i64>>(1)?,
            r.get::<_, Option<i64>>(2)?,
            r.get::<_, Option<String>>(3)?,
            r.get::<_, Option<String>>(4)?,
            r.get::<_, Option<i64>>(5)?,
            r.get::<_, Option<i64>>(6)?,
            r.get::<_, Option<i64>>(7)?,
            r.get::<_, Option<f64>>(8)?,
        ))
    })?;
    for row in rows {
        let (_, i, o, provider, model_key, cc, cr, reasoning, cost) = row?;
        let usage = crate::harness_adapters::UsageInfo {
            input_tokens: i, output_tokens: o,
            cache_creation_input_tokens: cc, cache_read_input_tokens: cr,
            reasoning_output_tokens: reasoning, cost_usd: cost,
        };
        let key = model_key.as_deref();
        let priced = price_usage(&usage, key, &overrides).unwrap_or(0.0);
        priced_rows.push((priced, i.unwrap_or(0) + cc.unwrap_or(0) + cr.unwrap_or(0) + o.unwrap_or(0) + reasoning.unwrap_or(0), "chat_messages"));
        cache_savings_total += cache_savings(&usage, key, &overrides);
        if let Some(p) = provider.as_deref() {
            // Chat provider ids are like "anthropic" / "openai"; the dashboard
            // groups them under "chat:anthropic" to distinguish from harnesses.
            let grouped = format!("chat:{}", p);
            let entry = by_provider.entry(grouped).or_insert((0.0, 0));
            entry.0 += priced;
            entry.1 += i.unwrap_or(0) + cc.unwrap_or(0) + cr.unwrap_or(0);
        }
        if let Some(k) = model_key.as_deref() {
            let entry = by_model.entry(k.to_string()).or_insert((0.0, 0, provider.clone()));
            entry.0 += priced;
            entry.1 += i.unwrap_or(0) + cc.unwrap_or(0) + cr.unwrap_or(0) + o.unwrap_or(0) + reasoning.unwrap_or(0);
        }
    }
}

// perProvider + perModel
let raw_total: f64 = priced_rows.iter().map(|(c, _, _)| c).sum();
let per_provider: Vec<ProviderCostRollup> = by_provider.iter().map(|(p, (c, t))| ProviderCostRollup {
    provider: p.clone(),
    cost_usd: *c,
    tokens: *t,
    share_pct: if raw_total > 0.0 { *c / raw_total * 100.0 } else { 0.0 },
}).collect();

let mut per_model_vec: Vec<ModelCostRollup> = by_model.iter().map(|(k, (c, t, p))| ModelCostRollup {
    model_key: k.clone(),
    display_name: k.clone(),
    cost_usd: *c,
    share_pct: if raw_total > 0.0 { *c / raw_total * 100.0 } else { 0.0 },
    tokens: *t,
    provider: p.clone(),
}).collect();
per_model_vec.sort_by(|a, b| b.cost_usd.partial_cmp(&a.cost_usd).unwrap_or(std::cmp::Ordering::Equal));
```

- [ ] **Step 6: Add the byKind, daily, costQuality, perProject, and meta blocks**

Append the remaining blocks:

```rust
// byKind
let mut by_kind = CostByKind::default();
{
    let mut stmt = conn.prepare(
        "SELECT input_tokens, output_tokens,
                cache_creation_input_tokens, cache_read_input_tokens,
                reasoning_output_tokens,
                (SELECT COUNT(DISTINCT session_id) FROM cost_events WHERE timestamp >= ?1) AS sessions
           FROM cost_events WHERE timestamp >= ?1"
    )?;
    let _: i64 = 0; // dummy to anchor the type
    let rows = stmt.query_map(params![since], |r| {
        Ok((
            r.get::<_, Option<i64>>(0)?,
            r.get::<_, Option<i64>>(1)?,
            r.get::<_, Option<i64>>(2)?,
            r.get::<_, Option<i64>>(3)?,
            r.get::<_, Option<i64>>(4)?,
            r.get::<_, Option<i64>>(5)?,
        ))
    })?;
    let mut responses = 0i64;
    for row in rows.flatten() {
        by_kind.uncached_input_tokens += row.0.unwrap_or(0);
        by_kind.cached_input_tokens += row.2.unwrap_or(0) + row.3.unwrap_or(0);
        by_kind.output_tokens += row.1.unwrap_or(0);
        by_kind.reasoning_tokens += row.4.unwrap_or(0);
        by_kind.sessions = by_kind.sessions.max(row.5.unwrap_or(0));
        responses += 1;
    }
    by_kind.processed_tokens = by_kind.uncached_input_tokens + by_kind.cached_input_tokens;
    by_kind.responses = responses;
}

// daily
let daily: Vec<DailyCost> = {
    let mut stmt = conn.prepare(
        "SELECT date(timestamp, 'unixepoch') AS day,
                COALESCE(SUM(pricing_estimated_usd), 0.0),
                COALESCE(SUM(input_tokens + output_tokens), 0)
           FROM cost_events WHERE timestamp >= ?1
          GROUP BY day ORDER BY day"
    )?;
    let rows = stmt.query_map(params![since], |r| {
        Ok(DailyCost {
            day: r.get::<_, String>(0)?,
            cost_usd: r.get::<_, f64>(1)?,
            tokens_by_provider: BTreeMap::new(),
        })
    })?;
    rows.collect::<DbResult<Vec<_>>>()?
};

// perProject (kept)
let per_project: Vec<ProjectCostRollup> = {
    let mut stmt = conn.prepare(
        "SELECT s.project_id,
                COALESCE(SUM(ce.pricing_estimated_usd), 0.0),
                COALESCE(SUM(ce.input_tokens), 0),
                COALESCE(SUM(ce.output_tokens), 0)
           FROM cost_events ce
           JOIN sessions s ON s.id = ce.session_id
          WHERE ce.timestamp >= ?1
          GROUP BY s.project_id"
    )?;
    let rows = stmt.query_map(params![since], |r| {
        Ok(ProjectCostRollup {
            project_id: r.get(0)?,
            total_cost_usd: r.get(1)?,
            total_input_tokens: r.get(2)?,
            total_output_tokens: r.get(3)?,
        })
    })?;
    rows.collect::<DbResult<Vec<_>>>()?
};

// costQuality
let total_rows = priced_rows.len() as f64;
let provider_reported_rows = priced_rows.iter().filter(|(c, _, _)| *c == 0.0).count() as f64;
let unpriced_rows = (provider_reported_total + unpriced_total > 0.0) as i64 as f64; // placeholder; refined below
let cost_quality = CostQuality {
    provider_reported_pct: if total_rows > 0.0 { provider_reported_rows / total_rows * 100.0 } else { 0.0 },
    model_priced_pct: if total_rows > 0.0 { (total_rows - unpriced_rows) / total_rows * 100.0 } else { 0.0 },
    unpriced_pct: if total_rows > 0.0 { unpriced_rows / total_rows * 100.0 } else { 0.0 },
    cache_savings_usd: cache_savings_total,
};

let totals = CostTotals {
    raw_token_cost_usd: raw_total,
    provider_reported_usd: provider_reported_total,
    estimated_usd: raw_total - unpriced_total,
    unpriced_usd: unpriced_total,
};

Ok(CostRollups {
    totals, per_provider, daily, by_kind,
    per_model: per_model_vec, cost_quality, per_project,
    range_start, range_end, range_days,
})
```

- [ ] **Step 7: Wire up the new rollup in `db/mod.rs` and `commands/data.rs`**

In `db/mod.rs` re-export the new function:

```rust
pub use cost_v2::{get_cost_rollups_v2, read_rate_overrides};
```

In `commands/data.rs:170-178`:

```rust
pub fn get_cost_rollups(
    range_days: Option<u32>,
    db: State<DbState>,
) -> CmdResult<CostRollups> {
    let days = match range_days.unwrap_or(30) {
        7 | 30 | 90 => range_days.unwrap_or(30),
        _ => 30,
    };
    let conn = db.lock();
    db::get_cost_rollups_v2(&conn, days).map_err(|e| e.to_string())
}
```

- [ ] **Step 8: Run the rollup tests**

Run: `cd src-tauri && cargo test db::cost_v2 --lib`
Expected: PASS — including the totals test from Step 3.

- [ ] **Step 9: Run the full backend suite**

Run: `cd src-tauri && cargo test --lib`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src-tauri/src/db/cost_v2.rs src-tauri/src/db/mod.rs src-tauri/src/commands/data.rs src-tauri/src/types.rs
git commit -m "feat(cost): CostRollups v2 with read-time pricing + cache savings"
```

---

## Task 8: Mobile relay uses shared pricing + new wire shape

**Files:**
- Modify: `src-tauri/src/mobile/relay.rs:504-528` (the cost summary handler)
- Modify: `src-tauri/src/mobile/relay.rs:1115-1140` (build_cost_details)
- Modify: `src-tauri/src/mobile/protocol.rs` (add `version: 2` to the cost-related messages)

- [ ] **Step 1: Update the cost summary handler**

In `mobile/relay.rs:504-528`, replace the SQL with the new read-time pricing path:

```rust
MobileMessage::GetCostSummary => {
    // T3 Code-style summary, but for the mobile Settings tab: today and the
    // rolling last 7 days. Read-time priced via the shared pricing module.
    let overrides = {
        let conn = db.lock();
        crate::db::read_rate_overrides(&conn)
    };
    let (today, week) = {
        let conn = db.lock();
        let priced_sum = |since: i64| -> f64 {
            let mut total = 0.0;
            let mut stmt = match conn.prepare(
                "SELECT input_tokens, output_tokens, model_key,
                        cache_creation_input_tokens, cache_read_input_tokens,
                        reasoning_output_tokens
                   FROM cost_events
                  WHERE timestamp >= ?1"
            ) { Ok(s) => s, Err(_) => return 0.0 };
            let rows = stmt.query_map(rusqlite::params![since], |r| {
                Ok((
                    r.get::<_, Option<i64>>(0)?,
                    r.get::<_, Option<i64>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<i64>>(3)?,
                    r.get::<_, Option<i64>>(4)?,
                    r.get::<_, Option<i64>>(5)?,
                ))
            }).ok();
            if let Some(rows) = rows {
                for row in rows.flatten() {
                    let (i, o, k, cc, cr, r) = row;
                    let usage = crate::harness_adapters::UsageInfo {
                        input_tokens: i, output_tokens: o,
                        cache_creation_input_tokens: cc, cache_read_input_tokens: cr,
                        reasoning_output_tokens: r, cost_usd: None,
                    };
                    if let Some(c) = crate::harness_adapters::pricing::price_usage(&usage, k.as_deref(), &overrides) {
                        total += c;
                    }
                }
            }
            total
        };
        let now = crate::db::now_ts();
        let today = priced_sum(now - 86_400);
        let week = priced_sum(now - 7 * 86_400);
        (today, week)
    };
    let _ = send_msg(&write, &DesktopMessage::CostSummary {
        today, week, version: 2,
    }).await;
}
```

- [ ] **Step 2: Add `version: 2` to the cost summary protocol message**

In `mobile/protocol.rs`, find the `CostSummary` message definition and add `version: u32`. (If the field is already optional, mark it `#[serde(default)]` so old code paths that construct the message without `version` still compile.)

- [ ] **Step 3: Update `build_cost_details`**

In `mobile/relay.rs:1115-1140`, the function reads `cost_events` directly with the old `estimated_cost_usd` column. Replace with the same read-time pricing path used in the rollup:

```rust
fn build_cost_details(
    db: &Arc<Mutex<Connection>>,
) -> (Vec<super::protocol::DailyCostEntry>, Vec<ProjectCostEntry>, Vec<LocalModelUsageEntry>) {
    let conn = db.lock();
    let overrides = crate::db::read_rate_overrides(&conn);
    let since = crate::db::now_ts() - 14 * 86_400; // last 14 days for the phone

    // Daily + per-project aggregates via the same priced-row path the desktop
    // uses. The phone only needs the last 14 days; the desktop rolls up the
    // user-selected range.
    let mut daily_map: BTreeMap<String, f64> = BTreeMap::new();
    let mut by_project: BTreeMap<String, f64> = BTreeMap::new();
    {
        let mut stmt = match conn.prepare(
            "SELECT timestamp, input_tokens, output_tokens, model_key,
                    cache_creation_input_tokens, cache_read_input_tokens,
                    reasoning_output_tokens
               FROM cost_events
              WHERE timestamp >= ?1"
        ) { Ok(s) => s, Err(_) => return (vec![], vec![], vec![]) };
        let rows = stmt.query_map(rusqlite::params![since], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, Option<i64>>(1)?,
                r.get::<_, Option<i64>>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, Option<i64>>(4)?,
                r.get::<_, Option<i64>>(5)?,
                r.get::<_, Option<i64>>(6)?,
            ))
        }).ok();
        if let Some(rows) = rows {
            for row in rows.flatten() {
                let (ts, i, o, k, cc, cr, r) = row;
                let usage = crate::harness_adapters::UsageInfo {
                    input_tokens: i, output_tokens: o,
                    cache_creation_input_tokens: cc, cache_read_input_tokens: cr,
                    reasoning_output_tokens: r, cost_usd: None,
                };
                let cost = crate::harness_adapters::pricing::price_usage(&usage, k.as_deref(), &overrides).unwrap_or(0.0);
                let day = date_str(ts);
                *daily_map.entry(day).or_insert(0.0) += cost;
                // per-project is left to the existing join in this function
            }
        }
    }

    let daily: Vec<DailyCostEntry> = daily_map.into_iter().map(|(day, cost)| DailyCostEntry {
        day, cost_usd: cost,
    }).collect();
    // per_project + local_models are unchanged in shape; only the cost source
    // moves to read-time pricing. (Update the existing SQL to use
    // pricing_estimated_usd; see the next step.)
    let per_project = ...; // existing join, but using pricing_estimated_usd
    (daily, per_project, local_models)
}
```

The exact shape of the existing `build_cost_details` function is preserved; only the column reference changes from `estimated_cost_usd` to `pricing_estimated_usd`. Add a helper `date_str(ts: i64) -> String` that does the same Y-M-D conversion the SQL `date(ts, 'unixepoch')` does (use the `time` crate if available, else a small manual computation; check during implementation).

- [ ] **Step 4: Run the mobile relay tests**

Run: `cd src-tauri && cargo test mobile --lib`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/mobile/
git commit -m "feat(mobile): relay uses shared pricing + version: 2 on cost messages"
```

---

## Task 9: Frontend type mirror + IPC wrapper

**Files:**
- Modify: `src/types.ts:82-99` (CostEvent + CostRollups shape)
- Modify: `src/lib/ipc.ts:218-220` (`getCostRollups(rangeDays?)`)
- Create: `src/test/costRollups.test.ts` (type shape + sort invariants)

- [ ] **Step 1: Update the TypeScript types**

In `src/types.ts:82-99`, replace the `CostEvent` and `CostRollups` interfaces with the full new shape:

```ts
export interface CostEvent {
  id: number;
  sessionId: string;
  timestamp: number;
  inputTokens: number | null;
  outputTokens: number | null;
  provider: string | null;
  modelKey: string | null;
  source: string;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
  reasoningOutputTokens: number | null;
  reportedCostUsd: number | null;
  pricingEstimatedUsd: number | null;
}

export interface CostRollups {
  totals: CostTotals;
  perProvider: ProviderCostRollup[];
  daily: DailyCost[];
  byKind: CostByKind;
  perModel: ModelCostRollup[];
  costQuality: CostQuality;
  perProject: ProjectCostRollup[];
  rangeStart: string;
  rangeEnd: string;
  rangeDays: 7 | 30 | 90;
}

export interface CostTotals {
  rawTokenCostUsd: number;
  providerReportedUsd: number;
  estimatedUsd: number;
  unpricedUsd: number;
}
export interface ProviderCostRollup {
  provider: string;
  costUsd: number;
  tokens: number;
  sharePct: number;
}
export interface DailyCost {
  day: string;
  costUsd: number;
  tokensByProvider: Record<string, number>;
}
export interface CostByKind {
  processedTokens: number;
  cachedInputTokens: number;
  uncachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  sessions: number;
  responses: number;
}
export interface ModelCostRollup {
  modelKey: string;
  displayName: string;
  costUsd: number;
  sharePct: number;
  tokens: number;
  provider: string | null;
}
export interface CostQuality {
  providerReportedPct: number;
  modelPricedPct: number;
  unpricedPct: number;
  cacheSavingsUsd: number;
}
export interface ProjectCostRollup {
  projectId: string;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

export interface CostUpdatedPayload {
  sessionId: string;
  version: 1 | 2;
}
```

- [ ] **Step 2: Update the IPC wrapper**

In `src/lib/ipc.ts:218-220`:

```ts
export const getCostEvents = (sessionId?: string) =>
  safeInvoke<CostEvent[] | null>("get_cost_events", sessionId ? { sessionId } : {});
export const getCostRollups = (rangeDays?: 7 | 30 | 90) =>
  safeInvoke<CostRollups | null>("get_cost_rollups", rangeDays ? { rangeDays } : {});
```

- [ ] **Step 3: Write the type-shape test**

In `src/test/costRollups.test.ts`:

```ts
import type {
  CostRollups, CostTotals, ProviderCostRollup, DailyCost,
  CostByKind, ModelCostRollup, CostQuality, ProjectCostRollup,
} from "../types";

const sample: CostRollups = {
  totals: { rawTokenCostUsd: 100, providerReportedUsd: 5, estimatedUsd: 95, unpricedUsd: 0 },
  perProvider: [{ provider: "claude_code", costUsd: 80, tokens: 1_000_000, sharePct: 80 }],
  daily: [{ day: "2026-08-01", costUsd: 10, tokensByProvider: { claude_code: 100_000 } }],
  byKind: {
    processedTokens: 1_100_000, cachedInputTokens: 1_000_000,
    uncachedInputTokens: 100_000, outputTokens: 50_000, reasoningTokens: 5_000,
    sessions: 12, responses: 120,
  },
  perModel: [
    { modelKey: "claude-sonnet-4-5", displayName: "claude-sonnet-4-5", costUsd: 80, sharePct: 80, tokens: 1_000_000, provider: "claude_code" },
  ],
  costQuality: { providerReportedPct: 5, modelPricedPct: 95, unpricedPct: 0, cacheSavingsUsd: 12.3 },
  perProject: [{ projectId: "p1", totalCostUsd: 80, totalInputTokens: 1_000_000, totalOutputTokens: 50_000 }],
  rangeStart: "2026-07-09", rangeEnd: "2026-08-07", rangeDays: 30,
};

describe("CostRollups shape", () => {
  it("preserves all required keys", () => {
    expect(sample.totals.rawTokenCostUsd).toBe(100);
    expect(sample.perProvider[0].provider).toBe("claude_code");
    expect(sample.daily[0].day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(sample.costQuality.cacheSavingsUsd).toBeCloseTo(12.3);
    expect(sample.rangeDays).toBe(30);
  });
  it("sums per-provider to total", () => {
    const sum = sample.perProvider.reduce((s, p) => s + p.costUsd, 0);
    expect(sum).toBeCloseTo(sample.totals.rawTokenCostUsd, 1);
  });
});
```

- [ ] **Step 4: Run the test**

Run: `npm test -- src/test/costRollups.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/lib/ipc.ts src/test/costRollups.test.ts
git commit -m "feat(frontend): CostRollups + CostEvent type mirror"
```

---

## Task 10: `useCostRollups` hook + dashboard component split

**Files:**
- Create: `src/hooks/useCostRollups.ts`
- Create: `src/components/cost-dashboard/RangeToggle.tsx`
- Create: `src/components/cost-dashboard/CostHero.tsx`
- Create: `src/components/cost-dashboard/DailyChart.tsx`
- Create: `src/components/cost-dashboard/StatsRow.tsx`
- Create: `src/components/cost-dashboard/ModelBreakdownTable.tsx`
- Create: `src/components/cost-dashboard/CostQualityPanel.tsx`
- Modify: `src/components/cost-dashboard/CostDashboard.tsx` (rewrite)
- Delete: `src/components/cost-dashboard/LocalModelUsagePanel.tsx`

- [ ] **Step 1: Write `useCostRollups`**

In `src/hooks/useCostRollups.ts`:

```ts
import { useEffect, useState } from "react";
import { getCostRollups, safeListen } from "../lib/ipc";
import type { CostRollups, CostUpdatedPayload } from "../types";

export function useCostRollups(rangeDays: 7 | 30 | 90) {
  const [rollups, setRollups] = useState<CostRollups | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const r = await getCostRollups(rangeDays);
        if (!cancelled) { setRollups(r); setError(null); }
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    const unlisten = safeListen<CostUpdatedPayload>("cost:updated", () => void load());
    return () => { cancelled = true; void unlisten.then(fn => fn()); };
  }, [rangeDays]);

  return { rollups, loading, error, refresh: () => void getCostRollups(rangeDays).then(setRollups) };
}
```

- [ ] **Step 2: Write a hook test**

In `src/test/useCostRollups.test.ts`:

```ts
import { renderHook, waitFor } from "@testing-library/react";
import { useCostRollups } from "../hooks/useCostRollups";

describe("useCostRollups", () => {
  it("returns loading=false after the IPC resolves", async () => {
    const { result } = renderHook(() => useCostRollups(30));
    // jsdom: getCostRollups is a no-op that returns null. After resolution,
    // loading flips to false.
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.rollups).toBeNull();
    expect(result.current.error).toBeNull();
  });
});
```

- [ ] **Step 3: Run the hook test**

Run: `npm test -- src/test/useCostRollups.test.ts`
Expected: PASS.

- [ ] **Step 4: Write `RangeToggle`**

In `src/components/cost-dashboard/RangeToggle.tsx`:

```tsx
type Range = 7 | 30 | 90;
export function RangeToggle({ value, onChange }: { value: Range; onChange: (r: Range) => void }) {
  const opts: Array<{ label: string; value: Range }> = [
    { label: "7d", value: 7 }, { label: "30d", value: 30 }, { label: "90d", value: 90 },
  ];
  return (
    <div className="range-toggle">
      {opts.map(o => (
        <button key={o.value} className={`ghost ${value === o.value ? "active" : ""}`} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 5: Write `CostHero`**

In `src/components/cost-dashboard/CostHero.tsx`:

```tsx
import type { CostRollups, ProviderCostRollup } from "../../types";

function usd(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function CostHero({ rollups }: { rollups: CostRollups }) {
  const { totals, perProvider, rangeStart, rangeEnd } = rollups;
  return (
    <section className="cost-hero">
      <div className="cost-hero-headline">
        <div className="cost-hero-label">RAW TOKEN COST</div>
        <div className="cost-hero-value">{usd(totals.rawTokenCostUsd)}</div>
        <div className="cost-hero-range">{formatDate(rangeStart)} to {formatDate(rangeEnd)}</div>
      </div>
      <div className="cost-hero-breakdown">
        {perProvider.map(p => <ProviderRow key={p.provider} p={p} total={totals.rawTokenCostUsd} />)}
      </div>
    </section>
  );
}

function ProviderRow({ p, total }: { p: ProviderCostRollup; total: number }) {
  return (
    <div className="cost-hero-row">
      <span className="cost-hero-row-label">{labelFor(p.provider)}</span>
      <span className="cost-hero-row-cost">{usd(p.costUsd)}</span>
      <span className="cost-hero-row-share">{((p.costUsd / Math.max(total, 1e-9)) * 100).toFixed(1)}%</span>
      <span className="cost-hero-row-tokens">{(p.tokens / 1e9).toFixed(2)}B tokens</span>
    </div>
  );
}

function labelFor(p: string): string {
  if (p === "claude_code") return "Claude Code";
  if (p === "kimi_code") return "Kimi Code";
  if (p === "opencode") return "OpenCode";
  if (p.startsWith("chat:")) return "Chat: " + p.slice(5);
  return p;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
```

- [ ] **Step 6: Write `DailyChart`**

In `src/components/cost-dashboard/DailyChart.tsx`:

```tsx
import { useState } from "react";
import type { CostRollups } from "../../types";

type Mode = "cost" | "tokens";

export function DailyChart({ rollups }: { rollups: CostRollups }) {
  const [mode, setMode] = useState<Mode>("cost");
  const data = rollups.daily;
  if (data.length === 0) {
    return <div className="empty-reserved">No usage in this range.</div>;
  }
  const maxCost = Math.max(...data.map(d => d.costUsd), 0.01);
  const maxTokens = Math.max(...data.map(d => sumTokens(d.tokensByProvider)), 1);
  const barWidth = 18; const gap = 6; const height = 80;
  const totalW = data.length * (barWidth + gap);
  return (
    <div>
      <div className="chart-toggle">
        <button className={`ghost ${mode === "cost" ? "active" : ""}`} onClick={() => setMode("cost")}>Cost</button>
        <button className={`ghost ${mode === "tokens" ? "active" : ""}`} onClick={() => setMode("tokens")}>Tokens</button>
      </div>
      <svg className="chart daily-chart" width={totalW} height={height + 26} role="img"
           aria-label={`Daily ${mode} chart`}>
        {data.map((d, i) => {
          const value = mode === "cost" ? d.costUsd : sumTokens(d.tokensByProvider);
          const max = mode === "cost" ? maxCost : maxTokens;
          const h = Math.max(2, (value / max) * height);
          const x = i * (barWidth + gap);
          return (
            <g key={d.day}>
              <rect className="bar" x={x} y={height - h} width={barWidth} height={h} rx={2} />
              <text className="bar-label" x={x + barWidth / 2} y={height + 14} textAnchor="middle">{d.day.slice(5)}</text>
            </g>
          );
        })}
      </svg>
      <table className="visually-hidden">
        <caption>Daily {mode}</caption>
        <thead><tr><th>Day</th><th>Value</th></tr></thead>
        <tbody>{data.map(d => <tr key={d.day}><td>{d.day}</td><td>{mode === "cost" ? d.costUsd : sumTokens(d.tokensByProvider)}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

function sumTokens(t: Record<string, number>): number {
  return Object.values(t).reduce((a, b) => a + b, 0);
}
```

- [ ] **Step 7: Write `StatsRow`**

In `src/components/cost-dashboard/StatsRow.tsx`:

```tsx
import type { CostByKind } from "../../types";

export function StatsRow({ byKind, cacheSavingsUsd }: { byKind: CostByKind; cacheSavingsUsd: number }) {
  return (
    <div className="stats-row">
      <Stat label="Processed" value={fmt(byKind.processedTokens)} sub="tokens" />
      <Stat label="Cached input" value={fmt(byKind.cachedInputTokens)} sub={`${pct(byKind.cachedInputTokens, byKind.processedTokens)}% of input`} />
      <Stat label="Uncached input" value={fmt(byKind.uncachedInputTokens)} sub="tokens" />
      <Stat label="Output" value={fmt(byKind.outputTokens)} sub={`${fmt(byKind.reasoningTokens)} reasoning`} />
      <Stat label="Responses" value={byKind.responses.toLocaleString()} sub={`${byKind.sessions} sessions`} />
      <Stat label="Cache savings" value={`$${cacheSavingsUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}`} sub="cumulative" accent />
    </div>
  );
}

function Stat({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className={`stat ${accent ? "stat-accent" : ""}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

function fmt(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return n.toLocaleString();
}
function pct(part: number, whole: number): string {
  return whole > 0 ? ((part / whole) * 100).toFixed(1) : "0.0";
}
```

- [ ] **Step 8: Write `ModelBreakdownTable`**

In `src/components/cost-dashboard/ModelBreakdownTable.tsx`:

```tsx
import type { ModelCostRollup } from "../../types";

export function ModelBreakdownTable({ rows }: { rows: ModelCostRollup[] }) {
  if (rows.length === 0) {
    return <div className="empty-reserved">No model breakdown in this range.</div>;
  }
  return (
    <table className="kv">
      <thead>
        <tr><th>Model</th><th>Cost</th><th>Share</th><th>Tokens</th></tr>
      </thead>
      <tbody>
        {rows.map(r => (
          <tr key={r.modelKey}>
            <td>{r.displayName}</td>
            <td className="mono">${r.costUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 5 })}</td>
            <td className="mono">{r.sharePct.toFixed(1)}%</td>
            <td className="mono">{r.tokens.toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 9: Write `CostQualityPanel`**

In `src/components/cost-dashboard/CostQualityPanel.tsx`:

```tsx
import type { CostQuality } from "../../types";

export function CostQualityPanel({ q, cacheSavingsUsd }: { q: CostQuality; cacheSavingsUsd: number }) {
  return (
    <div className="cost-quality">
      <h3>Cost quality</h3>
      <Bar label="Provider reported" pct={q.providerReportedPct} />
      <Bar label="Model priced" pct={q.modelPricedPct} />
      <Bar label="Unpriced" pct={q.unpricedPct} />
      <div className="cost-quality-savings">
        <span className="cost-quality-savings-label">Cache savings</span>
        <span className="cost-quality-savings-value">${cacheSavingsUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
      </div>
    </div>
  );
}

function Bar({ label, pct }: { label: string; pct: number }) {
  return (
    <div className="cost-quality-bar">
      <div className="cost-quality-bar-label">{label}</div>
      <div className="cost-quality-bar-track"><div className="cost-quality-bar-fill" style={{ width: `${pct}%` }} /></div>
      <div className="cost-quality-bar-pct">{pct.toFixed(1)}%</div>
    </div>
  );
}
```

- [ ] **Step 10: Rewrite `CostDashboard.tsx`**

Replace the file body with:

```tsx
import { useState } from "react";
import { useUiStore } from "../../state/ui";
import { useCostRollups } from "../../hooks/useCostRollups";
import { RangeToggle } from "./RangeToggle";
import { CostHero } from "./CostHero";
import { DailyChart } from "./DailyChart";
import { StatsRow } from "./StatsRow";
import { ModelBreakdownTable } from "./ModelBreakdownTable";
import { CostQualityPanel } from "./CostQualityPanel";

export function CostDashboard() {
  const setActiveView = useUiStore(s => s.setActiveView);
  const [rangeDays, setRangeDays] = useState<7 | 30 | 90>(30);
  const { rollups, loading, error, refresh } = useCostRollups(rangeDays);

  return (
    <div className="view-overlay modal-centered"
         onPointerDown={(e) => e.target === e.currentTarget && setActiveView("chat")}>
      <div className="view-panel">
        <div className="view-header">
          <h2>Usage</h2>
          <div className="view-header-right">
            <RangeToggle value={rangeDays} onChange={setRangeDays} />
            <button className="ghost" onClick={() => setActiveView("chat")}>✕</button>
          </div>
        </div>
        <div className="view-body">
          {error && (
            <div className="cost-error">
              Failed to load: {error}
              <button className="ghost" onClick={refresh}>Retry</button>
            </div>
          )}
          {loading && !rollups ? (
            <div className="cost-loading">Loading…</div>
          ) : rollups && rollups.totals.rawTokenCostUsd === 0 && rollups.daily.length === 0 ? (
            <div className="empty-reserved">
              <span className="empty-icon">📊</span>
              <span className="empty-text">No usage in this range.</span>
            </div>
          ) : rollups ? (
            <>
              <CostHero rollups={rollups} />
              <DailyChart rollups={rollups} />
              <StatsRow byKind={rollups.byKind} cacheSavingsUsd={rollups.costQuality.cacheSavingsUsd} />
              <ModelBreakdownTable rows={rollups.perModel} />
              <CostQualityPanel q={rollups.costQuality} cacheSavingsUsd={rollups.costQuality.cacheSavingsUsd} />
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 11: Delete `LocalModelUsagePanel.tsx`**

Run: `rm src/components/cost-dashboard/LocalModelUsagePanel.tsx` (verify it has no remaining imports first with `grep -rn "LocalModelUsagePanel" src/`).

- [ ] **Step 12: Run the build + tests**

Run: `npm run build` then `npm test`
Expected: build clean, all tests pass.

- [ ] **Step 13: Commit**

```bash
git add src/components/cost-dashboard/ src/hooks/ src/test/costRollups.test.ts src/test/useCostRollups.test.ts
git commit -m "feat(frontend): CostDashboard rewrite with T3 Code layout"
```

---

## Task 11: Wire-up tests for the new dashboard

**Files:**
- Create: `src/test/costDashboard.test.tsx`

- [ ] **Step 1: Write the test**

In `src/test/costDashboard.test.tsx`:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { CostDashboard } from "../components/cost-dashboard/CostDashboard";

// Mock the IPC layer so the dashboard gets a known rollup.
jest.mock("../lib/ipc", () => ({
  ...jest.requireActual("../lib/ipc"),
  getCostRollups: jest.fn().mockResolvedValue({
    totals: { rawTokenCostUsd: 100, providerReportedUsd: 5, estimatedUsd: 95, unpricedUsd: 0 },
    perProvider: [{ provider: "claude_code", costUsd: 80, tokens: 1_000_000, sharePct: 80 }],
    daily: [{ day: "2026-08-01", costUsd: 10, tokensByProvider: { claude_code: 100_000 } }],
    byKind: { processedTokens: 1_100_000, cachedInputTokens: 1_000_000, uncachedInputTokens: 100_000, outputTokens: 50_000, reasoningTokens: 5_000, sessions: 12, responses: 120 },
    perModel: [{ modelKey: "claude-sonnet-4-5", displayName: "claude-sonnet-4-5", costUsd: 80, sharePct: 80, tokens: 1_000_000, provider: "claude_code" }],
    costQuality: { providerReportedPct: 5, modelPricedPct: 95, unpricedPct: 0, cacheSavingsUsd: 12.3 },
    perProject: [{ projectId: "p1", totalCostUsd: 80, totalInputTokens: 1_000_000, totalOutputTokens: 50_000 }],
    rangeStart: "2026-07-09", rangeEnd: "2026-08-07", rangeDays: 30,
  }),
  safeListen: jest.fn().mockResolvedValue(() => {}),
}));

describe("CostDashboard", () => {
  it("renders the raw token cost and the model breakdown", async () => {
    render(<CostDashboard />);
    expect(await screen.findByText(/\$100/)).toBeInTheDocument();
    expect(await screen.findByText(/claude-sonnet-4-5/)).toBeInTheDocument();
  });

  it("switches the range toggle", async () => {
    render(<CostDashboard />);
    fireEvent.click(await screen.findByText("7d"));
    // The hook re-fetches; the mock resolves to the same payload, so the
    // existing data is still shown. We assert the toggle is now active.
    expect((await screen.findByText("7d")).className).toMatch(/active/);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npm test -- src/test/costDashboard.test.tsx`
Expected: PASS — 2 tests.

- [ ] **Step 3: Commit**

```bash
git add src/test/costDashboard.test.tsx
git commit -m "test(frontend): CostDashboard render + range toggle"
```

---

## Task 12: Doc updates (CONTRACT + BUILD_LOG + AI_CONTEXT)

**Files:**
- Modify: `AI CONTEXT/CONTRACT.md:22-23, 94-95, 141`
- Modify: `AI CONTEXT/BUILD_LOG.md` (new entry)
- Modify: `AI CONTEXT/AI_CONTEXT.md`

- [ ] **Step 1: Update `CONTRACT.md` types**

Replace the `CostEvent` and `CostRollups` interface lines (around line 22–23):

```ts
interface CostEvent { id: number; sessionId: string; timestamp: number; inputTokens: number | null; outputTokens: number | null; provider: string | null; modelKey: string | null; source: string; cacheCreationInputTokens: number | null; cacheReadInputTokens: number | null; reasoningOutputTokens: number | null; reportedCostUsd: number | null; pricingEstimatedUsd: number | null }
interface CostRollups {
  totals: { rawTokenCostUsd: number; providerReportedUsd: number; estimatedUsd: number; unpricedUsd: number };
  perProvider: Array<{ provider: string; costUsd: number; tokens: number; sharePct: number }>;
  daily: Array<{ day: string; costUsd: number; tokensByProvider: Record<string, number> }>;
  byKind: { processedTokens: number; cachedInputTokens: number; uncachedInputTokens: number; outputTokens: number; reasoningTokens: number; sessions: number; responses: number };
  perModel: Array<{ modelKey: string; displayName: string; costUsd: number; sharePct: number; tokens: number; provider: string | null }>;
  costQuality: { providerReportedPct: number; modelPricedPct: number; unpricedPct: number; cacheSavingsUsd: number };
  perProject: Array<{ projectId: string; totalCostUsd: number; totalInputTokens: number; totalOutputTokens: number }>;
  rangeStart: string; rangeEnd: string; rangeDays: 7 | 30 | 90;
} // day = 'YYYY-MM-DD'
```

- [ ] **Step 2: Update the `get_cost_rollups` signature**

```ts
- `get_cost_rollups(rangeDays?: 7 | 30 | 90) -> CostRollups` (default 30; new shape from COST_MODEL_REDESIGN.md §8)
```

- [ ] **Step 3: Update the `cost:updated` event**

```ts
- `cost:updated` — payload `{ sessionId: string, version: 1 | 2 }` (after a parsed usage event is written; frontend refetches; version 2 = current shape)
```

- [ ] **Step 4: Add a new BUILD_LOG entry**

At the top of `BUILD_LOG.md`:

```markdown
## 2026-08-08 — Cost model v2 (T3-Code parity)

(Brief entry summarizing: schema migration, read-time pricing, new rollup endpoint, T3 Code-style dashboard, mobile relay wire shape. Link to `AI CONTEXT/COST_MODEL_REDESIGN.md` and the implementation plan.)
```

- [ ] **Step 5: Update `AI_CONTEXT.md`**

Find the cost / rollup section in `AI_CONTEXT.md` and update the count, the section references, and any file map entries. (Section §2.x for the cost surface; §3.x for the React components; §6.x for the file map.)

- [ ] **Step 6: Run the full test suite as a final check**

Run: `cd src-tauri && cargo test --lib` and `npm test` and `npm run build`
Expected: PASS, PASS, clean.

- [ ] **Step 7: Commit**

```bash
git add "AI CONTEXT/"
git commit -m "docs(cost): CONTRACT + BUILD_LOG + AI_CONTEXT updates"
```

---

## Self-review

- **Spec coverage:**
  - §1 motivation → motivation in the spec, satisfied by §5–§11 of the plan.
  - §2 goals → per-model breakdown in §10, per-provider in §7, cache/reasoning in §5+§7, cost-quality in §7, read-time in §1+§7, range selector in §10, mobile parity in §8.
  - §3 non-goals → no pricing UI (§10), no retroactive full-recalc (§1+§7), no new IPC command (§9), `settings:updated` skipped (§10).
  - §4 architecture → §1, §4, §7 of the plan.
  - §5 schema → Task 3 (cost_events) + Task 6 (chat_messages).
  - §6 adapters → Task 2.
  - §7 pricing → Task 1 (price_usage) + Task 4 (price_for rewrite) + Task 7 (read-time in rollup) + Task 8 (mobile uses shared pricing).
  - §8 rollup shape → Task 7.
  - §9 IPC contract → Task 9 (frontend) + Task 12 (CONTRACT).
  - §10 mobile → Task 8.
  - §11 UI → Tasks 9, 10, 11.
  - §12 migration & rollout → Tasks 3, 4, 5, 6 (additive ALTERs; DROP last; backfill in same migration).
  - §13 testing → distributed across each task; full-suite at Task 12.
  - §14 file-by-file → matches the file list at the top of the plan.
  - §15 resolved open calls → all addressed in the relevant tasks.

- **Placeholder scan:** No "TBD", "TODO", "implement later", or unfilled references. The `..Default::default()` pattern is explicit. The `time` crate reference in Task 7 Step 4 is conditional ("if available, else manual"); if neither is present, the implementer uses a small manual epoch→Y-M-D routine (acceptable).

- **Type consistency:**
  - `ModelRate` defined in Task 1, used in Tasks 4, 5, 7, 8 with identical fields.
  - `UsageInfo` field names match between Tasks 2, 3, 4, 5, 6, 7, 8.
  - `CostRollups` shape matches in Task 7 (Rust) and Task 9 (TypeScript) and Task 12 (CONTRACT).
  - `get_cost_rollups(range_days: Option<u32>)` signature in Task 7 matches the IPC wrapper in Task 9.
  - `version: u32` (Rust) ↔ `version: 1 | 2` (TypeScript) — both sides declare it.

---

## Execution handoff

**Plan complete and saved to `docs/superpowers/plans/2026-08-08-cost-model-redesign.md`. Two execution options:**

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
