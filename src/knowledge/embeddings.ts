import pg from "pg";
import pgvector from "pgvector";
import { createHash } from "node:crypto";
import { BedrockClient } from "../tools/bedrock.js";
import type { Issue, EmbeddingRecord } from "../types/index.js";
import logger from "../logger.js";

const { Pool } = pg;

export class EmbeddingStore {
  private pool: pg.Pool;
  private bedrock: BedrockClient;

  constructor(
    pool: pg.Pool,
    bedrock: BedrockClient
  ) {
    this.pool = pool;
    this.bedrock = bedrock;
  }

  async embed(text: string): Promise<number[]> {
    return this.bedrock.embed(text);
  }

  // --- File Embeddings ---

  async upsertFileEmbedding(
    repoOwner: string,
    repoName: string,
    filePath: string,
    fileHash: string,
    chunkIndex: number,
    chunkContent: string,
    embedding: number[]
  ): Promise<void> {
    const embeddingStr = pgvector.toSql(embedding);
    await this.pool.query(
      `INSERT INTO file_embeddings (repo_owner, repo_name, file_path, file_hash, chunk_index, chunk_content, embedding)
       VALUES ($1, $2, $3, $4, $5, $6, $7::vector)
       ON CONFLICT (repo_owner, repo_name, file_path, chunk_index) DO UPDATE SET
         file_hash = EXCLUDED.file_hash,
         chunk_content = EXCLUDED.chunk_content,
         embedding = EXCLUDED.embedding`,
      [repoOwner, repoName, filePath, fileHash, chunkIndex, chunkContent, embeddingStr]
    );
  }

  // --- Issue Embeddings ---

  async upsertIssueEmbedding(
    repoOwner: string,
    repoName: string,
    issueNumber: number,
    contentHash: string,
    embedding: number[]
  ): Promise<void> {
    const embeddingStr = pgvector.toSql(embedding);
    await this.pool.query(
      `INSERT INTO issue_embeddings (repo_owner, repo_name, issue_number, content_hash, embedding)
       VALUES ($1, $2, $3, $4, $5::vector)
       ON CONFLICT (repo_owner, repo_name, issue_number) DO UPDATE SET
         content_hash = EXCLUDED.content_hash,
         embedding = EXCLUDED.embedding`,
      [repoOwner, repoName, issueNumber, contentHash, embeddingStr]
    );
  }

  // --- Resolution Embeddings ---

  async insertResolutionEmbedding(
    issueId: string,
    resolutionSummary: string,
    filesChanged: string[],
    approach: string,
    embedding: number[],
    success: boolean
  ): Promise<void> {
    const embeddingStr = pgvector.toSql(embedding);
    await this.pool.query(
      `INSERT INTO resolution_embeddings (issue_id, resolution_summary, files_changed, approach, embedding, success)
       VALUES ($1, $2, $3, $4, $5::vector, $6)`,
      [issueId, resolutionSummary, filesChanged, approach, embeddingStr, success]
    );
  }

  // --- Similarity Search ---

  async searchSimilarFiles(
    queryEmbedding: number[],
    repoOwner: string,
    repoName: string,
    limit: number = 10
  ): Promise<Array<{ id: string; filePath: string; chunkIndex: number; chunkContent: string; distance: number }>> {
    const embeddingStr = pgvector.toSql(queryEmbedding);
    const result = await this.pool.query(
      `SELECT id, file_path, chunk_index, chunk_content,
              embedding <=> $1::vector AS distance
       FROM file_embeddings
       WHERE repo_owner = $2 AND repo_name = $3
       ORDER BY distance
       LIMIT $4`,
      [embeddingStr, repoOwner, repoName, limit]
    );
    return result.rows.map((row: Record<string, unknown>) => ({
      id: row.id as string,
      filePath: row.file_path as string,
      chunkIndex: row.chunk_index as number,
      chunkContent: row.chunk_content as string,
      distance: row.distance as number,
    }));
  }

  async searchSimilarIssues(
    queryEmbedding: number[],
    repoOwner: string,
    repoName: string,
    limit: number = 10
  ): Promise<Array<{ id: string; issueNumber: number; distance: number }>> {
    const embeddingStr = pgvector.toSql(queryEmbedding);
    const result = await this.pool.query(
      `SELECT id, issue_number,
              embedding <=> $1::vector AS distance
       FROM issue_embeddings
       WHERE repo_owner = $2 AND repo_name = $3
       ORDER BY distance
       LIMIT $4`,
      [embeddingStr, repoOwner, repoName, limit]
    );
    return result.rows.map((row: Record<string, unknown>) => ({
      id: row.id as string,
      issueNumber: row.issue_number as number,
      distance: row.distance as number,
    }));
  }

  async searchSimilarResolutions(
    queryEmbedding: number[],
    limit: number = 10
  ): Promise<Array<{ id: string; issueId: string; resolutionSummary: string; filesChanged: string[]; approach: string; success: boolean; distance: number }>> {
    const embeddingStr = pgvector.toSql(queryEmbedding);
    const result = await this.pool.query(
      `SELECT id, issue_id, resolution_summary, files_changed, approach, success,
              embedding <=> $1::vector AS distance
       FROM resolution_embeddings
       ORDER BY distance
       LIMIT $2`,
      [embeddingStr, limit]
    );
    return result.rows.map((row: Record<string, unknown>) => ({
      id: row.id as string,
      issueId: row.issue_id as string,
      resolutionSummary: row.resolution_summary as string,
      filesChanged: (row.files_changed as string[]) ?? [],
      approach: (row.approach as string) ?? "",
      success: row.success as boolean,
      distance: row.distance as number,
    }));
  }

  // --- High-level convenience methods ---

  async upsertFile(path: string, content: string, repoOwner?: string, repoName?: string): Promise<void> {
    logger.debug(`Upserting file embedding: ${path}`);

    const owner = repoOwner ?? "unknown";
    const name = repoName ?? "unknown";
    const fileHash = createHash("sha256").update(content).digest("hex");
    const chunks = this.chunkText(content, 2000);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (!chunk) continue;
      const embedding = await this.embed(chunk);
      await this.upsertFileEmbedding(owner, name, path, fileHash, i, chunk, embedding);
    }
  }

  async search(
    query: string,
    limit: number = 10,
    repoOwner?: string,
    repoName?: string
  ): Promise<Array<{ id: string; filePath: string; chunkIndex: number; chunkContent: string; distance: number }>> {
    logger.debug("Searching file embeddings", { query: query.slice(0, 100), limit });

    const queryEmbedding = await this.embed(query);
    const owner = repoOwner ?? "unknown";
    const name = repoName ?? "unknown";
    return this.searchSimilarFiles(queryEmbedding, owner, name, limit);
  }

  private chunkText(text: string, maxChars: number): string[] {
    if (text.length <= maxChars) return [text];

    const chunks: string[] = [];
    const lines = text.split("\n");
    let current = "";

    for (const line of lines) {
      if (current.length + line.length + 1 > maxChars && current.length > 0) {
        chunks.push(current);
        current = line;
      } else {
        current += (current ? "\n" : "") + line;
      }
    }

    if (current) chunks.push(current);
    return chunks;
  }
}
