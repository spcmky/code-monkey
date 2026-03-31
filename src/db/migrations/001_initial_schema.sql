-- 001_initial_schema.sql
-- Core tables for the code-monkey autonomous AI agent system
-- Enables pgvector for embedding support and uuid-ossp for UUID generation
--
-- Requirements: PostgreSQL 16+, pgvector extension, uuid-ossp extension

BEGIN;

-- =============================================================================
-- Extensions
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";

-- =============================================================================
-- Utility: auto-update updated_at timestamp
-- =============================================================================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- issues: tracked GitHub issues and their processing state
-- =============================================================================

CREATE TABLE IF NOT EXISTS issues (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    github_issue_id   BIGINT UNIQUE,
    repo_owner        VARCHAR(255) NOT NULL,
    repo_name         VARCHAR(255) NOT NULL,
    issue_number      INTEGER NOT NULL,
    title             TEXT NOT NULL,
    body              TEXT,
    author            VARCHAR(255) NOT NULL,
    labels            TEXT[],
    state             VARCHAR(50) NOT NULL DEFAULT 'DETECTED',
    priority          VARCHAR(50),
    classification    VARCHAR(100),
    confidence        FLOAT,
    assigned_agent    VARCHAR(255),
    pr_number         INTEGER,
    pr_url            TEXT,
    branch_name       VARCHAR(500),
    retry_count       INTEGER NOT NULL DEFAULT 0,
    escalation_reason TEXT,
    deleted_at        TIMESTAMPTZ,
    github_created_at TIMESTAMPTZ,
    github_updated_at TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (repo_owner, repo_name, issue_number),

    CONSTRAINT chk_issues_state CHECK (state IN (
        'DETECTED', 'TRIAGED', 'ASSIGNED', 'IN_PROGRESS', 'IMPLEMENTED',
        'UNDER_REVIEW', 'VALIDATED', 'MERGED', 'ESCALATED', 'CLOSED'
    )),
    CONSTRAINT chk_issues_priority CHECK (priority IS NULL OR priority IN ('critical', 'high', 'medium', 'low')),
    CONSTRAINT chk_issues_confidence CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    CONSTRAINT chk_issues_retry_count CHECK (retry_count >= 0)
);

COMMENT ON TABLE issues IS 'Tracked GitHub issues and their processing state through the autonomous agent pipeline.';
COMMENT ON COLUMN issues.github_issue_id IS 'Unique GitHub issue ID; renamed from github_id for clarity.';

CREATE INDEX IF NOT EXISTS idx_issues_state ON issues (state);
CREATE INDEX IF NOT EXISTS idx_issues_repo ON issues (repo_owner, repo_name);
CREATE INDEX IF NOT EXISTS idx_issues_assigned_agent ON issues (assigned_agent);
CREATE INDEX IF NOT EXISTS idx_issues_priority ON issues (priority);
CREATE INDEX IF NOT EXISTS idx_issues_created_at ON issues (created_at);
CREATE INDEX IF NOT EXISTS idx_issues_updated_at ON issues (updated_at);

-- Composite indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_issues_repo_state ON issues (repo_owner, repo_name, state);
CREATE INDEX IF NOT EXISTS idx_issues_repo_updated ON issues (repo_owner, repo_name, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_issues_state_updated ON issues (state, updated_at DESC);

-- Partial index: only active (non-deleted) issues per repo
CREATE INDEX IF NOT EXISTS idx_issues_active ON issues (repo_owner, repo_name) WHERE deleted_at IS NULL;

-- Partial index: active issues by state for filtered queries
CREATE INDEX IF NOT EXISTS idx_issues_state_active ON issues (state) WHERE deleted_at IS NULL;

CREATE TRIGGER trg_issues_updated_at
    BEFORE UPDATE ON issues
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- =============================================================================
-- state_transitions: audit trail for issue state changes
-- =============================================================================

CREATE TABLE IF NOT EXISTS state_transitions (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    issue_id     UUID NOT NULL REFERENCES issues(id) ON DELETE RESTRICT,
    from_state   VARCHAR(50),
    to_state     VARCHAR(50) NOT NULL,
    triggered_by VARCHAR(255),
    reason       TEXT,
    metadata     JSONB,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE state_transitions IS 'Audit trail for issue state changes. Uses ON DELETE RESTRICT to preserve history.';

CREATE INDEX IF NOT EXISTS idx_state_transitions_issue_id ON state_transitions (issue_id);
CREATE INDEX IF NOT EXISTS idx_state_transitions_created_at ON state_transitions (created_at);
CREATE INDEX IF NOT EXISTS idx_state_transitions_to_state ON state_transitions (to_state);

-- =============================================================================
-- agent_actions: log of all agent operations with token/cost tracking
-- =============================================================================

CREATE TABLE IF NOT EXISTS agent_actions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    issue_id        UUID REFERENCES issues(id) ON DELETE SET NULL,
    agent_name      VARCHAR(255) NOT NULL,
    action_type     VARCHAR(100) NOT NULL,
    model_id        VARCHAR(255),
    input_tokens    INTEGER,
    output_tokens   INTEGER,
    cost_estimate   NUMERIC(10, 6),
    duration_ms     INTEGER,
    status          VARCHAR(50) NOT NULL,
    input_summary   TEXT,
    output_summary  TEXT,
    output_data     JSONB,
    error_message   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_agent_actions_status CHECK (status IN ('pending', 'running', 'completed', 'failed'))
);

COMMENT ON TABLE agent_actions IS 'Log of all agent operations with token/cost tracking. ON DELETE SET NULL preserves action history when issues are removed.';

CREATE INDEX IF NOT EXISTS idx_agent_actions_issue_id ON agent_actions (issue_id);
CREATE INDEX IF NOT EXISTS idx_agent_actions_agent_name ON agent_actions (agent_name);
CREATE INDEX IF NOT EXISTS idx_agent_actions_action_type ON agent_actions (action_type);
CREATE INDEX IF NOT EXISTS idx_agent_actions_status ON agent_actions (status);
CREATE INDEX IF NOT EXISTS idx_agent_actions_created_at ON agent_actions (created_at);

-- Composite indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_agent_actions_issue_created ON agent_actions (issue_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_actions_agent_type ON agent_actions (agent_name, action_type, created_at DESC);

-- =============================================================================
-- decision_cache: cached agent decisions for repeated patterns
-- =============================================================================

CREATE TABLE IF NOT EXISTS decision_cache (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    cache_key     VARCHAR(512) UNIQUE NOT NULL,
    decision_type VARCHAR(100) NOT NULL,
    input_pattern JSONB,
    decision      JSONB NOT NULL,
    hit_count     INTEGER NOT NULL DEFAULT 0,
    confidence    FLOAT,
    expires_at    TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_decision_cache_confidence CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1))
);

COMMENT ON TABLE decision_cache IS 'Cached agent decisions for repeated patterns, with TTL-based expiry.';

CREATE INDEX IF NOT EXISTS idx_decision_cache_type ON decision_cache (decision_type);
CREATE INDEX IF NOT EXISTS idx_decision_cache_expires_at ON decision_cache (expires_at);

-- Composite index for type + expiry lookups
CREATE INDEX IF NOT EXISTS idx_decision_cache_type_expires ON decision_cache (decision_type, expires_at DESC);

-- =============================================================================
-- audit_log: system-wide audit trail
-- =============================================================================

CREATE TABLE IF NOT EXISTS audit_log (
    id            BIGSERIAL PRIMARY KEY,
    timestamp     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actor         VARCHAR(255) NOT NULL,
    action        VARCHAR(255) NOT NULL,
    resource_type VARCHAR(100) NOT NULL,
    resource_id   VARCHAR(255) NOT NULL,
    details       JSONB,
    severity      VARCHAR(50) NOT NULL DEFAULT 'info',

    CONSTRAINT chk_audit_log_severity CHECK (severity IN ('info', 'warn', 'error', 'critical'))
);

COMMENT ON TABLE audit_log IS 'Immutable system-wide audit trail. Rows must never be updated or deleted. Consider partitioning by timestamp for large deployments.';
-- TRUNCATE PROTECTION: Never truncate audit_log in production. This table is an
-- immutable audit trail required for compliance and incident investigation.
-- PRODUCTION: REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM app_user;

-- Trigger function to enforce audit log immutability
CREATE OR REPLACE FUNCTION prevent_audit_modification()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'audit_log is immutable: % operations are not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_log_no_update
    BEFORE UPDATE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION prevent_audit_modification();

CREATE TRIGGER trg_audit_log_no_delete
    BEFORE DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION prevent_audit_modification();

CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log (timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log (actor);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log (action);
CREATE INDEX IF NOT EXISTS idx_audit_log_resource ON audit_log (resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_severity ON audit_log (severity);

-- Composite indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_audit_log_actor_timestamp ON audit_log (actor, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_resource_timestamp ON audit_log (resource_type, resource_id, timestamp DESC);

-- =============================================================================
-- repo_profiles: cached repository analysis metadata
-- =============================================================================

CREATE TABLE IF NOT EXISTS repo_profiles (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    repo_owner   VARCHAR(255) NOT NULL,
    repo_name    VARCHAR(255) NOT NULL,
    profile_data JSONB NOT NULL DEFAULT '{}',
    file_count   INTEGER,
    loc_estimate INTEGER,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (repo_owner, repo_name)
);

COMMENT ON TABLE repo_profiles IS 'Cached repository analysis metadata including file counts and LOC estimates.';

CREATE INDEX IF NOT EXISTS idx_repo_profiles_repo ON repo_profiles (repo_owner, repo_name);

CREATE TRIGGER trg_repo_profiles_updated_at
    BEFORE UPDATE ON repo_profiles
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- =============================================================================
-- Row-Level Security (RLS) - enable in production for multi-tenant isolation
-- =============================================================================
-- In production, enable RLS on tables that hold tenant-scoped data.
-- This prevents cross-tenant data leakage when multiple orgs share one database.
--
-- Example RLS policies for the issues table:
--
-- ALTER TABLE issues ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE issues FORCE ROW LEVEL SECURITY;
--
-- CREATE POLICY issues_tenant_isolation ON issues
--     USING (repo_owner = current_setting('app.current_tenant'));
--
-- CREATE POLICY issues_tenant_insert ON issues
--     FOR INSERT
--     WITH CHECK (repo_owner = current_setting('app.current_tenant'));
--
-- Similar policies should be applied to: state_transitions, agent_actions,
-- file_embeddings, issue_embeddings, resolution_embeddings, daily_metrics,
-- and repo_profiles.

COMMIT;
