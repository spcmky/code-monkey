import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type pg from "pg";
import logger from "../logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface Migration {
  version: number;
  name: string;
  sql: string;
}

function loadMigrations(): Migration[] {
  const migrationFiles = [
    { version: 1, name: "initial_schema", file: "001_initial_schema.sql" },
    { version: 2, name: "embeddings", file: "002_embeddings.sql" },
    { version: 3, name: "metrics", file: "003_metrics.sql" },
    { version: 4, name: "current_task", file: "004_current_task.sql" },
    { version: 5, name: "review_feedback", file: "005_review_feedback.sql" },
  ];

  return migrationFiles.map(({ version, name, file }) => ({
    version,
    name,
    sql: readFileSync(join(__dirname, "migrations", file), "utf-8"),
  }));
}

const migrations: Migration[] = loadMigrations();

export async function runMigrations(pool: pg.Pool): Promise<void> {
  logger.info("Running database migrations");

  const client = await pool.connect();
  try {
    // Create migrations table outside the transaction so it persists even if
    // a migration fails, allowing clean retry on next startup.
    await client.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query("BEGIN");

    const applied = await client.query(
      "SELECT version FROM migrations ORDER BY version"
    );
    const appliedVersions = new Set(
      applied.rows.map((r: { version: number }) => r.version)
    );

    for (const migration of migrations) {
      if (appliedVersions.has(migration.version)) {
        logger.debug(`Migration ${migration.version} (${migration.name}) already applied`);
        continue;
      }

      logger.info(`Applying migration ${migration.version}: ${migration.name}`);
      await client.query(migration.sql);
      await client.query(
        "INSERT INTO migrations (version, name) VALUES ($1, $2)",
        [migration.version, migration.name]
      );
      logger.info(`Migration ${migration.version} applied successfully`);
    }

    await client.query("COMMIT");
    logger.info("All migrations applied");
  } catch (error) {
    await client.query("ROLLBACK");
    logger.error("Migration failed, rolled back all changes", { error });
    throw error;
  } finally {
    client.release();
  }
}
