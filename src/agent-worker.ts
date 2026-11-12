import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";
import { loadAppConfig } from "./config/loader.js";
import { BedrockClient } from "./tools/bedrock.js";
import { GitHubClient } from "./tools/github.js";
import { TriageAgent } from "./agents/triage.js";
import { CoderAgent } from "./agents/coder.js";
import { ReviewerAgent } from "./agents/reviewer.js";
import { BaseAgent } from "./agents/base-agent.js";
import { TaskMessageSchema } from "./types/index.js";
import type { TaskMessage } from "./types/index.js";
import logger from "./logger.js";

async function main(): Promise<void> {
  logger.info("code-monkey agent worker starting");

  const config = loadAppConfig();
  logger.level = config.logLevel;

  const sqs = new SQSClient({
    region: config.aws.region,
    ...(process.env.AWS_ENDPOINT_URL && { endpoint: process.env.AWS_ENDPOINT_URL }),
  });
  const bedrock = new BedrockClient({
    region: config.aws.region,
    guardrailId: config.aws.bedrockGuardrailId,
    guardrailVersion: config.aws.bedrockGuardrailVersion,
  });

  // Agents act on repositories only through this client's API calls
  const github = new GitHubClient({
    secretArn: config.aws.githubPatSecretArn,
    region: config.aws.region,
  });

  // Agent registry
  const agents: Record<string, BaseAgent> = {
    triage: new TriageAgent(bedrock),
    coder: new CoderAgent(bedrock, github),
    reviewer: new ReviewerAgent(bedrock, github),
  };

  logger.info("Agent worker ready, polling for tasks");

  // Long-poll loop
  let running = true;

  const shutdown = () => {
    logger.info("Shutting down agent worker");
    running = false;
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  while (running) {
    try {
      const response = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: config.aws.sqsTaskQueueUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 20,
          VisibilityTimeout: 600, // 10 min for agent work
        })
      );

      if (!response.Messages || response.Messages.length === 0) {
        continue;
      }

      for (const message of response.Messages) {
        try {
          const raw = JSON.parse(message.Body ?? "{}") as unknown;
          const task = TaskMessageSchema.parse(raw) as TaskMessage;

          logger.info(`Received task ${task.taskId}`, {
            agentType: task.agentType,
            issueId: task.issueId,
          });

          const agent = agents[task.agentType];
          if (!agent) {
            logger.error(`Unknown agent type: ${task.agentType}`);
            continue;
          }

          // Run the agent
          const result = await agent.run(task.context);

          // Send result back
          await sqs.send(
            new SendMessageCommand({
              QueueUrl: config.aws.sqsResultQueueUrl,
              // taskId lets the controller match the result to its dispatch
              MessageBody: JSON.stringify({ ...result, taskId: task.taskId }),
              MessageAttributes: {
                taskId: {
                  DataType: "String",
                  StringValue: task.taskId,
                },
                agentType: {
                  DataType: "String",
                  StringValue: task.agentType,
                },
              },
            })
          );

          // Delete processed task
          if (message.ReceiptHandle) {
            try {
              await sqs.send(
                new DeleteMessageCommand({
                  QueueUrl: config.aws.sqsTaskQueueUrl,
                  ReceiptHandle: message.ReceiptHandle,
                })
              );
            } catch (deleteError) {
              logger.error("Failed to delete SQS message after processing", {
                error: deleteError instanceof Error ? deleteError.message : String(deleteError),
                messageId: message.MessageId ?? "unknown",
                taskId: task.taskId,
              });
            }
          }

          logger.info(`Task ${task.taskId} completed`, {
            success: result.success,
            durationMs: result.durationMs,
          });
        } catch (error) {
          const taskBody = (() => {
            try {
              return JSON.parse(message.Body ?? "{}") as { taskId?: string; agentType?: string; issueId?: string };
            } catch {
              return {};
            }
          })();
          logger.error("Failed to process task", {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            taskId: taskBody.taskId ?? "unknown",
            agentType: taskBody.agentType ?? "unknown",
            issueId: taskBody.issueId ?? "unknown",
          });
        }
      }
    } catch (error) {
      logger.error("Error polling for tasks", {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      // Brief pause before retrying on error
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }

  logger.info("Agent worker stopped");
}

main().catch((error) => {
  logger.error("Fatal error in agent worker", { error });
  process.exit(1);
});
