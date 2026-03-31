import pg from "pg";
import { readFileSync } from "node:fs";
import logger from "../logger.js";
import type {
  Issue,
  AgentAction,
  AuditLogEntry,
  IssueState,
} from "../types/index.js";
import { runMigrations } from "./migrations.js";
import { z } from "zod";

const { Pool } = pg;

const ALLOWED_ACTION_COLUMNS = new Set([
  "status",
  "output_data",
  "completed_at",
  "error_message",
]);

const ActionUpdateSchema = z.object({
  status: z.enum(["pending", "running", "completed", "failed"]).optional(),
  output: z.record(z.unknown()).optional(),
  completedAt: z.coerce.date().optional(),
  errorMessage: z.string().optional(),
}).strict();

export class Store {
  private pool: pg.Pool;

  constructor(config: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    ssl: boolean;
  }) {
    this.pool = new Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      ssl: config.ssl
        ? {
            rejectUnauthorized: true,
            ...(process.env.DB_CA_CERT
              ? { ca: readFileSync(process.env.DB_CA_CERT, "utf-8") }
              : {}),
          }
        : false,
    });
  }

  async initialize(): Promise<void> {
    logger.info("Initializing database connection");
    const client = await this.pool.connect();
    try {
      await client.query("SELECT 1");
      logger.info("Database connection verified");
      await runMigrations(this.pool);
    } finally {
      client.release();
    }
  }

  async shutdown(): Promise<void> {
    logger.info("Shutting down database pool, waiting for in-flight queries...");
    try {
      await Promise.race([
        this.pool.end(),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error("Pool shutdown timed out")), 5000)
        ),
      ]);
      logger.info("Database pool closed gracefully");
    } catch (error) {
      logger.warn("Database pool shutdown timeout, forcing close", {
        error: String(error),
      });
      // Force terminate remaining connections
      await this.pool.end().catch(() => {});
    }
  }

  // --- Issues ---

  async upsertIssue(issue: Omit<Issue, "id"> & { id?: string }): Promise<void> {
    logger.debug(`Upserting issue ${issue.repo}#${issue.number}`);
    const [repoOwner, repoName] = issue.repo.split("/");
    const query = `
      INSERT INTO issues (github_issue_id, repo_owner, repo_name, issue_number, title, body, author, labels, state, classification, confidence, priority, assigned_agent, github_created_at, github_updated_at, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW(), NOW())
      ON CONFLICT (repo_owner, repo_name, issue_number) DO UPDATE SET
        title = EXCLUDED.title,
        body = EXCLUDED.body,
        labels = EXCLUDED.labels,
        state = EXCLUDED.state,
        classification = EXCLUDED.classification,
        confidence = EXCLUDED.confidence,
        priority = EXCLUDED.priority,
        assigned_agent = EXCLUDED.assigned_agent,
        github_updated_at = EXCLUDED.github_updated_at
    `;
    await this.pool.query(query, [
      issue.githubId,
      repoOwner,
      repoName,
      issue.number,
      issue.title,
      issue.body,
      issue.author ?? "unknown",
      issue.labels,
      issue.state,
      issue.classification ?? null,
      issue.confidence ?? null,
      issue.priority ?? null,
      issue.assignedAgent ?? null,
      issue.createdAt,
      issue.updatedAt,
    ]);
  }

  async getIssue(id: string): Promise<Issue | null> {
    logger.debug(`Fetching issue ${id}`);
    const result = await this.pool.query(
      "SELECT * FROM issues WHERE id = $1 AND deleted_at IS NULL",
      [id]
    );
    if (result.rows.length === 0) return null;
    return this.rowToIssue(result.rows[0]);
  }

  async softDeleteIssue(id: string): Promise<void> {
    logger.debug(`Soft-deleting issue ${id}`);
    const result = await this.pool.query(
      "UPDATE issues SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL",
      [id]
    );
    if (result.rowCount === 0) {
      logger.warn(`softDeleteIssue: no active issue found with id ${id}`);
    }
  }

  async getIssuesByState(state: IssueState): Promise<Issue[]> {
    logger.debug(`Fetching issues in state ${state}`);
    const result = await this.pool.query(
      "SELECT * FROM issues WHERE state = $1 AND deleted_at IS NULL ORDER BY updated_at DESC",
      [state]
    );
    return result.rows.map((row: Record<string, unknown>) =>
      this.rowToIssue(row)
    );
  }

  async getIssueByRepoAndNumber(
    repoOwner: string,
    repoName: string,
    issueNumber: number
  ): Promise<Issue | null> {
    logger.debug(`Fetching issue ${repoOwner}/${repoName}#${issueNumber}`);
    const result = await this.pool.query(
      "SELECT * FROM issues WHERE repo_owner = $1 AND repo_name = $2 AND issue_number = $3 AND deleted_at IS NULL",
      [repoOwner, repoName, issueNumber]
    );
    if (result.rows.length === 0) return null;
    return this.rowToIssue(result.rows[0]);
  }

  async updateIssueState(id: string, state: IssueState): Promise<void> {
    await this.pool.query(
      "UPDATE issues SET state = $1, updated_at = NOW() WHERE id = $2",
      [state, id]
    );
  }

  // --- Agent Actions ---

  async insertAction(action: AgentAction): Promise<void> {
    logger.debug(`Inserting action ${action.id} for issue ${action.issueId}`);
    await this.pool.query(
      `INSERT INTO agent_actions (id, issue_id, agent_name, action_type, model_id, input_tokens, output_tokens, cost_estimate, duration_ms, status, input_summary, output_summary, output_data, error_message, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())`,
      [
        action.id,
        action.issueId,
        action.agentType,
        action.action,
        action.modelId ?? null,
        action.inputTokens ?? null,
        action.outputTokens ?? null,
        action.costEstimate ?? null,
        action.durationMs ?? null,
        action.status,
        JSON.stringify(action.input),
        action.outputSummary ?? null,
        action.output ? JSON.stringify(action.output) : null,
        action.error ?? null,
      ]
    );
  }

  async updateAction(
    id: string,
    updates: Partial<AgentAction>
  ): Promise<void> {
    logger.debug(`Updating action ${id}`);

    // Validate updates against schema to prevent unexpected columns
    const validated = ActionUpdateSchema.safeParse(updates);
    if (!validated.success) {
      logger.error(`Invalid update payload for action ${id}`, {
        errors: validated.error.format(),
      });
      throw new Error(`Invalid update payload: ${validated.error.message}`);
    }

    const sets: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (validated.data.status !== undefined) {
      sets.push(`status = $${idx++}`);
      values.push(validated.data.status);
    }
    if (validated.data.output !== undefined) {
      sets.push(`output_data = $${idx++}`);
      values.push(JSON.stringify(validated.data.output));
    }
    if (validated.data.completedAt !== undefined) {
      sets.push(`completed_at = $${idx++}`);
      values.push(validated.data.completedAt);
    }
    if (validated.data.errorMessage !== undefined) {
      sets.push(`error_message = $${idx++}`);
      values.push(validated.data.errorMessage);
    }

    if (sets.length === 0) return;
    values.push(id);
    const result = await this.pool.query(
      `UPDATE agent_actions SET ${sets.join(", ")} WHERE id = $${idx}`,
      values
    );
    if (result.rowCount === 0) {
      logger.warn(`updateAction: no action found with id ${id}, 0 rows affected`);
    }
  }

  // --- Audit Log ---

  async insertAuditLog(entry: AuditLogEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_log (timestamp, actor, action, resource_type, resource_id, details, severity)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        entry.timestamp,
        entry.agentType ?? "system",
        entry.action,
        "issue",
        entry.issueId ?? entry.id,
        JSON.stringify(entry.details),
        "info",
      ]
    );
  }

  // --- Decision Cache ---

  async cacheDecision(
    key: string,
    value: Record<string, unknown>,
    ttlSeconds: number
  ): Promise<void> {
    logger.debug(`Caching decision ${key}`);
    await this.pool.query(
      `INSERT INTO decision_cache (cache_key, decision_type, input_pattern, decision, confidence, expires_at)
       VALUES ($1, $2, $3, $4, $5, NOW() + $6 * INTERVAL '1 second')
       ON CONFLICT (cache_key) DO UPDATE SET
         decision = EXCLUDED.decision,
         expires_at = EXCLUDED.expires_at,
         updated_at = NOW()`,
      [
        key,
        (value.decisionType as string) ?? "generic",
        JSON.stringify(value.inputPattern ?? null),
        JSON.stringify(value),
        (value.confidence as number) ?? null,
        ttlSeconds,
      ]
    );
  }

  async getCachedDecision(
    key: string
  ): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `UPDATE decision_cache
       SET hit_count = hit_count + 1, updated_at = NOW()
       WHERE cache_key = $1 AND expires_at > NOW()
       RETURNING decision`,
      [key]
    );
    if (result.rows.length === 0) return null;
    return result.rows[0].decision as Record<string, unknown>;
  }

  // --- Helpers ---

  private rowToIssue(row: Record<string, unknown>): Issue {
    const repoOwner = row.repo_owner as string;
    const repoName = row.repo_name as string;
    const issueNumber = row.issue_number as number;
    return {
      id: row.id as string,
      githubId: row.github_issue_id as number,
      repo: `${repoOwner}/${repoName}`,
      number: issueNumber,
      title: row.title as string,
      body: (row.body as string) ?? "",
      author: row.author as string,
      labels: (row.labels as string[]) ?? [],
      state: row.state as IssueState,
      classification: row.classification as Issue["classification"],
      confidence: row.confidence as number | undefined,
      priority: row.priority as Issue["priority"],
      assignedAgent: row.assigned_agent as Issue["assignedAgent"],
      createdAt: new Date(row.github_created_at as string ?? row.created_at as string),
      updatedAt: new Date(row.github_updated_at as string ?? row.updated_at as string),
      url: `https://github.com/${repoOwner}/${repoName}/issues/${issueNumber}`,
    };
  }
}
