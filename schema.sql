-- Car Keys — shared backend schema (PostgreSQL)
-- Run this once against your database before starting the server.

CREATE TABLE IF NOT EXISTS daily_locks (
  store_idx       INTEGER NOT NULL,
  lock_date       DATE NOT NULL,
  ban_list        JSONB NOT NULL,
  filters         JSONB NOT NULL,
  first_assigned  TIMESTAMPTZ NOT NULL,
  agent_name      TEXT NOT NULL,
  PRIMARY KEY (store_idx, lock_date)
);

CREATE TABLE IF NOT EXISTS ctn_status (
  ctn               BIGINT PRIMARY KEY,
  ban               BIGINT NOT NULL,
  store_idx         INTEGER,
  agent_name        TEXT,
  called            BOOLEAN NOT NULL DEFAULT FALSE,
  completed_status  TEXT NOT NULL DEFAULT '',   -- '', 'Completed', 'Not Completed'
  call_back_date    DATE,
  notes             TEXT,
  last_updated      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pending_callbacks (
  store_idx      INTEGER NOT NULL,
  ban            BIGINT NOT NULL,
  ctn            BIGINT NOT NULL,
  call_back_date DATE NOT NULL,
  notes          TEXT,
  agent_name     TEXT,
  last_updated   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (store_idx, ban, ctn)
);

CREATE TABLE IF NOT EXISTS completed_full_bans (
  ban          BIGINT PRIMARY KEY,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS completed_ctns_log (
  id             SERIAL PRIMARY KEY,
  store_name     TEXT,
  ban            BIGINT,
  ctn            BIGINT,
  completed_date DATE,
  agent_name     TEXT
);

CREATE TABLE IF NOT EXISTS daily_tracking (
  id                SERIAL PRIMARY KEY,
  track_date        DATE NOT NULL,
  store_name        TEXT,
  ban               BIGINT,
  ctn               BIGINT,
  called            TEXT,
  completed_status  TEXT,
  call_back_date    DATE,
  notes             TEXT,
  login_date        DATE,
  agent_name        TEXT,
  last_updated      TIMESTAMPTZ NOT NULL DEFAULT now(),
  assigned_date     DATE
);

CREATE INDEX IF NOT EXISTS idx_pending_store ON pending_callbacks (store_idx);
CREATE INDEX IF NOT EXISTS idx_tracking_date ON daily_tracking (track_date);
CREATE INDEX IF NOT EXISTS idx_ctn_status_ban ON ctn_status (ban);
