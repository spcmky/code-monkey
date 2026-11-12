import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import {
  ScopeValidator,
  checkPathPolicy,
  normalizeRepoPath,
  validateChangedFiles,
} from "./scope.js";
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

describe("normalizeRepoPath", () => {
  it("accepts plain repository paths", () => {
    expect(normalizeRepoPath("src/a.ts")).toBe("src/a.ts");
    expect(normalizeRepoPath("./src/a.ts")).toBe("src/a.ts");
  });

  it.each(["", "/abs", "../up", "a/../b", "a//b", "a\\b", ".git/config", "a/./b"])(
    "rejects %j",
    (path) => {
      expect(() => normalizeRepoPath(path)).toThrow(/Invalid repository path/);
    }
  );
});

describe("checkPathPolicy", () => {
  it("classifies paths", () => {
    expect(checkPathPolicy("src/a.ts", policy)).toBe("allowed");
    expect(checkPathPolicy("tofu/main.tf", policy)).toBe("protected");
    expect(checkPathPolicy("package.json", policy)).toBe("not_allowed");
  });

  it("protects dot-directories under a protected pattern", () => {
    expect(checkPathPolicy("src/secrets/.hidden/key", policy)).toBe("protected");
  });

  it("does not allow dotfiles through a broad allow pattern", () => {
    expect(checkPathPolicy("src/.env", policy)).toBe("not_allowed");
  });
});

describe("validateChangedFiles", () => {
  const file = (filename: string, additions = 1, deletions = 0) => ({
    filename,
    additions,
    deletions,
  });

  it("passes a small in-scope change", () => {
    expect(validateChangedFiles([file("src/a.ts", 10, 2)], policy).valid).toBe(true);
  });

  it("flags protected and out-of-scope paths", () => {
    const result = validateChangedFiles(
      [file(".github/workflows/ci.yml"), file("package.json")],
      policy
    );
    expect(result.errors.map((e) => e.code)).toEqual([
      "PROTECTED_PATH",
      "OUT_OF_SCOPE_PATH",
    ]);
  });

  it("counts additions and deletions against the diff limit", () => {
    const max = policy.thresholds.max_diff_lines;
    expect(validateChangedFiles([file("src/a.ts", max, 0)], policy).valid).toBe(true);
    expect(
      validateChangedFiles([file("src/a.ts", max, 1)], policy).errors.map((e) => e.code)
    ).toContain("DIFF_TOO_LARGE");
  });

  it("flags too many files and empty pull requests", () => {
    const many = Array.from(
      { length: policy.thresholds.max_files_changed + 1 },
      (_, i) => file(`src/f${i}.ts`)
    );
    expect(validateChangedFiles(many, policy).errors.map((e) => e.code)).toContain(
      "TOO_MANY_FILES"
    );
    expect(validateChangedFiles([], policy).errors.map((e) => e.code)).toContain(
      "EMPTY_PULL_REQUEST"
    );
  });
});
