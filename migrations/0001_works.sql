-- The Shelf — works table (Phase 1).
-- Forward-compat columns (password_hash, views, letters_open, listed) are
-- included per the design spec so later phases need no migration.

CREATE TABLE works (
  id            TEXT PRIMARY KEY,
  secret_hash   TEXT NOT NULL,
  title         TEXT NOT NULL,
  pen_name      TEXT NOT NULL,
  language      TEXT NOT NULL,
  rating        TEXT NOT NULL CHECK (rating IN ('general','mature','explicit')),
  warnings      TEXT NOT NULL DEFAULT '[]',   -- JSON array
  word_count    INTEGER NOT NULL,
  first_line    TEXT NOT NULL DEFAULT '',     -- shelf card teaser (Phase 3)
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','held','removed')),
  listed        INTEGER NOT NULL DEFAULT 0,   -- Phase 3
  password_hash TEXT,                         -- NULL = no password gate
  views         INTEGER NOT NULL DEFAULT 0,   -- opens, author-only
  letters_open  INTEGER NOT NULL DEFAULT 1,   -- author's "accept letters" toggle
  report_count  INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL
);

-- Daily purge scans by expiry; listed works are exempt while listed.
CREATE INDEX idx_works_expires ON works (expires_at, listed);
