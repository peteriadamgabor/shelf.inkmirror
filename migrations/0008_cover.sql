-- 0008_cover.sql — optional author cover image.
--
-- The bytes live in R2 at works/{id}/cover; D1 only records the mime so the
-- gallery card knows a cover EXISTS without reading the bundle. NULL = no
-- cover (fall back to the generated CSS cover). Existing rows default to NULL.
ALTER TABLE works ADD COLUMN cover_mime TEXT;
