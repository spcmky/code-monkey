import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  type Message,
} from "@aws-sdk/client-sqs";
import { randomUUID } from "node:crypto";
import { WatcherAgent } from "../agents/watcher.js";
import { TriageAgent } from "../agents/triage.js";
import { NotifierAgent } from "../agents/notifier.js";
import { BedrockClient } from "../tools/bedrock.js";
import { GitHubClient } from "../tools/github.js";
import { Store } from "../db/store.js";
import { PolicyEngine } from "./policy.js";
import { createTransition, isValidTransition } from "./state-machine.js";
import { ContextBuilder } from "../knowledge/context-builder.js";
import { ScopeValidator } from "../validation/scope.js";
import { AgentResultSchema } from "../types/index.js";
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

/** Collaborators that tests (or alternative wiring) can replace. */
export interface ControllerDeps {
  watcher: Pick<WatcherAgent, "poll">;
  triageAgent: Pick<TriageAgent, "run">;
  notifier: Pick<NotifierAgent, "notifyEscalation">;
  github: Pick<GitHubClient, "createComment">;
  policy: PolicyEngine;
  contextBuilder: Pick<ContextBuilder, "build">;
  sqs: Pick<SQSClient, "send">;
}

// The state an issue must be in for a result from each agent to be current.
// The result must also carry the issue's current task id. Anything else is a
// duplicate or late delivery and is dropped.
const EXPECTED_STATE: Partial<Record<AgentType, IssueState>> = {
  coder: "IN_PROGRESS",
  reviewer: "UNDER_REVIEW",
};

// States where the controller may owe the next step. The poll loop re-reads
// all of them every cycle, so a hand-off interrupted by an error or a restart
// is picked up again. VALIDATED is absent until the merge step exists.
const RESUMABLE_STATES: IssueState[] = [
  "DETECTED",
  "TRIAGED",
  "ASSIGNED",
  "IMPLEMENTED",
  "IN_PROGRESS",
  "UNDER_REVIEW",
];

const REVIEW_LOOP_REASON = "Review loop limit reached";

export class Controller {
  private watcher: ControllerDeps["watcher"];
  private triageAgent: ControllerDeps["triageAgent"];
  private notifier: ControllerDeps["notifier"];
  private github: ControllerDeps["github"];
  private policy: PolicyEngine;
  private contextBuilder: ControllerDeps["contextBuilder"];
  private sqs: ControllerDeps["sqs"];
  private store: Store;
  private config: AppConfig;
  private scopeValidator = new ScopeValidator();
  private polling = false;

  constructor(
    config: AppConfig,
    store: Store,
    deps: Partial<ControllerDeps> = {}
  ) {
    this.config = config;
    this.store = store;

    const needsBedrock = !deps.triageAgent || !deps.contextBuilder;
    const bedrock = needsBedrock
      ? new BedrockClient({
          region: config.aws.region,
          guardrailId: config.aws.bedrockGuardrailId,
          guardrailVersion: config.aws.bedrockGuardrailVersion,
        })
      : undefined;

    const github =
      deps.github && deps.watcher
        ? undefined
        : new GitHubClient({
            secretArn: config.aws.githubPatSecretArn,
            region: config.aws.region,
          });

    const configDir = process.env.CONFIG_DIR || "./config";
    this.policy = deps.policy ?? new PolicyEngine(`${configDir}/policy.yaml`);

    this.github = deps.github ?? github!;
    this.watcher =
      deps.watcher ??
      new WatcherAgent(github!, this.store, config.watchedRepos);
    this.triageAgent = deps.triageAgent ?? new TriageAgent(bedrock!);
    this.contextBuilder =
      deps.contextBuilder ?? new ContextBuilder(bedrock!, this.store);

    this.notifier =
      deps.notifier ??
      new NotifierAgent({
        region: config.aws.region,
        topicArn: config.aws.snsEscalationTopicArn,
      });

    this.sqs =
      deps.sqs ??
      new SQSClient({
        region: config.aws.region,
        ...(process.env.AWS_ENDPOINT_URL && {
          endpoint: process.env.AWS_ENDPOINT_URL,
        }),
      });
  }

  async poll(): Promise<void> {
    if (this.polling) {
      logger.warn("Previous poll cycle still running, skipping this tick");
      return;
    }
    this.polling = true;
    logger.info("Controller poll cycle starting");

    try {
      // Step 1: Sync new and updated issues from GitHub
      const newIssues = await this.watcher.poll();

      // Step 2: Advance every issue that is waiting on the controller. Reading
      // from the store (not just this cycle's new issues) picks up issues that
      // came into scope after a label change and resumes interrupted hand-offs.
      for (const state of RESUMABLE_STATES) {
        const issues = await this.store.getIssuesByState(state);
        for (const issue of issues) {
          try {
            await this.processIssue(issue);
          } catch (error) {
            logger.error(`Failed to process issue ${issue.id}`, { error });
          }
        }
      }

      // Step 3: Handle completed agent work
      await this.processResults();

      logger.info("Controller poll cycle complete", {
        newIssues: newIssues.length,
      });
    } catch (error) {
      logger.error("Controller poll cycle failed", { error });
    } finally {
      this.polling = false;
    }
  }

  private async processIssue(issue: Issue): Promise<void> {
    switch (issue.state) {
      case "DETECTED":
        await this.triage(issue);
        break;
      case "TRIAGED":
        // Triage normally leaves TRIAGED within the same call. Finding an
        // issue here means that hand-off was interrupted, and the triage
        // decision was not persisted, so a human decides.
        await this.escalate(issue, "Hand-off interrupted after triage");
        break;
      case "ASSIGNED":
        await this.startCoder(issue, "work_started");
        break;
      case "IMPLEMENTED":
        await this.startReview(issue);
        break;
      case "IN_PROGRESS":
        // No outstanding task means the dispatch never happened
        if (!issue.currentTaskId) await this.dispatch(issue, "coder");
        break;
      case "UNDER_REVIEW":
        if (!issue.currentTaskId) await this.dispatch(issue, "reviewer");
        break;
      default:
        logger.debug(`No action for issue ${issue.id} in state ${issue.state}`);
    }
  }

  private async triage(issue: Issue): Promise<void> {
    if (this.policy.hasEscalationLabel(issue)) {
      await this.escalate(issue, "Issue carries an escalation label");
      return;
    }

    // Out-of-scope issues stay in DETECTED and are re-checked each cycle, so
    // adding an allowed label later brings them into the pipeline.
    if (!this.policy.canHandle(issue)) {
      logger.debug(`Issue ${issue.id} not in policy scope, skipping`);
      return;
    }

    logger.info(`Triaging issue ${issue.id}`);
    const context = await this.contextBuilder.build(
      issue,
      this.policy.getPolicy()
    );
    const result = await this.triageAgent.run(context);

    if (!result.success) {
      await this.escalate(issue, "Triage failed", result);
      return;
    }

    if (!(await this.transition(issue, "TRIAGED", "triage_complete", "triage"))) {
      return;
    }

    const output = result.output as {
      suggestedAction?: string;
      classification?: string;
      priority?: string;
    };
    if (output.classification && output.priority) {
      await this.store.updateIssueTriage(issue.id, {
        classification: output.classification,
        priority: output.priority,
      });
    }

    switch (output.suggestedAction) {
      case "implement":
        if (await this.transition(issue, "ASSIGNED", "assigned", "triage")) {
          await this.startCoder(issue, "work_started");
        }
        break;
      case "question":
        await this.escalate(
          issue,
          "Triage needs more information from the reporter",
          result
        );
        break;
      case "close":
        await this.escalate(issue, "Triage suggested closing this issue", result);
        break;
      default:
        await this.escalate(issue, "Triage recommended escalation", result);
    }
  }

  /**
   * Moves the issue to IN_PROGRESS and hands it to the coder. The state change
   * comes first and clears the issue's task id; if the dispatch then fails or
   * never runs, the poll loop sees IN_PROGRESS with no task and dispatches.
   */
  private async startCoder(issue: Issue, trigger: string): Promise<void> {
    if (issue.state !== "IN_PROGRESS") {
      const next = await this.transition(issue, "IN_PROGRESS", trigger);
      if (next !== "IN_PROGRESS") return;
    }
    await this.dispatch(issue, "coder");
  }

  /** Moves the issue to UNDER_REVIEW and hands it to the reviewer. */
  private async startReview(issue: Issue): Promise<void> {
    const next = await this.transition(
      issue,
      "UNDER_REVIEW",
      "review_started",
      "reviewer"
    );
    if (next === "UNDER_REVIEW") await this.dispatch(issue, "reviewer");
  }

  /**
   * The only place issue state changes. Persists the transition and returns
   * the state actually applied (which is ESCALATED when the review loop limit
   * forces it), or null if the issue had already moved on. A transition also
   * clears the issue's task id, so results for the state it left are stale.
   */
  private async transition(
    issue: Issue,
    to: IssueState,
    trigger: string,
    agentType?: AgentType,
    reason?: string
  ): Promise<IssueState | null> {
    const reviewCycles =
      issue.state === "UNDER_REVIEW" && to === "IN_PROGRESS"
        ? await this.store.countReviewCycles(issue.id)
        : 0;

    const transition = createTransition(
      issue.state,
      to,
      trigger,
      agentType,
      reviewCycles
    );

    // A forced escalation replaces the requested target, so it gets its own
    // reason rather than the caller's.
    const forced = transition.to !== to;
    const applied = await this.store.transitionIssue(
      issue.id,
      transition,
      forced ? REVIEW_LOOP_REASON : reason
    );
    if (!applied) return null;

    issue.state = transition.to;
    issue.currentTaskId = undefined;
    return transition.to;
  }

  async dispatch(issue: Issue, agentType: AgentType): Promise<void> {
    logger.info(`Dispatching ${agentType} for issue ${issue.id}`);

    const context = await this.contextBuilder.build(
      issue,
      this.policy.getPolicy()
    );

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

    // Recorded after the send: if this write is lost the issue has no task id,
    // the poll loop dispatches again, and the first task's result is dropped.
    await this.store.setCurrentTask(issue.id, taskMessage.taskId);
    issue.currentTaskId = taskMessage.taskId;

    logger.info(`Task ${taskMessage.taskId} dispatched to SQS`);
  }

  async validate(
    agentOutput: AgentResult,
    issue: Issue
  ): Promise<ValidationResult> {
    // TODO: add grounding and fact-check once agents run against a checkout
    logger.info(`Validating output from ${agentOutput.agentType}`);

    const errors: ValidationError[] = [];
    const warnings: string[] = [];
    let score = 1.0;

    if (!agentOutput.success) {
      errors.push({
        code: "AGENT_FAILED",
        message: "Agent reported failure",
        severity: "error" as const,
      });
      score = 0;
    }

    if (agentOutput.agentType === "coder") {
      const scope = await this.scopeValidator.validate(
        agentOutput,
        this.policy.getPolicy(),
        { repo: issue.repo, relatedPaths: [] }
      );
      errors.push(...scope.errors);
      warnings.push(...scope.warnings);
      score = Math.min(score, scope.score);
    }

    return {
      valid: errors.length === 0,
      score,
      errors,
      warnings,
    };
  }

  /** Validates an agent result and advances the issue accordingly. */
  async handleResult(issue: Issue, result: AgentResult): Promise<void> {
    const expected = EXPECTED_STATE[result.agentType];
    if (
      !expected ||
      issue.state !== expected ||
      !result.taskId ||
      result.taskId !== issue.currentTaskId
    ) {
      logger.warn(`Dropping stale ${result.agentType} result for issue ${issue.id}`, {
        state: issue.state,
        expected,
        taskId: result.taskId,
        currentTaskId: issue.currentTaskId,
      });
      return;
    }

    const validation = await this.validate(result, issue);
    logger.info(`Result validated for issue ${issue.id}`, {
      agentType: result.agentType,
      valid: validation.valid,
      score: validation.score,
    });

    if (!validation.valid) {
      const codes = [...new Set(validation.errors.map((e) => e.code))];
      await this.escalate(
        issue,
        `Validation failed (${codes.join(", ")})`,
        result
      );
      return;
    }

    if (validation.score < this.policy.getConfidenceThreshold()) {
      await this.escalate(issue, "Confidence below threshold", result);
      return;
    }

    if (result.agentType === "coder") {
      const next = await this.transition(
        issue,
        "IMPLEMENTED",
        "implementation_complete",
        "coder"
      );
      if (next === "IMPLEMENTED") await this.startReview(issue);
      return;
    }

    const decision = (result.output as { decision?: string }).decision;
    if (decision === "approve") {
      // TODO: trigger merge
      await this.transition(issue, "VALIDATED", "review_approved", "reviewer");
    } else if (decision === "request_changes") {
      const next = await this.transition(
        issue,
        "IN_PROGRESS",
        "review_changes_requested",
        "reviewer"
      );
      if (next === "ESCALATED") {
        await this.announceEscalation(issue, REVIEW_LOOP_REASON, result);
      } else if (next === "IN_PROGRESS") {
        await this.startCoder(issue, "review_changes_requested");
      }
    } else {
      await this.escalate(issue, "Reviewer escalated", result);
    }
  }

  async escalate(
    issue: Issue,
    reason: string,
    agentResult?: AgentResult
  ): Promise<void> {
    if (!isValidTransition(issue.state, "ESCALATED")) {
      logger.warn(`Cannot escalate issue ${issue.id} from state ${issue.state}`, {
        reason,
      });
      return;
    }

    logger.warn(`Escalating issue ${issue.id}: ${reason}`);
    const next = await this.transition(
      issue,
      "ESCALATED",
      "escalated",
      agentResult?.agentType,
      reason
    );
    // Only announce when this call made the change, so a redelivered message
    // cannot notify twice.
    if (next === "ESCALATED") {
      await this.announceEscalation(issue, reason, agentResult);
    }
  }

  /**
   * Tells humans about an escalation. The state change is already committed,
   * so failures here are logged rather than thrown.
   */
  private async announceEscalation(
    issue: Issue,
    reason: string,
    agentResult?: AgentResult
  ): Promise<void> {
    try {
      await this.notifier.notifyEscalation(issue, reason, agentResult);
    } catch (error) {
      logger.error(`Failed to send escalation notice for issue ${issue.id}`, {
        error,
      });
    }

    const [owner, repo] = issue.repo.split("/");
    if (!owner || !repo) return;
    try {
      await this.github.createComment(
        owner,
        repo,
        issue.number,
        `This issue has been escalated for human review.\n\nReason: ${reason}`
      );
    } catch (error) {
      logger.error(`Failed to comment on escalated issue ${issue.id}`, {
        error,
      });
    }
  }

  private async processResults(): Promise<void> {
    const response = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: this.config.aws.sqsResultQueueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
      })
    );

    for (const message of response.Messages ?? []) {
      try {
        const result = this.parseResult(message);
        if (result) {
          const issue = await this.store.getIssue(result.issueId);
          if (issue) {
            await this.handleResult(issue, result);
          } else {
            logger.warn(`Issue ${result.issueId} not found for result`);
          }
        }
        // Unparseable and orphaned results are deleted too: retrying them
        // cannot succeed.
        await this.deleteResult(message);
      } catch (error) {
        // Left on the queue for redelivery; the DLQ catches repeat failures
        logger.error("Failed to process result message", { error });
      }
    }
  }

  private parseResult(message: Message): AgentResult | null {
    let raw: unknown;
    try {
      raw = JSON.parse(message.Body ?? "");
    } catch (error) {
      logger.error("Result message is not valid JSON", {
        error,
        messageId: message.MessageId,
      });
      return null;
    }

    const parsed = AgentResultSchema.safeParse(raw);
    if (!parsed.success) {
      logger.error("Result message failed schema validation", {
        errors: parsed.error.format(),
        messageId: message.MessageId,
      });
      return null;
    }
    return parsed.data;
  }

  private async deleteResult(message: Message): Promise<void> {
    if (!message.ReceiptHandle) return;
    await this.sqs.send(
      new DeleteMessageCommand({
        QueueUrl: this.config.aws.sqsResultQueueUrl,
        ReceiptHandle: message.ReceiptHandle,
      })
    );
  }
}
