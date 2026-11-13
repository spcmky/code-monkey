import { BaseAgent } from "./base-agent.js";
import type { BedrockTool, BedrockInvokeResult } from "../tools/bedrock.js";
import type { AgentContext, AgentResult, AgentType } from "../types/index.js";
import { CoderToolSession, type ToolSession } from "../tools/executor.js";
import { z } from "zod";
import logger from "../logger.js";

const CoderOutputSchema = z.object({
  content: z.string(),
  prCreated: z.boolean(),
  prNumber: z.number().int().positive().optional(),
  prUrl: z.string().optional(),
  branch: z.string().optional(),
  filesModified: z.array(z.string()),
});

export class CoderAgent extends BaseAgent {
  readonly name = "CoderAgent";
  readonly agentType: AgentType = "coder";
  readonly modelId = "anthropic.claude-sonnet-4-6-v1:0";

  // Whole files are written in a single tool call
  protected override readonly maxTokens = 8192;
  protected override readonly maxIterations = 30;

  readonly systemPrompt = `You are a coding agent for a software project. Your job is to implement fixes and features based on GitHub issues.

You work through the tools provided. They read from and commit to the repository through the GitHub API. You cannot run commands or tests; the repository's CI runs on the pull request you open.

Follow these guidelines:
1. Explore before changing anything: use listFiles, searchCode and readFile to understand the code involved
2. If the issue already has a pull request, call getReviewFeedback first and address what the reviewer asked for
3. Make minimal, focused changes that follow existing patterns and style
4. Add or update tests for your changes
5. writeFile stages the complete new contents of one file; nothing is committed until createPR
6. Call createPR once, when every file is staged, with a clear title and description

writeFile refuses paths that policy protects or does not allow. If the fix needs such a file, stop and explain why instead of working around it.`;

  readonly tools: BedrockTool[] = [
    {
      name: "listFiles",
      description: "List file paths in the repository, optionally under a prefix",
      input_schema: {
        type: "object",
        properties: {
          prefix: { type: "string", description: "Path prefix, e.g. src/api/" },
        },
      },
    },
    {
      name: "searchCode",
      description:
        "Search the default branch for code matching a query; returns file paths",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search terms" },
        },
        required: ["query"],
      },
    },
    {
      name: "readFile",
      description: "Read the contents of a file in the repository",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to repo root" },
        },
        required: ["path"],
      },
    },
    {
      name: "writeFile",
      description:
        "Stage the complete new contents of a file. Committed when createPR is called.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to repo root" },
          content: { type: "string", description: "Complete file contents" },
        },
        required: ["path", "content"],
      },
    },
    {
      name: "getReviewFeedback",
      description:
        "Get the changes the automated reviewer requested on this issue's pull request, if any",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "createPR",
      description:
        "Commit all staged files to the issue's branch and open (or update) its pull request",
      input_schema: {
        type: "object",
        properties: {
          title: { type: "string" },
          body: { type: "string" },
        },
        required: ["title", "body"],
      },
    },
  ];

  protected override createToolSession(
    context: AgentContext
  ): ToolSession | undefined {
    return this.github ? new CoderToolSession(this.github, context) : undefined;
  }

  protected parseResponse(
    response: BedrockInvokeResult,
    context: AgentContext,
    session?: ToolSession
  ): Omit<AgentResult, "durationMs"> {
    // Only a pull request the tool session really opened counts as success;
    // the model saying it called createPR does not.
    const coderSession =
      session instanceof CoderToolSession ? session : undefined;
    const pr = coderSession?.pullRequest;

    // File contents are in the pull request; keep them out of the result
    // message, which travels over SQS.
    const toolCalls = response.toolCalls.map((tc) =>
      tc.name === "writeFile"
        ? {
            ...tc,
            input: {
              path: tc.input?.path,
              lines:
                typeof tc.input?.content === "string"
                  ? tc.input.content.split("\n").length
                  : 0,
            },
          }
        : tc
    );

    const rawOutput = {
      content: response.content,
      prCreated: Boolean(pr),
      prNumber: pr?.number,
      prUrl: pr?.url,
      branch: pr?.branch,
      filesModified: coderSession?.filesCommitted ?? [],
    };

    const parsed = CoderOutputSchema.safeParse(rawOutput);
    if (!parsed.success) {
      logger.error("Failed to parse coder output, escalating", {
        issueId: context.issue.id,
        errors: parsed.error.format(),
      });
      return {
        success: false,
        agentType: this.agentType,
        issueId: context.issue.id,
        output: { error: "Coder output parsing failed" },
        reasoning: "Coder output parsing failed - escalating",
        toolCalls,
        tokensUsed: response.tokensUsed,
      };
    }

    return {
      success: Boolean(pr),
      agentType: this.agentType,
      issueId: context.issue.id,
      output: parsed.data,
      reasoning: response.content,
      toolCalls,
      tokensUsed: response.tokensUsed,
    };
  }
}
