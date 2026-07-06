-- The Shelf — API-spend budget guards for the moderation chain.
--
-- content_hash: sha256 over the published prose (block contents only, in
-- reading order — the exact tombstone recipe, src/worker/lib/content-hash.ts),
-- stored at publish/update time. Lets an identical-prose update skip the
-- shadow chain, and lets the listing gate reuse a still-fresh verdict
-- instead of paying for a second run on the same text.
--
-- NULL = published before this migration. Treated as "unknown, run the
-- chain" — hashes populate on the next publish/update, no backfill needed.
--
-- The global daily run counter needs no schema of its own: it lives in the
-- existing settings table under chain_runs_{YYYY-MM-DD} (UTC date).

ALTER TABLE works ADD COLUMN content_hash TEXT;
