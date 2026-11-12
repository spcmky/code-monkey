import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { PolicyEngine } from "./policy.js";
import type { Issue } from "../types/index.js";

const policyPath = fileURLToPath(
  new URL("../../config/policy.yaml", import.meta.url)
);

function issueWith(labels: string[]): Issue {
  return {
    id: "issue-1",
    githubId: 1,
    repo: "owner/repo",
    number: 1,
    title: "title",
    body: "body",
    author: "someone",
    labels,
    state: "DETECTED",
    createdAt: new Date(),
    updatedAt: new Date(),
    url: "https://github.com/owner/repo/issues/1",
  };
}

describe("PolicyEngine", () => {
  const policy = new PolicyEngine(policyPath);

  describe("canHandle", () => {
    it("accepts an issue with an allowed label", () => {
      expect(policy.canHandle(issueWith(["bug"]))).toBe(true);
    });

    it("rejects an issue with no allowed label", () => {
      expect(policy.canHandle(issueWith([]))).toBe(false);
      expect(policy.canHandle(issueWith(["random"]))).toBe(false);
    });

    it("rejects an escalation label even alongside an allowed one", () => {
      expect(policy.canHandle(issueWith(["bug", "security"]))).toBe(false);
    });

    it("rejects auto-close labels", () => {
      expect(policy.canHandle(issueWith(["bug", "wontfix"]))).toBe(false);
    });
  });

  describe("isPathAllowed", () => {
    it("allows source and test paths", () => {
      expect(policy.isPathAllowed("src/index.ts")).toBe(true);
      expect(policy.isPathAllowed("tests/unit/a.test.ts")).toBe(true);
    });

    it("blocks protected paths", () => {
      expect(policy.isPathAllowed(".github/workflows/ci.yml")).toBe(false);
      expect(policy.isPathAllowed("package-lock.json")).toBe(false);
      expect(policy.isPathAllowed("tofu/main.tf")).toBe(false);
      expect(policy.isPathAllowed("src/secrets/key.ts")).toBe(false);
    });

    it("blocks paths outside the allow list", () => {
      expect(policy.isPathAllowed("package.json")).toBe(false);
      expect(policy.isPathAllowed("scripts/deploy.sh")).toBe(false);
    });
  });
});
