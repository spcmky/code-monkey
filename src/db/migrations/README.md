# Database Migrations

## Requirements

- PostgreSQL 16+
- Extensions: `pgvector` (vector similarity), `uuid-ossp` (UUID generation)
- Extensions are created automatically by `001_initial_schema.sql`

## Migration Files

| File | Description |
|------|-------------|
| `001_initial_schema.sql` | Core tables (issues, state_transitions, agent_actions, decision_cache, audit_log, repo_profiles), utility functions, CHECK constraints, immutability triggers, and composite indexes |
| `002_embeddings.sql` | Vector embedding tables (file_embeddings, issue_embeddings, resolution_embeddings) with IVFFlat indexes for cosine similarity search |
| `003_metrics.sql` | Aggregated daily metrics table for tracking agent performance and cost per repository |

## How to Run

Migrations are managed by the runner in `../migrations.ts` and executed automatically on application startup via `Store.initialize()`.

To run manually against a database:

```bash
psql -h <host> -U <user> -d <database> -f src/db/migrations/001_initial_schema.sql
psql -h <host> -U <user> -d <database> -f src/db/migrations/002_embeddings.sql
psql -h <host> -U <user> -d <database> -f src/db/migrations/003_metrics.sql
```

Each file is wrapped in `BEGIN`/`COMMIT` and uses `IF NOT EXISTS` / `CREATE OR REPLACE` for idempotency.

## Rollback Strategy

- Migrations are idempotent but not reversible by default.
- To roll back, write a new migration that undoes the changes (e.g., `DROP TABLE IF EXISTS`, `ALTER TABLE DROP COLUMN`).
- The `migrations` tracking table records applied versions; delete the row for a version before re-running it.
- Always test rollback scripts in a staging environment first.

## Monitoring Queries

```sql
-- Check applied migrations
SELECT * FROM migrations ORDER BY version;

-- Audit log size and growth
SELECT pg_size_pretty(pg_total_relation_size('audit_log'));

-- Issues by state
SELECT state, count(*) FROM issues GROUP BY state ORDER BY count DESC;

-- Agent action cost summary (last 7 days)
SELECT agent_name, count(*), sum(cost_estimate)
FROM agent_actions
WHERE created_at > NOW() - INTERVAL '7 days'
GROUP BY agent_name;

-- Decision cache hit rates
SELECT decision_type, sum(hit_count), count(*) FROM decision_cache GROUP BY decision_type;
```

## Performance Notes

- **IVFFlat tuning**: The `lists` parameter should approximate `sqrt(row_count)`. Default is 100 (suitable for up to ~10k rows). Increase for larger datasets. Set `ivfflat.probes` at query time to trade recall for speed.
- **HNSW alternative**: Commented-out HNSW indexes are provided in `002_embeddings.sql` for datasets exceeding ~100k rows where better recall is needed at the cost of higher memory usage.
- **Audit log partitioning**: For high-volume deployments, consider partitioning `audit_log` by timestamp (e.g., monthly range partitions) to improve query performance and enable efficient data retention.
- **Composite indexes**: Added for common query patterns (repo+state, repo+updated_at, state+updated_at, etc.) to avoid sequential scans on frequently-used filters.
