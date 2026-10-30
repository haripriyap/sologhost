CREATE TABLE IF NOT EXISTS evaluation_requests (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    organization TEXT NOT NULL,
    email TEXT NOT NULL,
    purpose TEXT NOT NULL,

    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'rejected')),

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reviewed_at TEXT,
    access_expires_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_evaluation_requests_status
ON evaluation_requests(status);

CREATE INDEX IF NOT EXISTS idx_evaluation_requests_created
ON evaluation_requests(created_at);