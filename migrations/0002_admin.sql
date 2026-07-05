-- The Shelf — Phase 1.5 operator toolkit.
--
-- removed_at: set when an operator removes a work (status='removed'); the
-- row + R2 objects survive a 30-day grace window (restore stays possible),
-- then the daily purge evaporates them.
--
-- reports: every accepted reader report is mirrored here (Discord remains
-- the notification channel, D1 is the durable record). NOTHING about the
-- reporter is stored — no IP, no hash, no fingerprint, by decision.
--
-- tombstones: content hashes of removed works that must not come back.
-- The hash covers block contents only (see src/worker/lib/content-hash.ts),
-- so a re-upload under a new title/pen-name still matches.
--
-- settings: single-row-per-key operator switches ('publishing_paused' = '1').

ALTER TABLE works ADD COLUMN removed_at TEXT;  -- NULL unless status='removed'

CREATE TABLE reports (
  id         TEXT PRIMARY KEY,
  work_id    TEXT NOT NULL,
  reason     TEXT NOT NULL,
  message    TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_reports_work ON reports (work_id);

CREATE TABLE tombstones (
  content_hash TEXT PRIMARY KEY,
  work_title   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  note         TEXT NOT NULL DEFAULT ''
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
