CREATE TABLE IF NOT EXISTS operators (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  normalized_username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_version INTEGER NOT NULL DEFAULT 1 CHECK (password_version > 0),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at TIMESTAMPTZ,
  password_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (normalized_username = LOWER(normalized_username)),
  CHECK (CHAR_LENGTH(normalized_username) BETWEEN 3 AND 64)
);

CREATE TABLE IF NOT EXISTS operator_sessions (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE CHECK (CHAR_LENGTH(token_hash) = 64),
  csrf_token_hash TEXT NOT NULL CHECK (CHAR_LENGTH(csrf_token_hash) = 64),
  client_label TEXT,
  client_fingerprint TEXT CHECK (client_fingerprint IS NULL OR CHAR_LENGTH(client_fingerprint) = 64),
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  revoke_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (expires_at > created_at),
  CHECK ((revoked_at IS NULL AND revoke_reason IS NULL) OR revoked_at IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS operator_login_rate_limits (
  key_hash TEXT PRIMARY KEY CHECK (CHAR_LENGTH(key_hash) = 64),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  blocked_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS operator_sessions_operator_idx
  ON operator_sessions(operator_id, created_at DESC);
CREATE INDEX IF NOT EXISTS operator_sessions_active_idx
  ON operator_sessions(token_hash, expires_at)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS operator_sessions_expiry_idx
  ON operator_sessions(expires_at)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS operator_login_rate_limits_updated_idx
  ON operator_login_rate_limits(updated_at);
