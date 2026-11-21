-- Phase 2: invitations, entitlements and revocable sessions. Times are SQLite UTC timestamps.
-- Apply ONLY to local D1 until all integration/security tests pass.
CREATE TABLE IF NOT EXISTS evaluation_invitations (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL REFERENCES evaluation_requests(id),
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT NOT NULL,
    sent_at TEXT,
    used_at TEXT,
    revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_invitation_request ON evaluation_invitations(request_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_invitation_one_open
    ON evaluation_invitations(request_id)
    WHERE used_at IS NULL AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS evaluation_entitlements (
    request_id TEXT PRIMARY KEY REFERENCES evaluation_requests(id),
    activated_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS evaluation_sessions (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL REFERENCES evaluation_requests(id),
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT NOT NULL,
    revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_session_request ON evaluation_sessions(request_id);

CREATE TABLE IF NOT EXISTS evaluation_access_audit (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL REFERENCES evaluation_requests(id),
    action TEXT NOT NULL CHECK (action IN ('invited', 'activated', 'revoked')),
    actor TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_access_audit_request ON evaluation_access_audit(request_id);
