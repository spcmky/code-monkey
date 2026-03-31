import { BaseAgent } from "./base-agent.js";
import type { BedrockTool, BedrockInvokeResult } from "../tools/bedrock.js";
import type { AgentContext, AgentResult, AgentType } from "../types/index.js";
import { z } from "zod";
import logger from "../logger.js";

const CoderOutputSchema = z.object({
  content: z.string(),
  prCreated: z.boolean(),
  filesModified: z.array(z.string()),
});

export class CoderAgent extends BaseAgent {
  readonly name = "CoderAgent";
  readonly agentType: AgentType = "coder";
  readonly modelId = "anthropic.claude-sonnet-4-6-v1:0";

  readonly systemPrompt = `You are a coding agent for a software project. Your job is to implement fixes and features based on GitHub issues.

You have access to tools for reading files, writing files, running commands, and creating pull requests.

Follow these guidelines:
1. Understand the issue thoroughly before making changes
2. Make minimal, focused changes
3. Follow existing code patterns and style
4. Add or update tests for your changes
5. Run tests before creating a PR
6. Create clear, descriptive commit messages and PR descriptions

Use the provided tools to implement the fix.`;

  readonly tools: BedrockTool[] = [
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
      description: "Write content to a file in the repository",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to repo root" },
          content: { type: "string", description: "File content to write" },
        },
        required: ["path", "content"],
      },
    },
    {
      name: "runCommand",
      description: "Run a shell command in the repository directory",
      input_schema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Command to execute" },
        },
        required: ["command"],
      },
    },
    {
      name: "searchCode",
      description: "Search for a pattern in the codebase",
      input_schema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Search pattern (regex)" },
          fileGlob: { type: "string", description: "File glob to filter" },
        },
        required: ["pattern"],
      },
    },
    {
      name: "createBranch",
      description: "Create and checkout a new git branch",
      input_schema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Branch name" },
        },
        required: ["name"],
      },
    },
    {
      name: "createPR",
      description: "Create a pull request with the current changes",
      input_schema: {
        type: "object",
        properties: {
          title: { type: "string" },
          body: { type: "string" },
          base: { type: "string", description: "Base branch (default: main)" },
        },
        required: ["title", "body"],
      },
    },
  ];

  protected parseResponse(
    response: BedrockInvokeResult,
    context: AgentContext
  ): Omit<AgentResult, "durationMs"> {
    const prCall = response.toolCalls.find((tc) => tc.name === "createPR");

    const rawOutput = {
      content: response.content,
      prCreated: !!prCall,
      filesModified: response.toolCalls
        .filter((tc) => tc.name === "writeFile")
        .map((tc) => typeof tc.input?.path === "string" ? tc.input.path : "")
        .filter(Boolean),
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
        toolCalls: response.toolCalls,
        tokensUsed: response.tokensUsed,
      };
    }

    return {
      success: !!prCall,
      agentType: this.agentType,
      issueId: context.issue.id,
      output: parsed.data,
      reasoning: response.content,
      toolCalls: response.toolCalls,
      tokensUsed: response.tokensUsed,
    };
  }
}
