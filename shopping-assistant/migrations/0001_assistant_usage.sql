-- Shopping assistant (POST /asistente) usage counters, for its daily
-- limits. `key` is a SHA-256 of the day plus either the caller's IP
-- (per-visitor limit) or a fixed word (store-wide limit): no IP or
-- other personal data is stored. Rows older than two days are pruned
-- by the cron (pruneAssistantUsage).
CREATE TABLE assistant_usage (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
