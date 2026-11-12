import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  ApplyGuardrailCommand,
} from "@aws-sdk/client-bedrock-runtime";
import AnthropicBedrock from "@anthropic-ai/bedrock-sdk";
import type { MessageParam, Message } from "@anthropic-ai/sdk/resources/messages.js";
import logger from "../logger.js";
import type { ToolCall } from "../types/index.js";

async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxRetries = 3,
  baseDelayMs = 1000
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        logger.warn(`Retrying ${label} (attempt ${attempt + 1}/${maxRetries}) after ${delay}ms`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  logger.error(`All ${maxRetries} retries exhausted for ${label}, circuit open`);
  throw lastError;
}

export interface BedrockMessage {
  role: "user" | "assistant";
  content: string;
}

export interface BedrockTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface BedrockInvokeResult {
  content: string;
  toolCalls: ToolCall[];
  stopReason: string;
  tokensUsed: number;
}

export class BedrockClient {
  private runtimeClient: BedrockRuntimeClient;
  private anthropicClient: AnthropicBedrock;
  private guardrailId?: string;
  private guardrailVersion: string;

  constructor(config: {
    region: string;
    guardrailId?: string;
    guardrailVersion?: string;
  }) {
    // NOTE: Do NOT pass AWS_ENDPOINT_URL to Bedrock clients.
    // Bedrock is not available in LocalStack, so the endpoint must always
    // point to the real AWS Bedrock service.
    this.runtimeClient = new BedrockRuntimeClient({ region: config.region });
    this.anthropicClient = new AnthropicBedrock({
      awsRegion: config.region,
    });
    this.guardrailId = config.guardrailId;
    this.guardrailVersion = config.guardrailVersion ?? "DRAFT";
  }

  async invoke(
    modelId: string,
    messages: BedrockMessage[],
    tools: BedrockTool[],
    systemPrompt: string,
    options?: { maxIterations?: number; maxTokens?: number; onToolCall?: (name: string, input: Record<string, unknown>) => Promise<Record<string, unknown>> }
  ): Promise<BedrockInvokeResult> {
    const maxIterations = options?.maxIterations ?? 10;
    logger.info(`Invoking Bedrock model ${modelId}`, {
      messageCount: messages.length,
      toolCount: tools.length,
      maxIterations,
    });

    const allToolCalls: ToolCall[] = [];
    let totalTokens = 0;
    let finalContent = "";
    let currentMessages: MessageParam[] = messages.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      const response = await withRetry<Message>(
        () =>
          this.anthropicClient.messages.create({
            model: modelId,
            max_tokens: options?.maxTokens ?? 4096,
            stream: false,
            system: systemPrompt,
            messages: currentMessages,
            tools: tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.input_schema as { type: "object"; properties?: Record<string, unknown> },
            })),
          }),
        `bedrock.invoke(${modelId}, iteration=${iteration})`
      );

      totalTokens +=
        (response.usage?.input_tokens ?? 0) +
        (response.usage?.output_tokens ?? 0);

      const toolUseBlocks: Array<{ type: "tool_use"; id: string; name: string; input: Record<string, unknown> }> = [];

      for (const block of response.content) {
        if (block.type === "text") {
          finalContent += block.text;
        } else if (block.type === "tool_use" && block.id && block.name && block.input) {
          toolUseBlocks.push({
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: block.input as Record<string, unknown>,
          });
        }
      }

      // If no tool use or stop reason is end_turn, we are done
      if (response.stop_reason !== "tool_use" || toolUseBlocks.length === 0) {
        // Collect any final tool calls without execution
        for (const tb of toolUseBlocks) {
          allToolCalls.push({
            name: tb.name,
            input: tb.input,
            output: {},
            durationMs: 0,
          });
        }
        return {
          content: finalContent,
          toolCalls: allToolCalls,
          stopReason: response.stop_reason ?? "end_turn",
          tokensUsed: totalTokens,
        };
      }

      // Execute tool calls and build tool results for next iteration
      const toolResultContents: Array<{ type: "tool_result"; tool_use_id: string; content: string }> = [];

      for (const tb of toolUseBlocks) {
        const startMs = Date.now();
        let output: Record<string, unknown> = {};

        if (options?.onToolCall) {
          try {
            output = await options.onToolCall(tb.name, tb.input);
          } catch (error) {
            output = { error: String(error) };
          }
        }

        const durationMs = Date.now() - startMs;
        allToolCalls.push({
          name: tb.name,
          input: tb.input,
          output,
          durationMs,
        });

        toolResultContents.push({
          type: "tool_result",
          tool_use_id: tb.id,
          content: JSON.stringify(output),
        });
      }

      // Continue conversation with assistant response + tool results
      // Pass content blocks as native arrays, not JSON-stringified, per Anthropic SDK format
      currentMessages = [
        ...currentMessages,
        {
          role: "assistant" as const,
          content: response.content,
        } satisfies MessageParam,
        {
          role: "user" as const,
          content: toolResultContents,
        } satisfies MessageParam,
      ];
    }

    logger.warn(`Max iterations (${maxIterations}) reached for Bedrock invoke`);
    return {
      content: finalContent,
      toolCalls: allToolCalls,
      stopReason: "max_iterations",
      tokensUsed: totalTokens,
    };
  }

  async embed(text: string): Promise<number[]> {
    logger.debug("Generating embedding", {
      textLength: text.length,
    });

    return withRetry(async () => {
      const command = new InvokeModelCommand({
        modelId: "amazon.titan-embed-text-v2:0",
        contentType: "application/json",
        accept: "application/json",
        body: JSON.stringify({
          inputText: text,
          dimensions: 1024,
          normalize: true,
        }),
      });

      const response = await this.runtimeClient.send(command);
      const responseBody = JSON.parse(
        new TextDecoder().decode(response.body)
      ) as { embedding: number[] };
      return responseBody.embedding;
    }, "bedrock.embed");
  }

  async applyGuardrail(
    content: string
  ): Promise<{ action: string; score: number; outputs: string[] }> {
    if (!this.guardrailId) {
      // The caller decides whether a missing guardrail is acceptable
      logger.warn("No guardrail ID configured, guardrail check not run");
      return { action: "NOT_CONFIGURED", score: 1.0, outputs: [content] };
    }

    logger.debug("Applying guardrail", {
      guardrailId: this.guardrailId,
    });

    return withRetry(async () => {
      const command = new ApplyGuardrailCommand({
        guardrailIdentifier: this.guardrailId,
        guardrailVersion: this.guardrailVersion,
        source: "OUTPUT",
        content: [{ text: { text: content } }],
      });

      const response = await this.runtimeClient.send(command);

      return {
        action: response.action ?? "NONE",
        score: 1.0,
        outputs: response.outputs?.map((o) => o.text ?? "") ?? [],
      };
    }, "bedrock.applyGuardrail");
  }

  getModelForTask(
    taskType: "triage" | "coding" | "review",
    models: { triage: string; coding: string; review: string }
  ): string {
    return models[taskType];
  }
}
