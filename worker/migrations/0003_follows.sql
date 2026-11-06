-- Follow a plugin to hear about its releases. People read them in a personal Atom feed (GET /feed/<token>.xml): the address carries a secret
-- token, so a feed reader needs no sign-in. "Regenerate" rotates the token; deleting the account removes the follows and the token.
CREATE TABLE follows (
  plugin_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, plugin_id)
);
CREATE INDEX follows_user ON follows (user_id, created_at);

CREATE TABLE feed_tokens (
  user_id TEXT PRIMARY KEY REFERENCES "user" (id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
