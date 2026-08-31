CREATE TABLE chat_daily_usage (
  token_id TEXT NOT NULL REFERENCES access_tokens(id) ON DELETE CASCADE,
  usage_date TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0 CHECK (used >= 0),
  PRIMARY KEY (token_id, usage_date)
);
