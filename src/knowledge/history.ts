import pg from "pg";
import { createHash } from "node:crypto";
import { EmbeddingStore } from "./embeddings.js";
import type { Issue } from "../types/index.js";
import logger from "../logger.js";

export class HistoryStore {
  private pool: pg.Pool;
  private embeddings: EmbeddingStore;

  constructor(pool: pg.Pool, embeddings: EmbeddingStore) {
    this.pool = pool;
    this.embeddings = embeddings;
  }

  async recordResolution(
    issueId: string,
    summary: string,
    filesChanged: string[],
    approach: string,
    success: boolean
  ): Promise<void> {
    logger.info(`Recording resolution for issue ${issueId}`);

    const embedding = await this.embeddings.embed(summary);
    await this.embeddings.insertResolutionEmbedding(
      issueId,
      summary,
      filesChanged,
      approach,
      embedding,
      success
    );

    // Optionally update the issue state to CLOSED if successful
    if (success) {
      await this.pool.query(
        `UPDATE issues SET state = 'CLOSED' WHERE id = $1 AND deleted_at IS NULL`,
        [issueId]
      );
    }

    logger.info(`Resolution recorded for issue ${issueId}`);
  }

  async findSimilar(
    issue: Issue,
    limit: number = 5
  ): Promise<Array<{ issueId: string; resolutionSummary: string; filesChanged: string[]; approach: string; success: boolean; similarity: number }>> {
    logger.debug(`Finding similar resolutions to issue ${issue.id}`);

    const text = `${issue.title}\n\n${issue.body}`;
    const queryEmbedding = await this.embeddings.embed(text);

    const results = await this.embeddings.searchSimilarResolutions(queryEmbedding, limit);

    return results.map((r) => ({
      issueId: r.issueId,
      resolutionSummary: r.resolutionSummary,
      filesChanged: r.filesChanged,
      approach: r.approach,
      success: r.success,
      similarity: 1 - r.distance, // convert cosine distance to similarity
    }));
  }

  async getStats(): Promise<{
    issuesByState: Record<string, number>;
    issuesByClassification: Record<string, number>;
    actionsByAgent: Record<string, number>;
    avgResolutionTimeMs: number;
  }> {
    const byState = await this.pool.query(
      "SELECT state, COUNT(*)::int as count FROM issues WHERE deleted_at IS NULL GROUP BY state"
    );
    const byClassification = await this.pool.query(
      "SELECT classification, COUNT(*)::int as count FROM issues WHERE deleted_at IS NULL AND classification IS NOT NULL GROUP BY classification"
    );
    const byAgent = await this.pool.query(
      "SELECT agent_name, COUNT(*)::int as count FROM agent_actions GROUP BY agent_name"
    );
    const avgTime = await this.pool.query(
      `SELECT AVG(EXTRACT(EPOCH FROM (updated_at - created_at)) * 1000)::float as avg_ms
       FROM issues
       WHERE state = 'CLOSED' AND deleted_at IS NULL`
    );

    return {
      issuesByState: Object.fromEntries(
        byState.rows.map((r: { state: string; count: number }) => [r.state, r.count])
      ),
      issuesByClassification: Object.fromEntries(
        byClassification.rows.map((r: { classification: string; count: number }) => [r.classification, r.count])
      ),
      actionsByAgent: Object.fromEntries(
        byAgent.rows.map((r: { agent_name: string; count: number }) => [r.agent_name, r.count])
      ),
      avgResolutionTimeMs: avgTime.rows[0]?.avg_ms ?? 0,
    };
  }
}
