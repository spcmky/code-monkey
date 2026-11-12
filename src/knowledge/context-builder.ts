import { BedrockClient } from "../tools/bedrock.js";
import { Store } from "../db/store.js";
import { RepoMap } from "./repo-map.js";
import type {
  Issue,
  AgentContext,
  PolicyConfig,
  FileContent,
  RepoProfile,
} from "../types/index.js";
import logger from "../logger.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { validatePath } from "../utils/path-safety.js";

const MAX_CONTEXT_CHARS = 100_000;

export class ContextBuilder {
  private bedrock: BedrockClient;
  private store: Store;
  private repoMap: RepoMap;

  constructor(bedrock: BedrockClient, store: Store) {
    this.bedrock = bedrock;
    this.store = store;
    this.repoMap = new RepoMap();
  }

  async build(issue: Issue, policy: PolicyConfig): Promise<AgentContext> {
    logger.info(`Building context for issue ${issue.id}`);

    const repoProfile = this.getRepoProfile(issue.repo);
    const relevantFiles = await this.getRelevantFiles(issue);
    const similarIssues = await this.getSimilarIssues(issue);

    // Trim context to stay within token budget
    const trimmedFiles = this.trimToFit(relevantFiles, MAX_CONTEXT_CHARS);

    logger.info(`Context built for issue ${issue.id}`, {
      relevantFiles: trimmedFiles.length,
      similarIssues: similarIssues.length,
    });

    return {
      issue,
      relevantFiles: trimmedFiles,
      similarIssues,
      repoProfile,
      policy,
    };
  }

  private async getRelevantFiles(issue: Issue): Promise<FileContent[]> {
    const workDir = process.env.WORK_DIR ?? "/tmp/code-monkey-workspaces";
    if (!workDir.startsWith("/")) {
      logger.error("WORK_DIR must be an absolute path", { workDir });
      return [];
    }
    const repoPath = join(workDir, issue.repo.replace("/", "_"));
    // Validate repoPath stays within workDir
    try {
      validatePath(issue.repo.replace("/", "_"), workDir);
    } catch (error) {
      logger.error("Repo path escapes work directory", { repoPath, error: String(error) });
      return [];
    }

    try {
      // Build repo map if not cached
      await this.repoMap.build(repoPath);

      // Find relevant files based on issue content
      const query = `${issue.title} ${issue.body}`;
      const relevant = this.repoMap.getRelevantFiles(repoPath, query);

      return relevant.slice(0, 10).map((fileInfo) => {
        // Validate file path stays within repo directory
        const fullPath = validatePath(fileInfo.path, repoPath);
        let content = "";
        try {
          content = readFileSync(fullPath, "utf-8");
        } catch (readErr) {
          logger.debug("Unable to read file for context", {
            path: fileInfo.path,
            error: String(readErr),
          });
          content = "// Unable to read file";
        }
        return {
          path: fileInfo.path,
          content,
          language: fileInfo.language,
        };
      });
    } catch (error) {
      logger.warn(`Repo map failed for ${issue.repo}, returning empty context`, {
        error: String(error),
      });
      // Return empty context as graceful degradation
      return [];
    }
  }

  private async getSimilarIssues(_issue: Issue): Promise<Issue[]> {
    // TODO: use embedding similarity search
    // For now, return empty — will be populated when history grows
    return [];
  }

  private getRepoProfile(repo: string): RepoProfile {
    // TODO: detect from repo contents (package.json, go.mod, etc.)
    const workDir = process.env.WORK_DIR ?? "/tmp/code-monkey-workspaces";
    if (!workDir.startsWith("/")) {
      logger.warn("WORK_DIR must be an absolute path", { workDir });
      return { name: repo, language: "unknown" };
    }
    let repoPath: string;
    try {
      repoPath = validatePath(repo.replace("/", "_"), workDir);
    } catch (error) {
      logger.warn("Repo path escapes work directory", { repo, error: String(error) });
      return { name: repo, language: "unknown" };
    }
    const pkgPath = join(repoPath, "package.json");

    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
          name?: string;
          scripts?: Record<string, string>;
        };
        return {
          name: repo,
          language: "typescript",
          framework: undefined,
          testCommand: pkg.scripts?.test ? "npm test" : undefined,
          buildCommand: pkg.scripts?.build ? "npm run build" : undefined,
          lintCommand: pkg.scripts?.lint ? "npm run lint" : undefined,
        };
      } catch (error) {
        logger.debug("Failed to parse package.json for repo profile", {
          repo,
          error: String(error),
        });
      }
    }

    return {
      name: repo,
      language: "unknown",
    };
  }

  private trimToFit(
    files: FileContent[],
    maxChars: number
  ): FileContent[] {
    const result: FileContent[] = [];
    let totalChars = 0;

    for (const file of files) {
      const fileChars = file.content.length + file.path.length;
      if (totalChars + fileChars > maxChars) {
        // Truncate this file
        const remaining = maxChars - totalChars;
        if (remaining > 200) {
          result.push({
            ...file,
            content:
              file.content.slice(0, remaining) + "\n// ... truncated ...",
          });
        }
        break;
      }
      totalChars += fileChars;
      result.push(file);
    }

    return result;
  }
}
