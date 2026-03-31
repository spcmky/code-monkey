import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from "@aws-sdk/client-sqs";
import { randomUUID } from "node:crypto";
import { WatcherAgent } from "../agents/watcher.js";
import { TriageAgent } from "../agents/triage.js";
import { NotifierAgent } from "../agents/notifier.js";
import { BedrockClient } from "../tools/bedrock.js";
import { GitHubClient } from "../tools/github.js";
import { Store } from "../db/store.js";
import { PolicyEngine } from "./policy.js";
import {
  createTransition,
  clearTransitionHistory,
  getNextState,
} from "./state-machine.js";
import { ContextBuilder } from "../knowledge/context-builder.js";
import type {
  Issue,
  AgentResult,
  AgentType,
  TaskMessage,
  ValidationResult,
  ValidationError,
  IssueState,
} from "../types/index.js";
import type { AppConfig } from "../config/loader.js";
import logger from "../logger.js";

export class Controller {
  private watcher: WatcherAgent;
  private triageAgent: TriageAgent;
  private notifier: NotifierAgent;
  private bedrock: BedrockClient;
  private github: GitHubClient;
  private store: Store;
  private policy: PolicyEngine;
  private contextBuilder: ContextBuilder;
  private sqs: SQSClient;
  private config: AppConfig;

  constructor(config: AppConfig, store: Store) {
    this.config = config;
    this.store = store;

    this.bedrock = new BedrockClient({
      region: config.aws.region,
      guardrailId: config.aws.bedrockGuardrailId,
      guardrailVersion: config.aws.bedrockGuardrailVersion,
    });

    this.github = new GitHubClient({
      secretArn: config.aws.githubPatSecretArn,
      region: config.aws.region,
    });

    const configDir = process.env.CONFIG_DIR || "./config";
    this.policy = new PolicyEngine(`${configDir}/policy.yaml`);

    this.watcher = new WatcherAgent(
      this.github,
      this.store,
      config.watchedRepos
    );

    this.triageAgent = new TriageAgent(this.bedrock);

    this.notifier = new NotifierAgent({
      region: config.aws.region,
      topicArn: config.aws.snsEscalationTopicArn,
    });

    this.contextBuilder = new ContextBuilder(this.bedrock, this.store);

    this.sqs = new SQSClient({
      region: config.aws.region,
      ...(process.env.AWS_ENDPOINT_URL && { endpoint: process.env.AWS_ENDPOINT_URL }),
    });
  }

  async poll(): Promise<void> {
    logger.info("Controller poll cycle starting");

    try {
      // Step 1: Detect new issues
      const newIssues = await this.watcher.poll();

      // Step 2: Process each new issue through state machine
      for (const issue of newIssues) {
        await this.processIssue(issue);
      }

      // Step 3: Check for completed agent work (results queue)
      await this.processResults();

      logger.info("Controller poll cycle complete", {
        newIssues: newIssues.length,
      });
    } catch (error) {
      logger.error("Controller poll cycle failed", { error });
    }
  }

  private async processIssue(issue: Issue): Promise<void> {
    logger.info(`Processing issue ${issue.id}`, { state: issue.state });

    // Check if in scope
    if (!this.policy.canHandle(issue)) {
      logger.info(`Issue ${issue.id} not in policy scope, skipping`);
      return;
    }

    // Route based on current state
    switch (issue.state) {
      case "DETECTED": {
        // Triage the issue
        const context = await this.contextBuilder.build(issue, this.policy.getPolicy());
        const triageResult = await this.triageAgent.run(context);
        const triageOutput = triageResult.output as {
          suggestedAction?: string;
          classification?: string;
          priority?: string;
        };

        // Transition to TRIAGED
        createTransition(
          issue.state as IssueState,
          "TRIAGED",
          "triage_complete",
          "triage",
          issue.id
        );
        await this.store.updateIssueState(issue.id, "TRIAGED");

        // Decide next step based on triage
        if (triageOutput.suggestedAction === "implement") {
          await this.dispatch(issue, "coder");
        } else if (triageOutput.suggestedAction === "escalate") {
          await this.escalate(issue, "Triage recommended escalation");
        }
        break;
      }

      case "IMPLEMENTED": {
        // Send for review
        await this.dispatch(issue, "reviewer");
        createTransition(
          issue.state as IssueState,
          "UNDER_REVIEW",
          "review_started",
          "reviewer",
          issue.id
        );
        await this.store.updateIssueState(issue.id, "UNDER_REVIEW");
        break;
      }

      default:
        logger.debug(`No action for issue ${issue.id} in state ${issue.state}`);
    }
  }

  async dispatch(issue: Issue, agentType: AgentType): Promise<void> {
    logger.info(`Dispatching ${agentType} for issue ${issue.id}`);

    const context = await this.contextBuilder.build(issue, this.policy.getPolicy());

    const taskMessage: TaskMessage = {
      taskId: randomUUID(),
      issueId: issue.id,
      agentType,
      context,
      createdAt: new Date().toISOString(),
    };

    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.config.aws.sqsTaskQueueUrl,
        MessageBody: JSON.stringify(taskMessage),
        MessageGroupId: issue.id,
      })
    );

    logger.info(`Task ${taskMessage.taskId} dispatched to SQS`);
  }

  async validate(
    agentOutput: AgentResult,
    _context: Issue
  ): Promise<ValidationResult> {
    // TODO: run validation pipeline (grounding, scope, fact-check)
    logger.info(`Validating output from ${agentOutput.agentType}`);

    const errors: ValidationError[] = [];
    const warnings: string[] = [];

    // Basic validation — check success
    if (!agentOutput.success) {
      errors.push({
        code: "AGENT_FAILED",
        message: "Agent reported failure",
        severity: "error" as const,
      });
    }

    return {
      valid: errors.length === 0,
      score: errors.length === 0 ? 1.0 : 0.0,
      errors,
      warnings,
    };
  }

  async decide(
    issue: Issue,
    validatedOutput: AgentResult & { validation: ValidationResult }
  ): Promise<void> {
    // TODO: implement decision logic — merge, comment, escalate based on validation
    logger.info(`Making decision for issue ${issue.id}`, {
      valid: validatedOutput.validation.valid,
      score: validatedOutput.validation.score,
    });

    if (!validatedOutput.validation.valid) {
      await this.escalate(issue, "Validation failed");
      return;
    }

    const threshold = this.policy.getConfidenceThreshold();
    if (validatedOutput.validation.score < threshold) {
      await this.escalate(issue, "Confidence below threshold");
      return;
    }

    // If reviewer approved, merge
    if (validatedOutput.agentType === "reviewer") {
      const decision = (validatedOutput.output as { decision?: string })
        .decision;
      if (decision === "approve") {
        // TODO: trigger merge
        createTransition(
          issue.state as IssueState,
          "VALIDATED",
          "review_approved",
          "reviewer",
          issue.id
        );
        await this.store.updateIssueState(issue.id, "VALIDATED");
      } else if (decision === "request_changes") {
        createTransition(
          issue.state as IssueState,
          "IN_PROGRESS",
          "review_changes_requested",
          "reviewer",
          issue.id
        );
        await this.store.updateIssueState(issue.id, "IN_PROGRESS");
        await this.dispatch(issue, "coder");
      } else {
        await this.escalate(issue, "Reviewer escalated");
      }
    }
  }

  async escalate(issue: Issue, reason: string): Promise<void> {
    logger.warn(`Escalating issue ${issue.id}: ${reason}`);

    try {
      createTransition(
        issue.state as IssueState,
        "ESCALATED",
        "escalated",
        undefined,
        issue.id
      );
    } catch {
      // State might already be ESCALATED or CLOSED
    }

    await this.store.updateIssueState(issue.id, "ESCALATED");
    clearTransitionHistory(issue.id);
    await this.notifier.notifyEscalation(issue, reason);

    // Comment on the issue
    const [owner, repo] = issue.repo.split("/");
    if (owner && repo) {
      await this.github.createComment(
        owner,
        repo,
        issue.number,
        `This issue has been escalated for human review.\n\nReason: ${reason}`
      );
    }
  }

  private async processResults(): Promise<void> {
    // TODO: poll SQS result queue for completed agent work
    const response = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: this.config.aws.sqsResultQueueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
      })
    );

    for (const message of response.Messages ?? []) {
      try {
        let result: AgentResult;
        try {
          result = JSON.parse(message.Body ?? "{}") as AgentResult;
        } catch (parseError) {
          logger.error("Failed to parse result message JSON", {
            error: parseError instanceof Error ? parseError.message : String(parseError),
            messageBody: message.Body?.slice(0, 200),
          });
          continue;
        }

        const issue = await this.store.getIssue(result.issueId);
        if (!issue) {
          logger.warn(`Issue ${result.issueId} not found for result`);
          continue;
        }

        const validation = await this.validate(result, issue);
        await this.decide(issue, { ...result, validation });

        // Delete processed message
        if (message.ReceiptHandle) {
          await this.sqs.send(
            new DeleteMessageCommand({
              QueueUrl: this.config.aws.sqsResultQueueUrl,
              ReceiptHandle: message.ReceiptHandle,
            })
          );
        }
      } catch (error) {
        logger.error("Failed to process result message", { error });
      }
    }
  }
}
