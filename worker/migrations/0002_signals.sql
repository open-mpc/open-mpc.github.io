-- Community signals tables. They reference Better Auth's "user" table (migrations/0001_auth.sql), so one person is one row and
-- deleting the account removes their likes and reports. "hidden" lets a maintainer drop a user's counts without deleting them.
ALTER TABLE "user" ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1));

CREATE TABLE likes (
  plugin_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (plugin_id, user_id)
);

CREATE TABLE working_reports (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  plugin_id TEXT NOT NULL,
  version TEXT NOT NULL,
  device TEXT NOT NULL,
  os TEXT NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, plugin_id, version, device, os)
);
-- D1's free plan fails queries past 5M rows read a day: the grouped count queries must use these indexes.
CREATE INDEX reports_plugin ON working_reports (plugin_id, hidden, version, user_id);
CREATE INDEX reports_user ON working_reports (user_id, created_at);
CREATE INDEX likes_plugin ON likes (plugin_id);
CREATE INDEX likes_user ON likes (user_id, created_at);
