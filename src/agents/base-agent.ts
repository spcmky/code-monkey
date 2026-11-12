import {
  BedrockClient,
  type BedrockMessage,
  type BedrockTool,
  type BedrockInvokeResult,
} from "../tools/bedrock.js";
import type { AgentContext, AgentResult, AgentType } from "../types/index.js";
import logger from "../logger.js";

export abstract class BaseAgent {
  abstract readonly name: string;
  abstract readonly agentType: AgentType;
  abstract readonly systemPrompt: string;
  abstract readonly tools: BedrockTool[];
  abstract readonly modelId: string;

  protected bedrock: BedrockClient;

  constructor(bedrock: BedrockClient) {
    this.bedrock = bedrock;
  }

  async run(context: AgentContext): Promise<AgentResult> {
    const startTime = Date.now();
    logger.info(`Agent ${this.name} starting`, {
      issueId: context.issue.id,
    });

    try {
      const messages = this.buildMessages(context);
      const response = await this.bedrock.invoke(
        this.modelId,
        messages,
        this.tools,
        this.systemPrompt
      );

      // TODO: implement tool execution loop — execute tool calls, feed results back, repeat until done
      const result = this.parseResponse(response, context);
      const durationMs = Date.now() - startTime;

      logger.info(`Agent ${this.name} completed`, {
        issueId: context.issue.id,
        durationMs,
        toolCalls: result.toolCalls.length,
      });

      return {
        ...result,
        durationMs,
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      logger.error(`Agent ${this.name} failed`, {
        issueId: context.issue.id,
        error,
      });
      return {
        success: false,
        agentType: this.agentType,
        issueId: context.issue.id,
        output: { error: String(error) },
        reasoning: "Agent execution failed",
        toolCalls: [],
        tokensUsed: 0,
        durationMs,
      };
    }
  }

  protected buildMessages(context: AgentContext): BedrockMessage[] {
    // TODO: optimize context window usage, include repo map, similar issues
    const userMessage = [
      `## Issue #${context.issue.number}: ${context.issue.title}`,
      "",
      context.issue.body,
      "",
      `Labels: ${context.issue.labels.join(", ")}`,
      `Repository: ${context.issue.repo}`,
      "",
      "## Relevant Files",
      ...context.relevantFiles.map(
        (f) => `### ${f.path}\n\`\`\`${f.language}\n${f.content}\n\`\`\``
      ),
    ].join("\n");

    return [{ role: "user", content: userMessage }];
  }

  protected abstract parseResponse(
    response: BedrockInvokeResult,
    context: AgentContext
  ): Omit<AgentResult, "durationMs">;
}
