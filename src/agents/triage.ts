import { BaseAgent } from "./base-agent.js";
import type { BedrockTool } from "../tools/bedrock.js";
import type { BedrockInvokeResult } from "../tools/bedrock.js";
import {
  IssueClassification,
  Priority,
} from "../types/index.js";
import type {
  AgentContext,
  AgentResult,
  AgentType,
} from "../types/index.js";
import { z } from "zod";
import logger from "../logger.js";

const TriageResultSchema = z.object({
  classification: z.enum(["bug", "feature", "question", "dependency", "out-of-scope"]),
  priority: z.enum(["critical", "high", "medium", "low"]),
  reasoning: z.string(),
  suggestedAction: z.enum(["implement", "question", "close", "escalate"]),
  suggestedLabels: z.array(z.string()),
});

export interface TriageResult {
  classification: IssueClassification;
  priority: Priority;
  reasoning: string;
  suggestedAction: "implement" | "question" | "close" | "escalate";
  suggestedLabels: string[];
}

export class TriageAgent extends BaseAgent {
  readonly name = "TriageAgent";
  readonly agentType: AgentType = "triage";
  readonly modelId = "anthropic.claude-haiku-4-5-v1:0";

  readonly systemPrompt = `You are a triage agent for a software project. Your job is to classify incoming GitHub issues.

For each issue, determine:
1. Classification: bug, feature, question, dependency, or out-of-scope
2. Priority: critical, high, medium, low
3. Suggested action: implement (for bugs/features we can handle), question (needs more info), close (duplicates/invalid), escalate (needs human)
4. Suggested labels to apply

Respond using the classify_issue tool with your analysis.`;

  readonly tools: BedrockTool[] = [
    {
      name: "classify_issue",
      description:
        "Submit the triage classification for an issue",
      input_schema: {
        type: "object",
        properties: {
          classification: {
            type: "string",
            enum: ["bug", "feature", "question", "dependency", "out-of-scope"],
          },
          priority: {
            type: "string",
            enum: ["critical", "high", "medium", "low"],
          },
          reasoning: { type: "string" },
          suggestedAction: {
            type: "string",
            enum: ["implement", "question", "close", "escalate"],
          },
          suggestedLabels: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: [
          "classification",
          "priority",
          "reasoning",
          "suggestedAction",
          "suggestedLabels",
        ],
      },
    },
  ];

  protected parseResponse(
    response: BedrockInvokeResult,
    context: AgentContext
  ): Omit<AgentResult, "durationMs"> {
    const triageCall = response.toolCalls.find(
      (tc) => tc.name === "classify_issue"
    );

    let triageResult: TriageResult;

    const defaultResult: TriageResult = {
      classification: IssueClassification.BUG,
      priority: Priority.MEDIUM,
      reasoning: "Triage output parsing failed - escalating",
      suggestedAction: "escalate" as const,
      suggestedLabels: [],
    };

    if (triageCall) {
      const parsed = TriageResultSchema.safeParse(triageCall.input);
      if (parsed.success) {
        triageResult = parsed.data;
      } else {
        logger.error("Failed to parse triage tool output, escalating", {
          issueId: context.issue.id,
          errors: parsed.error.format(),
        });
        triageResult = defaultResult;
      }
    } else {
      triageResult = {
        ...defaultResult,
        reasoning: response.content,
      };
    }

    return {
      success: true,
      agentType: this.agentType,
      issueId: context.issue.id,
      output: { ...triageResult } as Record<string, unknown>,
      reasoning: triageResult.reasoning,
      toolCalls: response.toolCalls,
      tokensUsed: response.tokensUsed,
    };
  }
}
