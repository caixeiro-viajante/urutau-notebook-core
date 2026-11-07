PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS documental_sources (
  owner_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 26214400),
  object_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, id)
);

CREATE TABLE IF NOT EXISTS documental_contributions (
  owner_id TEXT NOT NULL,
  id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  notebook_id TEXT NOT NULL,
  title TEXT NOT NULL,
  requested_scope TEXT NOT NULL CHECK (requested_scope IN ('personal','trail','global')),
  effective_scope TEXT NOT NULL CHECK (effective_scope IN ('personal','owner_trail','private_proposal')),
  state TEXT NOT NULL CHECK (state IN ('pending','ready','proposed')),
  manifest_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, id),
  UNIQUE (owner_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS documental_jobs (
  owner_id TEXT NOT NULL,
  id TEXT NOT NULL,
  contribution_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('structure','extract-document')),
  source_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('queued','processing','needs_credentials','needs_input','ready','failed')),
  attempt INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until TEXT,
  result_key TEXT,
  dispatched_at TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, id),
  UNIQUE (owner_id, contribution_id, action, source_id),
  FOREIGN KEY (owner_id, contribution_id) REFERENCES documental_contributions(owner_id, id)
);
CREATE INDEX IF NOT EXISTS documental_jobs_status ON documental_jobs(status, updated_at);

CREATE TABLE IF NOT EXISTS documental_daily_budget (
  owner_id TEXT NOT NULL,
  day TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0 CHECK (used >= 0),
  PRIMARY KEY (owner_id, day)
);
