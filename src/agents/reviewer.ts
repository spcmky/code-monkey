import { BaseAgent } from "./base-agent.js";
import type { BedrockTool, BedrockInvokeResult } from "../tools/bedrock.js";
import type { AgentContext, AgentResult, AgentType } from "../types/index.js";
import { ReviewerToolSession, type ToolSession } from "../tools/executor.js";
import { z } from "zod";
import logger from "../logger.js";

const ReviewCommentSchema = z.object({
  path: z.string(),
  line: z.number(),
  body: z.string(),
  severity: z.enum(["error", "warning", "suggestion"]),
});

const ReviewResultSchema = z.object({
  decision: z.enum(["approve", "request_changes", "escalate"]),
  reasoning: z.string(),
  comments: z.array(ReviewCommentSchema),
  scopeCheck: z.boolean(),
  testsPresent: z.boolean(),
  styleOk: z.boolean(),
});

export type ReviewDecision = "approve" | "request_changes" | "escalate";

export interface ReviewResult {
  decision: ReviewDecision;
  reasoning: string;
  comments: ReviewComment[];
  scopeCheck: boolean;
  testsPresent: boolean;
  styleOk: boolean;
}

export interface ReviewComment {
  path: string;
  line: number;
  body: string;
  severity: "error" | "warning" | "suggestion";
}

export class ReviewerAgent extends BaseAgent {
  readonly name = "ReviewerAgent";
  readonly agentType: AgentType = "reviewer";
  readonly modelId = "anthropic.claude-sonnet-4-6-v1:0";

  readonly systemPrompt = `You are a code review agent. Review pull requests for:

1. Correctness — does the code fix the issue? Are there bugs?
2. Scope — are changes limited to what's needed? No unrelated modifications?
3. Tests — are new/modified tests included? Do they cover the changes?
4. Style — does the code follow project conventions?
5. Security — any security concerns?

Start with get_pr_diff to see what the pull request changes, and use get_file_content to read changed files in full. Base the review on what the code does, not on the pull request's description of itself. Then use the submit_review tool to provide your review decision and comments.`;

  readonly tools: BedrockTool[] = [
    {
      name: "get_pr_diff",
      description: "Get the files and patches changed by the pull request under review",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "get_file_content",
      description: "Get the content of a file on the pull request's branch",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
        required: ["path"],
      },
    },
    {
      name: "submit_review",
      description: "Submit your review decision",
      input_schema: {
        type: "object",
        properties: {
          decision: {
            type: "string",
            enum: ["approve", "request_changes", "escalate"],
          },
          reasoning: { type: "string" },
          comments: {
            type: "array",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                line: { type: "number" },
                body: { type: "string" },
                severity: {
                  type: "string",
                  enum: ["error", "warning", "suggestion"],
                },
              },
              required: ["path", "line", "body", "severity"],
            },
          },
          scopeCheck: { type: "boolean" },
          testsPresent: { type: "boolean" },
          styleOk: { type: "boolean" },
        },
        required: [
          "decision",
          "reasoning",
          "comments",
          "scopeCheck",
          "testsPresent",
          "styleOk",
        ],
      },
    },
  ];

  protected override createToolSession(
    context: AgentContext
  ): ToolSession | undefined {
    return this.github
      ? new ReviewerToolSession(this.github, context)
      : undefined;
  }

  protected parseResponse(
    response: BedrockInvokeResult,
    context: AgentContext
  ): Omit<AgentResult, "durationMs"> {
    const reviewCall = response.toolCalls.find(
      (tc) => tc.name === "submit_review"
    );

    let reviewResult: ReviewResult;

    if (reviewCall) {
      const parsed = ReviewResultSchema.safeParse(reviewCall.input);
      if (parsed.success) {
        reviewResult = parsed.data;
      } else {
        logger.error("Failed to parse review tool output, escalating", {
          issueId: context.issue.id,
          errors: parsed.error.format(),
        });
        reviewResult = {
          decision: "escalate" as ReviewDecision,
          reasoning: "Review output parsing failed - escalating",
          comments: [],
          scopeCheck: false,
          testsPresent: false,
          styleOk: false,
        };
      }
    } else {
      reviewResult = {
        decision: "escalate" as ReviewDecision,
        reasoning: response.content || "Unable to complete review",
        comments: [],
        scopeCheck: false,
        testsPresent: false,
        styleOk: false,
      };
    }

    return {
      success: true,
      agentType: this.agentType,
      issueId: context.issue.id,
      output: { ...reviewResult, comments: [...reviewResult.comments] } as Record<string, unknown>,
      reasoning: reviewResult.reasoning,
      toolCalls: response.toolCalls,
      tokensUsed: response.tokensUsed,
    };
  }
}
