-- Cost model v2 (COST_MODEL_REDESIGN.md §5.1).
-- Additive: every ALTER is a no-op if the column already exists.

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
