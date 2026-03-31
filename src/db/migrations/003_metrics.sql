-- 003_metrics.sql
-- Aggregated daily metrics for tracking agent performance and cost

BEGIN;

-- =============================================================================
-- daily_metrics: per-repo daily rollups of activity and cost
-- =============================================================================

CREATE TABLE IF NOT EXISTS daily_metrics (
    id                        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    date                      DATE NOT NULL,
    repo_owner                VARCHAR(255) NOT NULL,
    repo_name                 VARCHAR(255) NOT NULL,
    issues_detected           INTEGER NOT NULL DEFAULT 0,
    issues_triaged            INTEGER NOT NULL DEFAULT 0,
    issues_resolved           INTEGER NOT NULL DEFAULT 0,
    issues_escalated          INTEGER NOT NULL DEFAULT 0,
    prs_created               INTEGER NOT NULL DEFAULT 0,
    prs_merged                INTEGER NOT NULL DEFAULT 0,
    prs_rejected              INTEGER NOT NULL DEFAULT 0,
    avg_resolution_time_hours NUMERIC(10, 2),
    total_input_tokens        BIGINT NOT NULL DEFAULT 0,
    total_output_tokens       BIGINT NOT NULL DEFAULT 0,
    total_cost                NUMERIC(10, 4) NOT NULL DEFAULT 0,
    cache_hit_rate            FLOAT,
    rule_match_rate           FLOAT,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (date, repo_owner, repo_name)
);

COMMENT ON TABLE daily_metrics IS 'Aggregated daily rollups of agent activity, cost, and performance per repository.';

CREATE INDEX IF NOT EXISTS idx_daily_metrics_date ON daily_metrics (date);
CREATE INDEX IF NOT EXISTS idx_daily_metrics_repo ON daily_metrics (repo_owner, repo_name);

COMMIT;
