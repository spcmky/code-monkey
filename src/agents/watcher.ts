import { GitHubClient, type GitHubIssue } from "../tools/github.js";
import type { Issue, IssueState } from "../types/index.js";
import { Store } from "../db/store.js";
import logger from "../logger.js";
import { z } from "zod";

const GitHubIssueInputSchema = z.object({
  id: z.number().int().positive(),
  number: z.number().int().positive(),
  title: z.string().max(1000),
  body: z.string().max(100_000).nullable(),
  labels: z.array(z.string().max(200)),
  state: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  url: z.string().url(),
});

const RepoFormatSchema = z.string().regex(
  /^[\w-]+\/[\w-]+$/,
  "Repo must match owner/repo format"
);

export class WatcherAgent {
  private github: GitHubClient;
  private store: Store;
  private watchedRepos: string[];

  constructor(github: GitHubClient, store: Store, watchedRepos: string[]) {
    this.github = github;
    this.store = store;
    this.watchedRepos = watchedRepos;
  }

  async poll(): Promise<Issue[]> {
    logger.info("Watcher polling for new/updated issues");
    const detectedIssues: Issue[] = [];

    for (const repoFull of this.watchedRepos) {
      const repoValid = RepoFormatSchema.safeParse(repoFull);
      if (!repoValid.success) {
        logger.warn(`Invalid repo format: ${repoFull}, expected owner/repo`);
        continue;
      }
      const [owner, repo] = repoFull.split("/");
      if (!owner || !repo) {
        continue;
      }

      try {
        const issues = await this.github.listIssues(owner, repo, {
          state: "open",
        });

        for (const ghIssue of issues) {
          // Validate GitHub issue data before storing
          const parsed = GitHubIssueInputSchema.safeParse(ghIssue);
          if (!parsed.success) {
            logger.warn(`Invalid issue data from ${repoFull}#${ghIssue.number}`, {
              errors: parsed.error.format(),
            });
            continue;
          }

          const existing = await this.store.getIssueByRepoAndNumber(
            owner,
            repo,
            ghIssue.number
          );
          if (existing) {
            // Pick up edits and label changes; pipeline state is preserved
            if (new Date(ghIssue.updatedAt) > existing.updatedAt) {
              await this.store.upsertIssue(this.toIssue(repoFull, ghIssue));
              logger.debug(`Issue refreshed: ${repoFull}#${ghIssue.number}`);
            }
            continue;
          }

          const issueData = this.toIssue(repoFull, ghIssue);
          await this.store.upsertIssue(issueData);
          // Retrieve the DB-stored issue with its generated UUID
          const storedIssue = await this.store.getIssueByRepoAndNumber(owner, repo, ghIssue.number);
          if (storedIssue) {
            detectedIssues.push(storedIssue);
          }
          logger.info(`New issue detected: ${repoFull}#${ghIssue.number}`);
        }
      } catch (error) {
        logger.error(`Failed to poll ${repoFull}`, { error });
      }
    }

    logger.info(`Watcher found ${detectedIssues.length} new issues`);
    return detectedIssues;
  }

  private toIssue(repo: string, ghIssue: GitHubIssue): Omit<Issue, "id"> {
    return {
      githubId: ghIssue.id,
      repo,
      number: ghIssue.number,
      title: ghIssue.title,
      body: ghIssue.body ?? "",
      author: ghIssue.user?.login ?? "unknown",
      labels: ghIssue.labels,
      state: "DETECTED" as IssueState,
      createdAt: new Date(ghIssue.createdAt),
      updatedAt: new Date(ghIssue.updatedAt),
      url: ghIssue.url,
    };
  }
}
