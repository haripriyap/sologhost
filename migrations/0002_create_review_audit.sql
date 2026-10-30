CREATE TABLE IF NOT EXISTS evaluation_review_audit (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    action TEXT NOT NULL
        CHECK (action IN ('approved', 'rejected', 'revoked')),
    reviewer TEXT NOT NULL,
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (request_id)
        REFERENCES evaluation_requests(id)
);

CREATE INDEX IF NOT EXISTS idx_review_audit_request
ON evaluation_review_audit(request_id);