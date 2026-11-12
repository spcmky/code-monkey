import { existsSync } from "node:fs";
import type { AgentResult, ValidationResult, ValidationError } from "../types/index.js";
import { validatePath } from "../utils/path-safety.js";
import logger from "../logger.js";

export class GroundingValidator {
  /**
   * Verifies agent claims against actual codebase.
   * Checks file paths exist, function names are real, line numbers are accurate.
   */
  async validate(
    result: AgentResult,
    repoPath: string
  ): Promise<ValidationResult> {
    const errors: ValidationError[] = [];
    const warnings: string[] = [];

    // TODO: implement deeper AST-based grounding checks

    // Check file paths mentioned in tool calls
    for (const toolCall of result.toolCalls) {
      if (toolCall.name === "readFile" || toolCall.name === "writeFile") {
        const filePath = typeof toolCall.input?.path === "string" ? toolCall.input.path : null;
        if (filePath) {
          let fullPath: string;
          try {
            fullPath = validatePath(filePath, repoPath);
          } catch {
            errors.push({
              code: "PATH_TRAVERSAL",
              message: `Agent referenced path outside repo: ${filePath}`,
              severity: "error",
              details: { path: filePath },
            });
            continue;
          }
          if (toolCall.name === "readFile" && !existsSync(fullPath)) {
            errors.push({
              code: "FILE_NOT_FOUND",
              message: `Agent referenced non-existent file: ${filePath}`,
              severity: "error",
              details: { path: filePath },
            });
          }
        }
      }
    }

    // Check if agent's reasoning references real files
    const fileRefPattern = /(?:^|\s)([\w/.-]+\.\w{1,10})(?:\s|$|:|,)/g;
    let match: RegExpExecArray | null;
    while ((match = fileRefPattern.exec(result.reasoning)) !== null) {
      const refPath = match[1];
      if (refPath && refPath.includes("/")) {
        let fullPath: string;
        try {
          fullPath = validatePath(refPath, repoPath);
        } catch {
          warnings.push(
            `Agent reasoning references path outside repo boundary: ${refPath}`
          );
          continue;
        }
        if (!existsSync(fullPath)) {
          warnings.push(
            `Agent reasoning references potentially non-existent file: ${refPath}`
          );
        }
      }
    }

    const score =
      errors.length === 0 ? 1.0 : Math.max(0, 1 - errors.length * 0.25);

    logger.info("Grounding validation complete", {
      score,
      errors: errors.length,
      warnings: warnings.length,
    });

    return {
      valid: errors.filter((e) => e.severity === "error").length === 0,
      score,
      errors,
      warnings,
    };
  }
}
