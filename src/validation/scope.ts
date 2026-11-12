import { minimatch } from "minimatch";
import type { AgentResult, ValidationResult, ValidationError } from "../types/index.js";
import type { PolicyConfig } from "../types/index.js";
import logger from "../logger.js";

export class ScopeValidator {
  /**
   * Ensures changes are scoped to the issue.
   * Checks diff doesn't touch unrelated files, stays within allowed paths.
   */
  async validate(
    result: AgentResult,
    policy: PolicyConfig,
    issueContext: { repo: string; relatedPaths: string[] }
  ): Promise<ValidationResult> {
    const errors: ValidationError[] = [];
    const warnings: string[] = [];

    // Collect all files modified by the agent
    const modifiedFiles: string[] = [];
    for (const tc of result.toolCalls) {
      if (tc.name !== "writeFile") continue;
      const path = typeof tc.input?.path === "string" ? tc.input.path : null;
      if (!path) continue;
      modifiedFiles.push(path);
    }

    // Check against protected paths
    for (const filePath of modifiedFiles) {
      for (const protectedPattern of policy.paths.protected) {
        if (minimatch(filePath, protectedPattern)) {
          errors.push({
            code: "PROTECTED_PATH",
            message: `Agent modified protected path: ${filePath} (matches ${protectedPattern})`,
            severity: "error",
            details: { path: filePath, pattern: protectedPattern },
          });
        }
      }
    }

    // Check against allowed paths
    const allowedPaths = policy.paths.allowed;

    for (const filePath of modifiedFiles) {
      const isAllowed = allowedPaths.some((pattern: string) =>
        minimatch(filePath, pattern)
      );
      if (!isAllowed) {
        errors.push({
          code: "OUT_OF_SCOPE_PATH",
          message: `Agent modified file outside allowed paths: ${filePath}`,
          severity: "error",
          details: { path: filePath, allowedPaths },
        });
      }
    }

    // Check diff size
    let totalLinesChanged = 0;
    for (const tc of result.toolCalls) {
      if (tc.name !== "writeFile") continue;
      const content = typeof tc.input?.content === "string" ? tc.input.content : null;
      if (!content) continue;
      totalLinesChanged += content.split("\n").length;
    }

    if (totalLinesChanged > policy.thresholds.max_diff_lines) {
      errors.push({
        code: "DIFF_TOO_LARGE",
        message: `Changes exceed max diff size: ${totalLinesChanged} > ${policy.thresholds.max_diff_lines}`,
        severity: "error",
        details: {
          actual: totalLinesChanged,
          max: policy.thresholds.max_diff_lines,
        },
      });
    }

    // Warn about unrelated file modifications
    if (issueContext.relatedPaths.length > 0) {
      for (const filePath of modifiedFiles) {
        const isRelated = issueContext.relatedPaths.some(
          (rp) => filePath.startsWith(rp) || rp.startsWith(filePath)
        );
        if (!isRelated) {
          warnings.push(
            `Modified file may be unrelated to issue: ${filePath}`
          );
        }
      }
    }

    const score =
      errors.length === 0 ? 1.0 : Math.max(0, 1 - errors.length * 0.3);

    logger.info("Scope validation complete", {
      score,
      modifiedFiles: modifiedFiles.length,
      errors: errors.length,
    });

    return {
      valid: errors.filter((e) => e.severity === "error").length === 0,
      score,
      errors,
      warnings,
    };
  }
}

/**
 * Normalizes a repository-relative path supplied by a model and rejects
 * anything that is not a plain path inside the repository.
 */
export function normalizeRepoPath(raw: string): string {
  const path = raw.trim().replace(/^\.\//, "");
  const segments = path.split("/");
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    segments.some((s) => s === "" || s === "." || s === "..") ||
    segments[0] === ".git"
  ) {
    throw new Error(`Invalid repository path: "${raw}"`);
  }
  return path;
}

export type PathVerdict = "allowed" | "protected" | "not_allowed";

/**
 * Decides whether policy lets an agent modify a path. Protected patterns also
 * match dotfiles; allowed patterns do not, so the stricter reading wins.
 */
export function checkPathPolicy(path: string, policy: PolicyConfig): PathVerdict {
  if (policy.paths.protected.some((p) => minimatch(path, p, { dot: true }))) {
    return "protected";
  }
  return policy.paths.allowed.some((p) => minimatch(path, p))
    ? "allowed"
    : "not_allowed";
}

export interface ChangedFile {
  filename: string;
  additions: number;
  deletions: number;
}

/**
 * Checks the files a pull request actually changes against policy. Unlike
 * ScopeValidator this uses what GitHub reports, not what the agent says it did.
 */
export function validateChangedFiles(
  files: ChangedFile[],
  policy: PolicyConfig
): ValidationResult {
  const errors: ValidationError[] = [];

  for (const file of files) {
    const verdict = checkPathPolicy(file.filename, policy);
    if (verdict === "protected") {
      errors.push({
        code: "PROTECTED_PATH",
        message: `Pull request modifies protected path: ${file.filename}`,
        severity: "error",
        details: { path: file.filename },
      });
    } else if (verdict === "not_allowed") {
      errors.push({
        code: "OUT_OF_SCOPE_PATH",
        message: `Pull request modifies a path outside the allowed set: ${file.filename}`,
        severity: "error",
        details: { path: file.filename },
      });
    }
  }

  const linesChanged = files.reduce(
    (sum, f) => sum + f.additions + f.deletions,
    0
  );
  if (linesChanged > policy.thresholds.max_diff_lines) {
    errors.push({
      code: "DIFF_TOO_LARGE",
      message: `Pull request changes ${linesChanged} lines; the limit is ${policy.thresholds.max_diff_lines}`,
      severity: "error",
      details: { actual: linesChanged, max: policy.thresholds.max_diff_lines },
    });
  }
  if (files.length > policy.thresholds.max_files_changed) {
    errors.push({
      code: "TOO_MANY_FILES",
      message: `Pull request changes ${files.length} files; the limit is ${policy.thresholds.max_files_changed}`,
      severity: "error",
      details: { actual: files.length, max: policy.thresholds.max_files_changed },
    });
  }
  if (files.length === 0) {
    errors.push({
      code: "EMPTY_PULL_REQUEST",
      message: "Pull request changes no files",
      severity: "error",
    });
  }

  return {
    valid: errors.length === 0,
    score: errors.length === 0 ? 1.0 : 0.0,
    errors,
    warnings: [],
  };
}
