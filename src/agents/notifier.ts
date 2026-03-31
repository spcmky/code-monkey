import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import logger from "../logger.js";
import type { Issue, AgentResult } from "../types/index.js";

export interface NotificationPayload {
  issueId: string;
  issueUrl: string;
  title: string;
  reason: string;
  agentReasoning: string;
  recommendedAction: string;
  severity: "info" | "warning" | "critical";
}

export class NotifierAgent {
  private sns: SNSClient;
  private topicArn: string;

  constructor(config: { region: string; topicArn: string }) {
    this.sns = new SNSClient({
      region: config.region,
      ...(process.env.AWS_ENDPOINT_URL && { endpoint: process.env.AWS_ENDPOINT_URL }),
    });
    this.topicArn = config.topicArn;
  }

  async notify(payload: NotificationPayload): Promise<void> {
    logger.info(`Sending notification for issue ${payload.issueId}`, {
      reason: payload.reason,
      severity: payload.severity,
    });

    const message = this.formatMessage(payload);
    const subject = `[code-monkey] ${payload.severity.toUpperCase()}: ${payload.title}`;

    await this.sns.send(
      new PublishCommand({
        TopicArn: this.topicArn,
        Subject: subject.slice(0, 100),
        Message: message,
        MessageAttributes: {
          severity: {
            DataType: "String",
            StringValue: payload.severity,
          },
          issueId: {
            DataType: "String",
            StringValue: payload.issueId,
          },
        },
      })
    );

    logger.info(`Notification sent for ${payload.issueId}`);
  }

  async notifyEscalation(
    issue: Issue,
    reason: string,
    agentResult?: AgentResult
  ): Promise<void> {
    await this.notify({
      issueId: issue.id,
      issueUrl: issue.url,
      title: issue.title,
      reason,
      agentReasoning: agentResult?.reasoning ?? "No agent output available",
      recommendedAction: "Manual review required",
      severity: "warning",
    });
  }

  private formatMessage(payload: NotificationPayload): string {
    return [
      `Issue: ${payload.title}`,
      `URL: ${payload.issueUrl}`,
      `Severity: ${payload.severity}`,
      "",
      `Reason for notification:`,
      payload.reason,
      "",
      `Agent reasoning:`,
      payload.agentReasoning,
      "",
      `Recommended action:`,
      payload.recommendedAction,
    ].join("\n");
  }
}
