-- 002_embeddings.sql
-- Vector embedding tables for semantic search across files, issues, and resolutions
-- Requires pgvector extension (enabled in 001_initial_schema.sql)

BEGIN;

-- =============================================================================
-- file_embeddings: chunked file content with vector embeddings
-- =============================================================================

CREATE TABLE IF NOT EXISTS file_embeddings (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    repo_owner    VARCHAR(255) NOT NULL,
    repo_name     VARCHAR(255) NOT NULL,
    file_path     TEXT NOT NULL,
    file_hash     VARCHAR(64) NOT NULL,
    chunk_index   INTEGER NOT NULL,
    chunk_content TEXT NOT NULL,
    embedding     vector(1024) NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (repo_owner, repo_name, file_path, chunk_index)
);

COMMENT ON TABLE file_embeddings IS 'Chunked file content with vector embeddings for semantic code search.';

CREATE INDEX IF NOT EXISTS idx_file_embeddings_repo ON file_embeddings (repo_owner, repo_name);
CREATE INDEX IF NOT EXISTS idx_file_embeddings_path ON file_embeddings (repo_owner, repo_name, file_path);
CREATE INDEX IF NOT EXISTS idx_file_embeddings_hash ON file_embeddings (file_hash);

CREATE TRIGGER trg_file_embeddings_updated_at
    BEFORE UPDATE ON file_embeddings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- =============================================================================
-- issue_embeddings: vector representations of issue content
-- =============================================================================

CREATE TABLE IF NOT EXISTS issue_embeddings (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    repo_owner    VARCHAR(255) NOT NULL,
    repo_name     VARCHAR(255) NOT NULL,
    issue_number  INTEGER NOT NULL,
    content_hash  VARCHAR(64) NOT NULL,
    embedding     vector(1024) NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (repo_owner, repo_name, issue_number)
);

COMMENT ON TABLE issue_embeddings IS 'Vector representations of issue content for semantic similarity matching.';

CREATE INDEX IF NOT EXISTS idx_issue_embeddings_repo ON issue_embeddings (repo_owner, repo_name);
CREATE INDEX IF NOT EXISTS idx_issue_embeddings_hash ON issue_embeddings (content_hash);

CREATE TRIGGER trg_issue_embeddings_updated_at
    BEFORE UPDATE ON issue_embeddings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- =============================================================================
-- resolution_embeddings: learned resolution patterns for similar-issue matching
-- =============================================================================

CREATE TABLE IF NOT EXISTS resolution_embeddings (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    issue_id            UUID REFERENCES issues(id) ON DELETE SET NULL,
    resolution_summary  TEXT NOT NULL,
    files_changed       TEXT[],
    approach            TEXT,
    embedding           vector(1024) NOT NULL,
    success             BOOLEAN NOT NULL DEFAULT true,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE resolution_embeddings IS 'Learned resolution patterns for similar-issue matching. ON DELETE SET NULL preserves resolution knowledge when issues are removed.';

CREATE INDEX IF NOT EXISTS idx_resolution_embeddings_issue_id ON resolution_embeddings (issue_id);
CREATE INDEX IF NOT EXISTS idx_resolution_embeddings_success ON resolution_embeddings (success);

CREATE TRIGGER trg_resolution_embeddings_updated_at
    BEFORE UPDATE ON resolution_embeddings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- =============================================================================
-- IVFFlat indexes for cosine similarity search
-- Must be created after data is loaded for optimal list distribution;
-- lists=100 is a reasonable starting point for moderate-sized datasets.
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_file_embeddings_vector
    ON file_embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE INDEX IF NOT EXISTS idx_issue_embeddings_vector
    ON issue_embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE INDEX IF NOT EXISTS idx_resolution_embeddings_vector
    ON resolution_embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- IVFFlat tuning guidance:
-- lists = sqrt(row_count) is a good starting point. Adjust probes at query time
-- with SET ivfflat.probes = N (higher = better recall, slower speed).
-- Rebuild indexes periodically as data distribution changes.
COMMENT ON INDEX idx_file_embeddings_vector IS 'IVFFlat cosine similarity index. lists=100 suits up to ~10k rows; increase to sqrt(N) for larger datasets. Set ivfflat.probes at query time for recall/speed tradeoff.';
COMMENT ON INDEX idx_issue_embeddings_vector IS 'IVFFlat cosine similarity index. lists=100 suits up to ~10k rows; increase to sqrt(N) for larger datasets. Set ivfflat.probes at query time for recall/speed tradeoff.';
COMMENT ON INDEX idx_resolution_embeddings_vector IS 'IVFFlat cosine similarity index. lists=100 suits up to ~10k rows; increase to sqrt(N) for larger datasets. Set ivfflat.probes at query time for recall/speed tradeoff.';

-- =============================================================================
-- HNSW alternative indexes (commented out)
-- HNSW provides better recall and does not require training data, but uses more
-- memory and has slower inserts. Consider switching when dataset exceeds ~100k rows.
-- =============================================================================
-- CREATE INDEX IF NOT EXISTS idx_file_embeddings_vector_hnsw
--     ON file_embeddings USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
--
-- CREATE INDEX IF NOT EXISTS idx_issue_embeddings_vector_hnsw
--     ON issue_embeddings USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
--
-- CREATE INDEX IF NOT EXISTS idx_resolution_embeddings_vector_hnsw
--     ON resolution_embeddings USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

COMMIT;
