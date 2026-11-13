import { Octokit } from "@octokit/rest";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import logger from "../logger.js";

export interface GitHubIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  user?: { login: string };
  labels: string[];
  state: string;
  createdAt: string;
  updatedAt: string;
  url: string;
}

export interface PRFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

const ARN_REGEX = /^arn:aws:secretsmanager:[a-z0-9-]+:\d{12}:secret:.+$/;

const MAX_REQUESTS_PER_MINUTE = 60;

async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxRetries = 3,
  baseDelayMs = 1000
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        logger.warn(`Retrying ${label} (attempt ${attempt + 1}/${maxRetries}) after ${delay}ms`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  logger.error(`All ${maxRetries} retries exhausted for ${label}, circuit open`);
  throw lastError;
}

export class GitHubClient {
  private octokit: Octokit | null = null;
  private secretArn: string;
  private region: string;
  private requestTimestamps: number[] = [];

  constructor(config: { secretArn: string; region: string }) {
    if (!ARN_REGEX.test(config.secretArn)) {
      throw new Error(
        "Invalid secretArn format. Expected: arn:aws:secretsmanager:<region>:<account>:secret:<name>"
      );
    }
    this.secretArn = config.secretArn;
    this.region = config.region;
  }

  private async rateLimit(): Promise<void> {
    const now = Date.now();
    // Purge timestamps older than 1 minute
    this.requestTimestamps = this.requestTimestamps.filter(
      (ts) => now - ts < 60_000
    );
    if (this.requestTimestamps.length >= MAX_REQUESTS_PER_MINUTE) {
      const oldest = this.requestTimestamps[0]!;
      const waitMs = 60_000 - (now - oldest) + 50;
      logger.warn(`Rate limit reached, waiting ${waitMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    this.requestTimestamps.push(Date.now());
  }

  private async getOctokit(): Promise<Octokit> {
    if (this.octokit) return this.octokit;

    try {
      const sm = new SecretsManagerClient({
        region: this.region,
        ...(process.env.AWS_ENDPOINT_URL && { endpoint: process.env.AWS_ENDPOINT_URL }),
      });
      const secret = await sm.send(
        new GetSecretValueCommand({ SecretId: this.secretArn })
      );
      const token = secret.SecretString;
      if (!token) throw new Error("GitHub PAT secret is empty");

      this.octokit = new Octokit({ auth: token });
      logger.info("GitHub client initialized");
      return this.octokit;
    } catch (error) {
      // Never log the token or secret details
      const message =
        error instanceof Error ? error.message : "Unknown error";
      // Redact any token-like strings from the error message
      const safeMessage = message.replace(
        /ghp_[a-zA-Z0-9]+|github_pat_[a-zA-Z0-9_]+/g,
        "[REDACTED]"
      );
      logger.error("Failed to initialize GitHub client", {
        error: safeMessage,
      });
      throw new Error(`GitHub client initialization failed: ${safeMessage}`);
    }
  }

  cleanup(): void {
    this.octokit = null;
    logger.info("GitHub client cleaned up");
  }

  async listIssues(
    owner: string,
    repo: string,
    options?: { state?: "open" | "closed" | "all"; since?: string }
  ): Promise<GitHubIssue[]> {
    await this.rateLimit();
    return withRetry(async () => {
      const kit = await this.getOctokit();
      const data = await kit.paginate(kit.issues.listForRepo, {
        owner,
        repo,
        state: options?.state ?? "open",
        since: options?.since,
        per_page: 100,
      });

      return data
        .filter((issue) => !issue.pull_request)
        .map((issue) => ({
          id: issue.id,
          number: issue.number,
          title: issue.title,
          body: issue.body ?? null,
          user: issue.user ? { login: issue.user.login } : undefined,
          labels: issue.labels.map((l) =>
            typeof l === "string" ? l : l.name ?? ""
          ),
          state: issue.state ?? "open",
          createdAt: issue.created_at,
          updatedAt: issue.updated_at,
          url: issue.html_url,
        }));
    }, `listIssues(${owner}/${repo})`);
  }

  async getIssue(
    owner: string,
    repo: string,
    issueNumber: number
  ): Promise<GitHubIssue> {
    await this.rateLimit();
    return withRetry(async () => {
      const kit = await this.getOctokit();
      const { data } = await kit.issues.get({
        owner,
        repo,
        issue_number: issueNumber,
      });
      return {
        id: data.id,
        number: data.number,
        title: data.title,
        body: data.body ?? null,
        user: data.user ? { login: data.user.login } : undefined,
        labels: data.labels.map((l) =>
          typeof l === "string" ? l : l.name ?? ""
        ),
        state: data.state ?? "open",
        createdAt: data.created_at,
        updatedAt: data.updated_at,
        url: data.html_url,
      };
    }, `getIssue(${owner}/${repo}#${issueNumber})`);
  }

  async createComment(
    owner: string,
    repo: string,
    issueNumber: number,
    body: string
  ): Promise<void> {
    await this.rateLimit();
    await withRetry(async () => {
      const kit = await this.getOctokit();
      await kit.issues.createComment({
        owner,
        repo,
        issue_number: issueNumber,
        body,
      });
      logger.info(`Comment created on ${owner}/${repo}#${issueNumber}`);
    }, `createComment(${owner}/${repo}#${issueNumber})`);
  }

  async addLabels(
    owner: string,
    repo: string,
    issueNumber: number,
    labels: string[]
  ): Promise<void> {
    await this.rateLimit();
    await withRetry(async () => {
      const kit = await this.getOctokit();
      await kit.issues.addLabels({
        owner,
        repo,
        issue_number: issueNumber,
        labels,
      });
    }, `addLabels(${owner}/${repo}#${issueNumber})`);
  }

  async createPR(
    owner: string,
    repo: string,
    params: { title: string; body: string; head: string; base: string }
  ): Promise<{ number: number; url: string }> {
    await this.rateLimit();
    return withRetry(async () => {
      const kit = await this.getOctokit();
      const { data } = await kit.pulls.create({
        owner,
        repo,
        title: params.title,
        body: params.body,
        head: params.head,
        base: params.base,
      });
      logger.info(`PR #${data.number} created in ${owner}/${repo}`);
      return { number: data.number, url: data.html_url };
    }, `createPR(${owner}/${repo})`);
  }

  async mergePR(
    owner: string,
    repo: string,
    prNumber: number,
    method: "merge" | "squash" | "rebase" = "squash"
  ): Promise<void> {
    await this.rateLimit();
    await withRetry(async () => {
      const kit = await this.getOctokit();
      await kit.pulls.merge({
        owner,
        repo,
        pull_number: prNumber,
        merge_method: method,
      });
      logger.info(`PR #${prNumber} merged in ${owner}/${repo}`);
    }, `mergePR(${owner}/${repo}#${prNumber})`);
  }

  async getFileContent(
    owner: string,
    repo: string,
    path: string,
    ref?: string
  ): Promise<string> {
    await this.rateLimit();
    return withRetry(async () => {
      const kit = await this.getOctokit();
      const { data } = await kit.repos.getContent({
        owner,
        repo,
        path,
        ref,
      });
      if ("content" in data && typeof data.content === "string") {
        return Buffer.from(data.content, "base64").toString("utf-8");
      }
      throw new Error(`Unable to read file content for ${path}`);
    }, `getFileContent(${owner}/${repo}/${path})`);
  }

  async listPRFiles(
    owner: string,
    repo: string,
    prNumber: number
  ): Promise<PRFile[]> {
    await this.rateLimit();
    return withRetry(async () => {
      const kit = await this.getOctokit();
      const data = await kit.paginate(kit.pulls.listFiles, {
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100,
      });
      return data.map((f) => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch,
      }));
    }, `listPRFiles(${owner}/${repo}#${prNumber})`);
  }

  async getDefaultBranch(owner: string, repo: string): Promise<string> {
    await this.rateLimit();
    return withRetry(async () => {
      const kit = await this.getOctokit();
      const { data } = await kit.repos.get({ owner, repo });
      return data.default_branch;
    }, `getDefaultBranch(${owner}/${repo})`);
  }

  /** Lists file paths in the repository at a ref (branch, tag, or commit). */
  async listFiles(owner: string, repo: string, ref: string): Promise<string[]> {
    await this.rateLimit();
    return withRetry(async () => {
      const kit = await this.getOctokit();
      const { data } = await kit.git.getTree({
        owner,
        repo,
        tree_sha: ref,
        recursive: "true",
      });
      return data.tree
        .filter((entry) => entry.type === "blob" && entry.path)
        .map((entry) => entry.path as string);
    }, `listFiles(${owner}/${repo}@${ref})`);
  }

  /** Searches code on the default branch; returns matching file paths. */
  async searchCode(owner: string, repo: string, query: string): Promise<string[]> {
    await this.rateLimit();
    return withRetry(async () => {
      const kit = await this.getOctokit();
      const { data } = await kit.search.code({
        q: `${query} repo:${owner}/${repo}`,
        per_page: 30,
      });
      return data.items.map((item) => item.path);
    }, `searchCode(${owner}/${repo})`);
  }

  /** Returns the head commit SHA of a branch, or null if it does not exist. */
  async getBranchSha(
    owner: string,
    repo: string,
    branch: string
  ): Promise<string | null> {
    await this.rateLimit();
    const kit = await this.getOctokit();
    try {
      const { data } = await kit.git.getRef({
        owner,
        repo,
        ref: `heads/${branch}`,
      });
      return data.object.sha;
    } catch (error) {
      if ((error as { status?: number }).status === 404) return null;
      throw error;
    }
  }

  /**
   * Commits whole-file contents to a branch through the Git data API, creating
   * the branch from `baseBranch` when it does not exist yet. Nothing is cloned
   * or executed locally.
   */
  async commitFiles(
    owner: string,
    repo: string,
    params: {
      branch: string;
      baseBranch: string;
      message: string;
      files: Array<{ path: string; content: string }>;
      /**
       * Build on the base branch even if the work branch already exists, and
       * reset the work branch to the new commit. Used for a fresh attempt, so
       * commits left by an earlier attempt do not leak into it.
       */
      startFromBase?: boolean;
    }
  ): Promise<{ sha: string }> {
    await this.rateLimit();
    const kit = await this.getOctokit();

    const branchSha = await this.getBranchSha(owner, repo, params.branch);
    const parentSha =
      branchSha && !params.startFromBase
        ? branchSha
        : await this.getBranchSha(owner, repo, params.baseBranch);
    if (!parentSha) {
      throw new Error(`Base branch ${params.baseBranch} not found`);
    }

    const { data: parent } = await kit.git.getCommit({
      owner,
      repo,
      commit_sha: parentSha,
    });
    const { data: tree } = await kit.git.createTree({
      owner,
      repo,
      base_tree: parent.tree.sha,
      tree: params.files.map((file) => ({
        path: file.path,
        mode: "100644" as const,
        type: "blob" as const,
        content: file.content,
      })),
    });
    const { data: commit } = await kit.git.createCommit({
      owner,
      repo,
      message: params.message,
      tree: tree.sha,
      parents: [parentSha],
    });

    if (branchSha) {
      await kit.git.updateRef({
        owner,
        repo,
        ref: `heads/${params.branch}`,
        sha: commit.sha,
        // A fresh attempt replaces the branch; otherwise only fast-forward
        force: Boolean(params.startFromBase),
      });
    } else {
      await kit.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${params.branch}`,
        sha: commit.sha,
      });
    }
    logger.info(`Committed ${params.files.length} file(s) to ${owner}/${repo}@${params.branch}`);
    return { sha: commit.sha };
  }

  async isMerged(owner: string, repo: string, prNumber: number): Promise<boolean> {
    await this.rateLimit();
    const kit = await this.getOctokit();
    try {
      await kit.pulls.checkIfMerged({ owner, repo, pull_number: prNumber });
      return true;
    } catch (error) {
      if ((error as { status?: number }).status === 404) return false;
      throw error;
    }
  }

  async updatePR(
    owner: string,
    repo: string,
    prNumber: number,
    params: { title: string; body: string }
  ): Promise<void> {
    await this.rateLimit();
    await withRetry(async () => {
      const kit = await this.getOctokit();
      await kit.pulls.update({
        owner,
        repo,
        pull_number: prNumber,
        title: params.title,
        body: params.body,
      });
    }, `updatePR(${owner}/${repo}#${prNumber})`);
  }

  /** Finds the open PR whose head is the given branch, if any. */
  async findOpenPR(
    owner: string,
    repo: string,
    branch: string
  ): Promise<{ number: number; url: string } | null> {
    await this.rateLimit();
    return withRetry(async () => {
      const kit = await this.getOctokit();
      const { data } = await kit.pulls.list({
        owner,
        repo,
        head: `${owner}:${branch}`,
        state: "open",
        per_page: 1,
      });
      const pr = data[0];
      return pr ? { number: pr.number, url: pr.html_url } : null;
    }, `findOpenPR(${owner}/${repo}@${branch})`);
  }
}
