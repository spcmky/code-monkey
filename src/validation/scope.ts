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
