-- The Shelf — letters to the author.
--
-- One-way, private reader→writer mail (not comments: no threads, no public
-- trace). NOTHING about the sender is stored beyond what they typed — no IP,
-- no hash, no fingerprint, matching the reports privacy stance. `contact` is
-- the reader's optional "answer me here" line, free text.
--
-- Letters are the author's private correspondence: readable/deletable only
-- with the manage secret, never forwarded to Discord, never exposed to the
-- admin surface. Deleting a work (unpublish, purge, admin removal past
-- grace) deletes its letters with it — same hygiene as reports.

CREATE TABLE letters (
  id         TEXT PRIMARY KEY,
  work_id    TEXT NOT NULL,
  body       TEXT NOT NULL,              -- cap 4000 chars, server-enforced
  contact    TEXT NOT NULL DEFAULT '',   -- cap 200 chars, optional
  created_at TEXT NOT NULL
);
CREATE INDEX idx_letters_work ON letters (work_id);
