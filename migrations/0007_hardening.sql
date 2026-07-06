-- The Shelf — security hardening: bind moderation verdicts to the exact
-- artifact they reviewed.
--
-- verdict_fingerprint = `${content_hash}|${rating}|${sorted,normalized
-- warnings joined ','}` of the bundle the chain ACTUALLY reviewed. The
-- listing gate reuses a stored verdict only when this fingerprint exactly
-- matches the fingerprint of the CURRENT stored bundle + labels — so an
-- update-then-list can never ride a verdict earned by different content or
-- different labels (the central listing-integrity rule).
--
-- NULL = no verdict, or a verdict written before this migration: treated as
-- "no reusable observation", so the gate runs the chain.

ALTER TABLE works ADD COLUMN verdict_fingerprint TEXT;
