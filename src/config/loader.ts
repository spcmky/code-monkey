import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import { type PolicyConfig } from "../types/index.js";
import logger from "../logger.js";

const PolicySchema = z.object({
  scope: z.object({
    allowed_labels: z.array(z.string()).default([]),
    escalate_labels: z.array(z.string()).default([]),
  }),
  paths: z.object({
    protected: z.array(z.string()).default([]),
    allowed: z.array(z.string()).default(["**/*"]),
  }),
  thresholds: z.object({
    max_diff_lines: z.number().default(500),
    max_files_changed: z.number().default(20),
    max_retries: z.number().default(3),
    confidence_threshold: z.number().default(0.7),
    grounding_threshold: z.number().default(0.7),
    relevance_threshold: z.number().default(0.7),
    max_tokens_per_issue: z.number().default(100000),
  }),
  escalation: z.object({
    conditions: z.array(z.string()).default([]),
  }),
  auto_close: z.object({
    stale_days: z.number().default(30),
    labels: z.array(z.string()).default(["wontfix", "duplicate", "invalid"]),
  }),
  rate_limits: z.object({
    max_issues_per_hour: z.number().default(10),
    max_prs_per_hour: z.number().default(5),
    max_comments_per_hour: z.number().default(20),
    cooldown_after_failure_minutes: z.number().default(15),
  }),
  merge: z
    .object({
      auto_merge: z.boolean().default(false),
      method: z.enum(["merge", "squash", "rebase"]).default("squash"),
    })
    .default({}),
});

const AppConfigSchema = z.object({
  pollIntervalCron: z.string().default("*/5 * * * *"),
  watchedRepos: z.array(z.string().regex(/^[\w-]+\/[\w-]+$/, "Repo must be owner/repo format")).min(1, "At least one watched repo is required"),
  workDir: z.string().default("/tmp/code-monkey-workspaces"),
  db: z.object({
    host: z.string().min(1, "DB_HOST is required"),
    port: z.number().int().min(1).max(65535).default(5432),
    database: z.string().min(1, "DB_NAME is required"),
    user: z.string().min(1, "DB_USER is required"),
    password: z.string().min(1, "DB_PASSWORD is required"),
    ssl: z.boolean().default(false),
  }),
  aws: z.object({
    region: z.string().default("us-east-2"),
    sqsTaskQueueUrl: z.string().url("SQS_TASK_QUEUE_URL must be a valid URL"),
    sqsResultQueueUrl: z.string().url("SQS_RESULT_QUEUE_URL must be a valid URL"),
    snsEscalationTopicArn: z.string().startsWith("arn:", "SNS_ESCALATION_TOPIC_ARN must be a valid ARN"),
    githubPatSecretArn: z.string().regex(/^arn:aws:secretsmanager:[a-z0-9-]+:\d{12}:secret:.+$/, "GITHUB_PAT_SECRET_ARN must be a valid Secrets Manager ARN"),
    bedrockGuardrailId: z.string().optional(),
    bedrockGuardrailVersion: z.string().default("DRAFT"),
  }),
  // Without a guardrail the fact check cannot run. Results are then rejected
  // unless this is explicitly switched off (local development).
  requireGuardrail: z.boolean().default(true),
  logLevel: z.string().default("info"),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

export function loadPolicyConfig(filePath: string): PolicyConfig {
  logger.info(`Loading policy config from ${filePath}`);
  const raw = readFileSync(filePath, "utf-8");
  const parsed = parse(raw) as unknown;
  return PolicySchema.parse(parsed) as PolicyConfig;
}

export function loadAppConfig(): AppConfig {
  const config = AppConfigSchema.parse({
    pollIntervalCron: process.env.POLL_INTERVAL_CRON,
    watchedRepos: (process.env.WATCHED_REPOS ?? "").split(",").filter(Boolean),
    workDir: process.env.WORK_DIR,
    db: {
      host: process.env.DB_HOST,
      port: process.env.DB_PORT ? (() => {
        const parsed = parseInt(process.env.DB_PORT!, 10);
        if (isNaN(parsed)) throw new Error("DB_PORT must be a valid integer");
        return parsed;
      })() : undefined,
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      ssl: process.env.DB_SSL === "true",
    },
    aws: {
      region: process.env.AWS_REGION,
      sqsTaskQueueUrl: process.env.SQS_TASK_QUEUE_URL,
      sqsResultQueueUrl: process.env.SQS_RESULT_QUEUE_URL,
      snsEscalationTopicArn: process.env.SNS_ESCALATION_TOPIC_ARN,
      githubPatSecretArn: process.env.GITHUB_PAT_SECRET_ARN,
      bedrockGuardrailId: process.env.BEDROCK_GUARDRAIL_ID || undefined,
      bedrockGuardrailVersion: process.env.BEDROCK_GUARDRAIL_VERSION,
    },
    requireGuardrail: process.env.REQUIRE_GUARDRAIL
      ? process.env.REQUIRE_GUARDRAIL !== "false"
      : undefined,
    logLevel: process.env.LOG_LEVEL,
  });

  logger.info("App config loaded successfully");
  return config;
}
