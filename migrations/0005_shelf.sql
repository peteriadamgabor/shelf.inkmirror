-- The Shelf — Phase 3 listing lifecycle.
--
-- listing_state: NULL (never requested) | 'pending' (gate running) |
--   'listed' | 'refused' | 'held' (human decision needed).
--   Invariant: listed = 1 iff listing_state = 'listed'.
--
-- listed_at: ISO timestamp of the moment the work went onto the shelf —
--   /shelf sorts by it (recency, never popularity).
--
-- listing_verdict: compact JSON, the gate outcome shown to the AUTHOR
--   (unlike moderation_verdict, which is operator-facing):
--   { reason: 'labels', suggested?: { rating, warnings } }  chain says under-labeled
--   { reason: 'review' }                                    hard-line hold, human deciding
--   { reason: 'error' }                                     chain failed — human decides
--   { reason: 'manual' }                                    no API key — human decides
--   { reason: 'operator' }                                  operator denied

ALTER TABLE works ADD COLUMN listing_state TEXT;
ALTER TABLE works ADD COLUMN listed_at TEXT;
ALTER TABLE works ADD COLUMN listing_verdict TEXT;

-- The /shelf browse query: listed + active, newest listing first.
CREATE INDEX idx_works_shelf ON works (listed, status, listed_at);
