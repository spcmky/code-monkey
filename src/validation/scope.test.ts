import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { ScopeValidator } from "./scope.js";
import { loadPolicyConfig } from "../config/loader.js";
import type { AgentResult } from "../types/index.js";

const policy = loadPolicyConfig(
  fileURLToPath(new URL("../../config/policy.yaml", import.meta.url))
);

function resultWriting(files: Record<string, string>): AgentResult {
  return {
    success: true,
    agentType: "coder",
    issueId: "issue-1",
    output: {},
    reasoning: "",
    toolCalls: Object.entries(files).map(([path, content]) => ({
      name: "writeFile",
      input: { path, content },
      output: {},
      durationMs: 0,
    })),
    tokensUsed: 0,
    durationMs: 0,
  };
}

const context = { repo: "owner/repo", relatedPaths: [] };

describe("ScopeValidator", () => {
  const validator = new ScopeValidator();

  it("passes a small change inside allowed paths", async () => {
    const result = await validator.validate(
      resultWriting({ "src/a.ts": "export const a = 1;\n" }),
      policy,
      context
    );
    expect(result.valid).toBe(true);
    expect(result.score).toBe(1);
  });

  it("flags protected paths", async () => {
    const result = await validator.validate(
      resultWriting({ ".github/workflows/ci.yml": "on: push\n" }),
      policy,
      context
    );
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain("PROTECTED_PATH");
  });

  it("flags paths outside the allow list", async () => {
    const result = await validator.validate(
      resultWriting({ "package.json": "{}\n" }),
      policy,
      context
    );
    expect(result.errors.map((e) => e.code)).toContain("OUT_OF_SCOPE_PATH");
  });

  it("flags oversized changes", async () => {
    const big = "line\n".repeat(policy.thresholds.max_diff_lines + 1);
    const result = await validator.validate(
      resultWriting({ "src/big.ts": big }),
      policy,
      context
    );
    expect(result.errors.map((e) => e.code)).toContain("DIFF_TOO_LARGE");
  });

  it("warns about files unrelated to the issue", async () => {
    const result = await validator.validate(
      resultWriting({ "src/other/b.ts": "x\n" }),
      policy,
      { repo: "owner/repo", relatedPaths: ["src/feature/"] }
    );
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(1);
  });
});
