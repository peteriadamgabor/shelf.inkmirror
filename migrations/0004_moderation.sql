-- The Shelf — Phase 2 moderation chain (SHADOW MODE).
--
-- moderation_verdict: compact JSON string written by the background chain
-- after a publish/update — { outcome, truncated, flaggedChunks, suggested?,
-- reason?, model, ms }. NULL = the chain has not run (no API key configured,
-- work too small, or published before Phase 2).
--
-- moderation_at: ISO timestamp of the verdict write.
--
-- In shadow mode the verdict is observational only: it never blocks a
-- publish, and non-pass outcomes only ping Discord. Flipping shadow → gate
-- is Phase 3's job.

ALTER TABLE works ADD COLUMN moderation_verdict TEXT;
ALTER TABLE works ADD COLUMN moderation_at TEXT;
