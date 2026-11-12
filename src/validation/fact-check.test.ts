import { describe, it, expect, vi } from "vitest";
import { FactChecker } from "./fact-check.js";
import type { AgentResult } from "../types/index.js";

const result: AgentResult = {
  success: true,
  agentType: "reviewer",
  issueId: "issue-1",
  output: {},
  reasoning: "Looks correct",
  toolCalls: [],
  tokensUsed: 1,
  durationMs: 1,
};

function checker(action: string, requireGuardrail = true): FactChecker {
  return new FactChecker(
    { applyGuardrail: vi.fn(async () => ({ action, score: 1, outputs: [] })) },
    0.7,
    requireGuardrail
  );
}

describe("FactChecker", () => {
  it("passes a result the guardrail lets through", async () => {
    const verdict = await checker("NONE").validate(result);
    expect(verdict.valid).toBe(true);
  });

  it("rejects a result the guardrail blocks", async () => {
    const verdict = await checker("BLOCKED").validate(result);
    expect(verdict.valid).toBe(false);
    expect(verdict.errors.map((e) => e.code)).toContain("GUARDRAIL_BLOCKED");
  });

  it("fails closed when no guardrail is configured", async () => {
    const verdict = await checker("NOT_CONFIGURED").validate(result);
    expect(verdict.valid).toBe(false);
    expect(verdict.errors.map((e) => e.code)).toContain(
      "GUARDRAIL_NOT_CONFIGURED"
    );
  });

  it("only warns about a missing guardrail when it is explicitly not required", async () => {
    const verdict = await checker("NOT_CONFIGURED", false).validate(result);
    expect(verdict.valid).toBe(true);
    expect(verdict.warnings).toHaveLength(1);
  });
});
