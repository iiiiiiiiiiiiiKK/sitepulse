-- SitePulse schema (Cloudflare D1 / SQLite dialect)
-- Apply with: npm run db:remote  (or db:local for the local dev database)

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  email          TEXT NOT NULL,
  email_norm     TEXT NOT NULL,                    -- lowercased, unique index below
  password_hash  TEXT NOT NULL,                    -- PBKDF2-SHA256, base64
  password_salt  TEXT NOT NULL,
  password_iters INTEGER NOT NULL,
  plan           TEXT NOT NULL DEFAULT 'free',
  email_verified INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  last_login_at  INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email_norm);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,                     -- sha256(raw token), never stored raw
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- ---------------------------------------------------------------------------
-- Monitors
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS monitors (
  id                   TEXT PRIMARY KEY,
  user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  url                  TEXT NOT NULL,
  method               TEXT NOT NULL DEFAULT 'GET',
  interval_seconds     INTEGER NOT NULL,
  timeout_ms           INTEGER NOT NULL,
  expected_status      TEXT NOT NULL DEFAULT '200-299',
  failure_threshold    INTEGER NOT NULL DEFAULT 3,
  recovery_threshold   INTEGER NOT NULL DEFAULT 1,
  status               TEXT NOT NULL DEFAULT 'unknown',  -- unknown|up|down|paused
  enabled              INTEGER NOT NULL DEFAULT 1,
  is_public            INTEGER NOT NULL DEFAULT 0,
  public_slug          TEXT NOT NULL,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  consecutive_successes INTEGER NOT NULL DEFAULT 0,
  next_check_at        INTEGER NOT NULL,
  last_check_at        INTEGER,
  last_success_at      INTEGER,
  last_status_code     INTEGER,
  last_response_ms     INTEGER,
  last_error           TEXT,
  last_error_kind      TEXT,
  current_incident_id  TEXT,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_monitors_due  ON monitors(enabled, next_check_at);
CREATE INDEX IF NOT EXISTS idx_monitors_user ON monitors(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_monitors_slug ON monitors(public_slug);

CREATE TABLE IF NOT EXISTS checks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor_id    TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  checked_at    INTEGER NOT NULL,
  ok            INTEGER NOT NULL,
  status_code   INTEGER,
  response_ms   INTEGER,
  error_kind    TEXT,
  error_message TEXT,
  redirects     INTEGER NOT NULL DEFAULT 0,
  final_url     TEXT,
  attempt       INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_checks_monitor_time ON checks(monitor_id, checked_at DESC);

CREATE TABLE IF NOT EXISTS incidents (
  id               TEXT PRIMARY KEY,
  monitor_id       TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  started_at       INTEGER NOT NULL,
  resolved_at      INTEGER,
  duration_seconds INTEGER,
  cause            TEXT,
  summary          TEXT,
  last_status_code INTEGER,
  peak_response_ms INTEGER,
  notified_start   INTEGER NOT NULL DEFAULT 0,
  notified_resolve INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_incidents_monitor ON incidents(monitor_id, started_at DESC);

-- ---------------------------------------------------------------------------
-- Notifications
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  monitor_id  TEXT REFERENCES monitors(id) ON DELETE CASCADE,  -- NULL = all monitors
  kind        TEXT NOT NULL,                                    -- webhook | email
  target      TEXT NOT NULL,
  secret_enc  TEXT,                                             -- AES-GCM envelope
  enabled     INTEGER NOT NULL DEFAULT 1,
  on_down     INTEGER NOT NULL DEFAULT 1,
  on_recover  INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);

-- Unique per (notification, incident, event) so retries and duplicate cron runs
-- can never double-send the same alert.
CREATE TABLE IF NOT EXISTS deliveries (
  id              TEXT PRIMARY KEY,
  notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  incident_id     TEXT,
  event           TEXT NOT NULL,          -- down | recover | test
  status          TEXT NOT NULL,          -- sent | failed | skipped
  detail          TEXT,
  attempts        INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL,
  UNIQUE (notification_id, incident_id, event)
);
CREATE INDEX IF NOT EXISTS idx_deliveries_notification ON deliveries(notification_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Maintenance announcements (public status pages)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS maintenance_windows (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  starts_at  INTEGER NOT NULL,
  ends_at    INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_maintenance_user ON maintenance_windows(user_id, starts_at DESC);

-- ---------------------------------------------------------------------------
-- Fixed-window rate limiting for public/auth endpoints
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket_key   TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  hits         INTEGER NOT NULL
);
