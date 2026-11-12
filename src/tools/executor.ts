import type { GitHubClient } from "./github.js";
import type { AgentContext, PullRequestRef } from "../types/index.js";
import { checkPathPolicy, normalizeRepoPath } from "../validation/scope.js";
import logger from "../logger.js";

/**
 * Runs an agent's tool calls for one task.
 *
 * Every tool goes through the GitHub API. Nothing is cloned, written to local
 * disk, or executed, so issue text that steers the model cannot run code or
 * reach this process's credentials. Tests run in the target repository's own
 * CI once the pull request exists.
 */
export interface ToolSession {
  execute(
    name: string,
    input: Record<string, unknown>
  ): Promise<Record<string, unknown>>;
}

export type AgentGitHub = Pick<
  GitHubClient,
  | "getFileContent"
  | "getDefaultBranch"
  | "listFiles"
  | "searchCode"
  | "commitFiles"
  | "findOpenPR"
  | "createPR"
  | "listComments"
  | "listPRFiles"
>;

const MAX_FILE_CHARS = 200_000;
const MAX_LISTED_FILES = 2_000;
const MAX_PATCH_CHARS = 60_000;
const MAX_FEEDBACK_COMMENTS = 10;

function splitRepo(repo: string): { owner: string; name: string } {
  const [owner, name] = repo.split("/");
  if (!owner || !name) throw new Error(`Invalid repository: ${repo}`);
  return { owner, name };
}

function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`"${key}" must be a non-empty string`);
  }
  return value;
}

/** The branch an issue's work lives on. Fixed by the system, never the model. */
export function branchForIssue(issueNumber: number): string {
  return `code-monkey/issue-${issueNumber}`;
}

export class CoderToolSession implements ToolSession {
  private readonly owner: string;
  private readonly repo: string;
  private readonly branch: string;
  private readonly pending = new Map<string, string>();
  private baseBranch?: string;
  private committed: string[] = [];

  /** Set once this session has opened or updated the pull request. */
  pullRequest?: PullRequestRef;

  constructor(
    private readonly github: AgentGitHub,
    private readonly context: AgentContext
  ) {
    const { owner, name } = splitRepo(context.issue.repo);
    this.owner = owner;
    this.repo = name;
    this.branch =
      context.issue.pullRequest?.branch || branchForIssue(context.issue.number);
  }

  get filesCommitted(): string[] {
    return [...this.committed];
  }

  async execute(
    name: string,
    input: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    switch (name) {
      case "readFile":
        return this.readFile(requireString(input, "path"));
      case "writeFile":
        return this.writeFile(
          requireString(input, "path"),
          typeof input.content === "string" ? input.content : ""
        );
      case "listFiles":
        return this.listFiles(
          typeof input.prefix === "string" ? input.prefix : ""
        );
      case "searchCode":
        return {
          paths: await this.github.searchCode(
            this.owner,
            this.repo,
            requireString(input, "query")
          ),
        };
      case "getReviewFeedback":
        return this.getReviewFeedback();
      case "createPR":
        return this.createPR(
          requireString(input, "title"),
          requireString(input, "body")
        );
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  /** The ref to read from: the work branch on a rework, else the base. */
  private async readRef(): Promise<string> {
    if (this.context.issue.pullRequest) return this.branch;
    return this.base();
  }

  private async base(): Promise<string> {
    this.baseBranch ??= await this.github.getDefaultBranch(
      this.owner,
      this.repo
    );
    return this.baseBranch;
  }

  private async readFile(rawPath: string): Promise<Record<string, unknown>> {
    const path = normalizeRepoPath(rawPath);
    const pending = this.pending.get(path);
    if (pending !== undefined) return { path, content: pending };

    const content = await this.github.getFileContent(
      this.owner,
      this.repo,
      path,
      await this.readRef()
    );
    return content.length > MAX_FILE_CHARS
      ? { path, content: content.slice(0, MAX_FILE_CHARS), truncated: true }
      : { path, content };
  }

  private writeFile(rawPath: string, content: string): Record<string, unknown> {
    const path = normalizeRepoPath(rawPath);
    const verdict = checkPathPolicy(path, this.context.policy);
    if (verdict !== "allowed") {
      throw new Error(
        verdict === "protected"
          ? `${path} is a protected path and cannot be modified`
          : `${path} is outside the paths this agent may modify`
      );
    }

    const maxFiles = this.context.policy.thresholds.max_files_changed;
    if (!this.pending.has(path) && this.pending.size >= maxFiles) {
      throw new Error(`Cannot modify more than ${maxFiles} files for one issue`);
    }
    if (content.length > MAX_FILE_CHARS) {
      throw new Error(`${path} is too large to write (${content.length} chars)`);
    }

    this.pending.set(path, content);
    return { path, staged: true, stagedFiles: this.pending.size };
  }

  private async listFiles(prefix: string): Promise<Record<string, unknown>> {
    const all = await this.github.listFiles(
      this.owner,
      this.repo,
      await this.readRef()
    );
    const matching = prefix ? all.filter((p) => p.startsWith(prefix)) : all;
    return {
      paths: matching.slice(0, MAX_LISTED_FILES),
      truncated: matching.length > MAX_LISTED_FILES,
    };
  }

  private async getReviewFeedback(): Promise<Record<string, unknown>> {
    const pr = this.context.issue.pullRequest;
    if (!pr) return { comments: [] };
    const comments = await this.github.listComments(
      this.owner,
      this.repo,
      pr.number
    );
    return { comments: comments.slice(-MAX_FEEDBACK_COMMENTS) };
  }

  private async createPR(
    title: string,
    body: string
  ): Promise<Record<string, unknown>> {
    if (this.pending.size === 0) {
      throw new Error("No files have been written; nothing to commit");
    }

    const issue = this.context.issue;
    const base = await this.base();
    const files = [...this.pending].map(([path, content]) => ({ path, content }));

    await this.github.commitFiles(this.owner, this.repo, {
      branch: this.branch,
      baseBranch: base,
      message: `[code-monkey] ${title} (#${issue.number})`,
      files,
    });
    this.committed.push(...files.map((f) => f.path));
    this.pending.clear();

    const existing =
      issue.pullRequest ??
      (await this.github.findOpenPR(this.owner, this.repo, this.branch));
    const pr =
      existing ??
      (await this.github.createPR(this.owner, this.repo, {
        title,
        body: `${body}\n\nCloses #${issue.number}`,
        head: this.branch,
        base,
      }));

    this.pullRequest = { number: pr.number, url: pr.url, branch: this.branch };
    logger.info(`Pull request #${pr.number} ready for issue ${issue.id}`, {
      updatedExisting: Boolean(existing),
      files: files.length,
    });
    return { prNumber: pr.number, url: pr.url, branch: this.branch };
  }
}

export class ReviewerToolSession implements ToolSession {
  private readonly owner: string;
  private readonly repo: string;

  constructor(
    private readonly github: AgentGitHub,
    private readonly context: AgentContext
  ) {
    const { owner, name } = splitRepo(context.issue.repo);
    this.owner = owner;
    this.repo = name;
  }

  async execute(
    name: string,
    input: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const pr = this.context.issue.pullRequest;
    if (!pr) throw new Error("This issue has no pull request to review");

    switch (name) {
      case "get_pr_diff": {
        // Always the PR under review, whatever number the model supplies
        const files = await this.github.listPRFiles(
          this.owner,
          this.repo,
          pr.number
        );
        let budget = MAX_PATCH_CHARS;
        return {
          prNumber: pr.number,
          files: files.map((file) => {
            const patch = (file.patch ?? "").slice(0, Math.max(budget, 0));
            budget -= patch.length;
            return {
              filename: file.filename,
              status: file.status,
              additions: file.additions,
              deletions: file.deletions,
              patch,
              patchTruncated: patch.length < (file.patch ?? "").length,
            };
          }),
        };
      }
      case "get_file_content": {
        const path = normalizeRepoPath(requireString(input, "path"));
        const content = await this.github.getFileContent(
          this.owner,
          this.repo,
          path,
          pr.branch
        );
        return content.length > MAX_FILE_CHARS
          ? { path, content: content.slice(0, MAX_FILE_CHARS), truncated: true }
          : { path, content };
      }
      case "submit_review":
        return { received: true };
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }
}
