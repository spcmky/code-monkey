import { z } from "zod";

// --- Issue States ---

export const IssueState = {
  DETECTED: "DETECTED",
  TRIAGED: "TRIAGED",
  ASSIGNED: "ASSIGNED",
  IN_PROGRESS: "IN_PROGRESS",
  IMPLEMENTED: "IMPLEMENTED",
  UNDER_REVIEW: "UNDER_REVIEW",
  VALIDATED: "VALIDATED",
  MERGED: "MERGED",
  ESCALATED: "ESCALATED",
  CLOSED: "CLOSED",
} as const;

export type IssueState = (typeof IssueState)[keyof typeof IssueState];

// --- Agent Types ---

export const AgentType = {
  WATCHER: "watcher",
  TRIAGE: "triage",
  CODER: "coder",
  REVIEWER: "reviewer",
  NOTIFIER: "notifier",
} as const;

export type AgentType = (typeof AgentType)[keyof typeof AgentType];

// --- Issue Classification ---

export const IssueClassification = {
  BUG: "bug",
  FEATURE: "feature",
  QUESTION: "question",
  DEPENDENCY: "dependency",
  OUT_OF_SCOPE: "out-of-scope",
} as const;

export type IssueClassification =
  (typeof IssueClassification)[keyof typeof IssueClassification];

// --- Priority ---

export const Priority = {
  CRITICAL: "critical",
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
} as const;

export type Priority = (typeof Priority)[keyof typeof Priority];

// --- Core Interfaces ---

export interface Issue {
  id: string;
  githubId: number;
  repo: string;
  number: number;
  title: string;
  body: string;
  author: string;
  labels: string[];
  state: IssueState;
  classification?: IssueClassification;
  confidence?: number;
  priority?: Priority;
  assignedAgent?: AgentType;
  createdAt: Date;
  updatedAt: Date;
  url: string;
}

export interface AgentAction {
  id: string;
  issueId: string;
  agentType: AgentType;
  action: string;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  outputSummary?: string;
  status: "pending" | "running" | "completed" | "failed";
  modelId?: string;
  inputTokens?: number;
  outputTokens?: number;
  costEstimate?: number;
  durationMs?: number;
  startedAt: Date;
  completedAt?: Date;
  error?: string;
}

export interface AgentResult {
  success: boolean;
  agentType: AgentType;
  issueId: string;
  output: Record<string, unknown>;
  reasoning: string;
  toolCalls: ToolCall[];
  tokensUsed: number;
  durationMs: number;
}

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  durationMs: number;
}

export interface StateTransition {
  from: IssueState;
  to: IssueState;
  trigger: string;
  agentType?: AgentType;
  timestamp: Date;
}

export interface ValidationResult {
  valid: boolean;
  score: number;
  errors: ValidationError[];
  warnings: string[];
}

export interface ValidationError {
  code: string;
  message: string;
  severity: "error" | "warning";
  details?: Record<string, unknown>;
}

// --- Policy Config ---

export interface PolicyConfig {
  scope: ScopeConfig;
  paths: PathsConfig;
  thresholds: ThresholdsConfig;
  escalation: EscalationConfig;
  auto_close: AutoCloseConfig;
  rate_limits: RateLimitsConfig;
}

export interface ScopeConfig {
  allowed_labels: string[];
  escalate_labels: string[];
}

export interface PathsConfig {
  protected: string[];
  allowed: string[];
}

export interface ThresholdsConfig {
  max_diff_lines: number;
  max_files_changed: number;
  max_retries: number;
  confidence_threshold: number;
  grounding_threshold: number;
  relevance_threshold: number;
  max_tokens_per_issue: number;
}

export interface EscalationConfig {
  conditions: string[];
}

export interface AutoCloseConfig {
  stale_days: number;
  labels: string[];
}

export interface RateLimitsConfig {
  max_issues_per_hour: number;
  max_prs_per_hour: number;
  max_comments_per_hour: number;
  cooldown_after_failure_minutes: number;
}

// --- SQS Message Types ---

export interface TaskMessage {
  taskId: string;
  issueId: string;
  agentType: AgentType;
  context: AgentContext;
  createdAt: string;
}

export interface AgentContext {
  issue: Issue;
  relevantFiles: FileContent[];
  similarIssues: Issue[];
  repoProfile: RepoProfile;
  policy: PolicyConfig;
}

export interface FileContent {
  path: string;
  content: string;
  language: string;
}

export interface RepoProfile {
  name: string;
  language: string;
  framework?: string;
  testCommand?: string;
  buildCommand?: string;
  lintCommand?: string;
}

// --- Knowledge Types ---

export interface Resolution {
  issueId: string;
  issue: Issue;
  agentActions: AgentAction[];
  prUrl?: string;
  outcome: "merged" | "closed" | "escalated";
  resolvedAt: Date;
}

export interface EmbeddingRecord {
  id: string;
  sourceType: "file" | "issue" | "resolution";
  sourceId: string;
  content: string;
  embedding: number[];
  metadata: Record<string, unknown>;
}

// --- Audit ---

export interface AuditLogEntry {
  id: string;
  timestamp: Date;
  action: string;
  agentType?: AgentType;
  issueId?: string;
  details: Record<string, unknown>;
}

// --- Zod Schemas for runtime validation ---

export const TaskMessageSchema = z.object({
  taskId: z.string(),
  issueId: z.string(),
  agentType: z.enum(["watcher", "triage", "coder", "reviewer", "notifier"]),
  context: z.object({
    issue: z.object({
      id: z.string(),
      githubId: z.number(),
      repo: z.string(),
      number: z.number(),
      title: z.string(),
      body: z.string(),
      labels: z.array(z.string()),
      state: z.string(),
      createdAt: z.coerce.date(),
      updatedAt: z.coerce.date(),
      url: z.string(),
    }),
    relevantFiles: z.array(
      z.object({
        path: z.string(),
        content: z.string(),
        language: z.string(),
      })
    ),
    similarIssues: z.array(
      z.object({
        id: z.string(),
        githubId: z.number(),
        repo: z.string(),
        number: z.number(),
        title: z.string(),
        body: z.string(),
        labels: z.array(z.string()),
        state: z.string(),
        createdAt: z.coerce.date(),
        updatedAt: z.coerce.date(),
        url: z.string(),
      })
    ),
    repoProfile: z.object({
      name: z.string(),
      language: z.string(),
      framework: z.string().optional(),
      testCommand: z.string().optional(),
      buildCommand: z.string().optional(),
      lintCommand: z.string().optional(),
    }),
    policy: z.object({
      scope: z.object({
        allowed_labels: z.array(z.string()),
        escalate_labels: z.array(z.string()),
      }),
      paths: z.object({
        protected: z.array(z.string()),
        allowed: z.array(z.string()),
      }),
      thresholds: z.object({
        max_diff_lines: z.number(),
        max_files_changed: z.number(),
        max_retries: z.number(),
        confidence_threshold: z.number(),
        grounding_threshold: z.number(),
        relevance_threshold: z.number(),
        max_tokens_per_issue: z.number(),
      }),
      escalation: z.object({
        conditions: z.array(z.string()),
      }),
      auto_close: z.object({
        stale_days: z.number(),
        labels: z.array(z.string()),
      }),
      rate_limits: z.object({
        max_issues_per_hour: z.number(),
        max_prs_per_hour: z.number(),
        max_comments_per_hour: z.number(),
        cooldown_after_failure_minutes: z.number(),
      }),
    }),
  }),
  createdAt: z.string(),
});

// Results arrive from workers over SQS, so they are validated before the
// controller acts on them.
export const AgentResultSchema = z.object({
  success: z.boolean(),
  agentType: z.enum(["triage", "coder", "reviewer"]),
  issueId: z.string().min(1),
  output: z.record(z.unknown()),
  reasoning: z.string(),
  toolCalls: z.array(
    z.object({
      name: z.string(),
      input: z.record(z.unknown()),
      output: z.record(z.unknown()),
      durationMs: z.number(),
    })
  ),
  tokensUsed: z.number(),
  durationMs: z.number(),
});
