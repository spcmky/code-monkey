import { describe, it, expect, vi, beforeEach } from "vitest";
import { fileURLToPath } from "node:url";
import {
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from "@aws-sdk/client-sqs";
import { Controller, type ControllerDeps } from "./controller.js";
import { PolicyEngine } from "./policy.js";
import { MAX_REVIEW_CYCLES } from "./state-machine.js";
import type { Store } from "../db/store.js";
import type { AppConfig } from "../config/loader.js";
import type {
  AgentContext,
  AgentResult,
  Issue,
  IssueState,
  PullRequestRef,
  StateTransition,
  ValidationResult,
} from "../types/index.js";

const policy = new PolicyEngine(
  fileURLToPath(new URL("../../config/policy.yaml", import.meta.url))
);

const config = {
  aws: {
    region: "us-east-2",
    sqsTaskQueueUrl: "https://sqs.test/tasks",
    sqsResultQueueUrl: "https://sqs.test/results",
  },
} as AppConfig;

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    githubId: 1,
    repo: "owner/repo",
    number: 7,
    title: "Something is broken",
    body: "Details",
    author: "reporter",
    labels: ["bug"],
    state: "DETECTED",
    currentTaskId: "task-1",
    createdAt: new Date(),
    updatedAt: new Date(),
    url: "https://github.com/owner/repo/issues/7",
    ...overrides,
  };
}

/** In-memory stand-in for the parts of Store the controller uses. */
class FakeStore {
  issues = new Map<string, Issue>();
  transitions: Array<{
    issueId: string;
    from: string;
    to: string;
    reason?: string;
  }> = [];
  failTriageUpdateOnce = false;
  triage = new Map<string, { classification: string; priority: string }>();

  async setIssuePullRequest(id: string, pr: PullRequestRef): Promise<void> {
    const issue = this.issues.get(id);
    if (issue) issue.pullRequest = pr;
  }

  add(issue: Issue): Issue {
    this.issues.set(issue.id, issue);
    return issue;
  }

  async getIssue(id: string): Promise<Issue | null> {
    const issue = this.issues.get(id);
    return issue ? { ...issue } : null;
  }

  async getIssuesByState(state: IssueState): Promise<Issue[]> {
    return [...this.issues.values()]
      .filter((i) => i.state === state)
      .map((i) => ({ ...i }));
  }

  async transitionIssue(
    id: string,
    t: StateTransition,
    reason?: string
  ): Promise<boolean> {
    const issue = this.issues.get(id);
    if (!issue || issue.state !== t.from) return false;
    issue.state = t.to;
    issue.currentTaskId = undefined;
    this.transitions.push({ issueId: id, from: t.from, to: t.to, reason });
    return true;
  }

  async setCurrentTask(id: string, taskId: string): Promise<void> {
    const issue = this.issues.get(id);
    if (issue) issue.currentTaskId = taskId;
  }

  async countReviewCycles(id: string): Promise<number> {
    return this.transitions.filter(
      (t) =>
        t.issueId === id && t.from === "UNDER_REVIEW" && t.to === "IN_PROGRESS"
    ).length;
  }

  async updateIssueTriage(
    id: string,
    triage: { classification: string; priority: string }
  ): Promise<void> {
    if (this.failTriageUpdateOnce) {
      this.failTriageUpdateOnce = false;
      throw new Error("database unavailable");
    }
    this.triage.set(id, triage);
  }

  path(id: string): string[] {
    return this.transitions.filter((t) => t.issueId === id).map((t) => t.to);
  }
}

function triageResult(
  suggestedAction: string,
  success = true
): AgentResult {
  return {
    success,
    agentType: "triage",
    issueId: "issue-1",
    output: { suggestedAction, classification: "bug", priority: "high" },
    reasoning: "because",
    toolCalls: [],
    tokensUsed: 10,
    durationMs: 1,
  };
}

const PR: PullRequestRef = {
  number: 42,
  url: "https://github.com/owner/repo/pull/42",
  branch: "code-monkey/issue-7",
};

function coderResult(files: Record<string, string>, success = true): AgentResult {
  return {
    taskId: "task-1",
    success,
    agentType: "coder",
    issueId: "issue-1",
    output: success
      ? { prNumber: PR.number, prUrl: PR.url, branch: PR.branch }
      : {},
    reasoning: "implemented",
    toolCalls: Object.entries(files).map(([path, content]) => ({
      name: "writeFile",
      input: { path, content },
      output: {},
      durationMs: 0,
    })),
    tokensUsed: 10,
    durationMs: 1,
  };
}

function reviewerResult(decision: string, taskId = "task-1"): AgentResult {
  return {
    taskId,
    success: true,
    agentType: "reviewer",
    issueId: "issue-1",
    output: { decision },
    reasoning: "reviewed",
    toolCalls: [],
    tokensUsed: 10,
    durationMs: 1,
  };
}

describe("Controller", () => {
  let store: FakeStore;
  let resultQueue: Array<{
    Body: string;
    ReceiptHandle: string;
    Attributes?: Record<string, string>;
  }>;
  let sent: Array<{ agentType: string; issueId: string }>;
  let deleted: string[];
  let triageRun: ReturnType<typeof vi.fn>;
  let notifyEscalation: ReturnType<typeof vi.fn>;
  let createComment: ReturnType<typeof vi.fn>;
  let listPRFiles: ReturnType<typeof vi.fn>;
  let mergePR: ReturnType<typeof vi.fn>;
  let isMerged: ReturnType<typeof vi.fn>;
  let factCheck: ReturnType<typeof vi.fn>;
  let sendShouldFail: boolean;
  let controller: Controller;

  beforeEach(() => {
    store = new FakeStore();
    resultQueue = [];
    sent = [];
    deleted = [];
    sendShouldFail = false;
    triageRun = vi.fn(async () => triageResult("implement"));
    notifyEscalation = vi.fn(async () => {});
    createComment = vi.fn(async () => {});
    listPRFiles = vi.fn(async () => [
      { filename: "src/fix.ts", status: "modified", additions: 3, deletions: 1 },
    ]);
    mergePR = vi.fn(async () => {});
    isMerged = vi.fn(async () => false);
    factCheck = vi.fn(
      async (): Promise<ValidationResult> => ({
        valid: true,
        score: 1,
        errors: [],
        warnings: [],
      })
    );
    policy.getPolicy().merge.auto_merge = false;

    const send = vi.fn(async (command: unknown) => {
      if (command instanceof SendMessageCommand) {
        if (sendShouldFail) throw new Error("SQS unavailable");
        const body = JSON.parse(command.input.MessageBody ?? "{}") as {
          agentType: string;
          issueId: string;
        };
        sent.push({ agentType: body.agentType, issueId: body.issueId });
        return {};
      }
      if (command instanceof ReceiveMessageCommand) {
        return { Messages: resultQueue.splice(0) };
      }
      if (command instanceof DeleteMessageCommand) {
        deleted.push(command.input.ReceiptHandle ?? "");
        return {};
      }
      throw new Error("unexpected SQS command");
    });

    const deps: ControllerDeps = {
      watcher: { poll: vi.fn(async () => []) },
      triageAgent: { run: triageRun },
      notifier: { notifyEscalation },
      github: { createComment, listPRFiles, mergePR, isMerged },
      factChecker: { validate: factCheck },
      policy,
      contextBuilder: {
        build: vi.fn(
          async (issue: Issue) =>
            ({
              issue,
              relevantFiles: [],
              similarIssues: [],
              repoProfile: { name: issue.repo, language: "unknown" },
              policy: policy.getPolicy(),
            }) as AgentContext
        ),
      },
      sqs: { send } as unknown as ControllerDeps["sqs"],
    };

    controller = new Controller(config, store as unknown as Store, deps);
  });

  function enqueue(result: unknown, handle = "r1"): void {
    resultQueue.push({ Body: JSON.stringify(result), ReceiptHandle: handle });
  }

  describe("triage", () => {
    it("walks an in-scope issue to IN_PROGRESS and dispatches the coder", async () => {
      store.add(makeIssue());
      await controller.poll();

      expect(store.path("issue-1")).toEqual([
        "TRIAGED",
        "ASSIGNED",
        "IN_PROGRESS",
      ]);
      expect(sent).toEqual([{ agentType: "coder", issueId: "issue-1" }]);
      expect(store.triage.get("issue-1")).toEqual({
        classification: "bug",
        priority: "high",
      });
    });

    it("leaves out-of-scope issues in DETECTED without calling the model", async () => {
      store.add(makeIssue({ labels: [] }));
      await controller.poll();

      expect(store.issues.get("issue-1")?.state).toBe("DETECTED");
      expect(triageRun).not.toHaveBeenCalled();
    });

    it("picks an issue up once it gains an allowed label", async () => {
      const issue = store.add(makeIssue({ labels: [] }));
      await controller.poll();
      issue.labels = ["bug"];
      await controller.poll();

      expect(store.issues.get("issue-1")?.state).toBe("IN_PROGRESS");
    });

    it("escalates issues carrying an escalation label", async () => {
      store.add(makeIssue({ labels: ["bug", "security"] }));
      await controller.poll();

      expect(store.issues.get("issue-1")?.state).toBe("ESCALATED");
      expect(triageRun).not.toHaveBeenCalled();
      expect(notifyEscalation).toHaveBeenCalledTimes(1);
      expect(createComment).toHaveBeenCalledTimes(1);
    });

    it.each(["question", "close", "escalate"])(
      "escalates when triage suggests %s",
      async (action) => {
        triageRun.mockResolvedValue(triageResult(action));
        store.add(makeIssue());
        await controller.poll();

        expect(store.path("issue-1")).toEqual(["TRIAGED", "ESCALATED"]);
        expect(sent).toEqual([]);
      }
    );

    it("escalates when the triage agent fails", async () => {
      triageRun.mockResolvedValue(triageResult("implement", false));
      store.add(makeIssue());
      await controller.poll();

      expect(store.path("issue-1")).toEqual(["ESCALATED"]);
    });

    it("retries the coder dispatch on the next poll when it fails", async () => {
      sendShouldFail = true;
      store.add(makeIssue());
      await controller.poll();

      expect(store.issues.get("issue-1")?.state).toBe("IN_PROGRESS");
      expect(store.issues.get("issue-1")?.currentTaskId).toBeUndefined();
      expect(sent).toEqual([]);

      sendShouldFail = false;
      await controller.poll();

      expect(sent).toEqual([{ agentType: "coder", issueId: "issue-1" }]);
      expect(store.issues.get("issue-1")?.currentTaskId).toBeDefined();
    });
  });

  describe("interrupted hand-offs", () => {
    it("escalates an issue stranded in TRIAGED", async () => {
      store.failTriageUpdateOnce = true;
      store.add(makeIssue());
      await controller.poll();

      expect(store.path("issue-1")).toEqual(["TRIAGED", "ESCALATED"]);
      expect(sent).toEqual([]);
      expect(notifyEscalation).toHaveBeenCalledTimes(1);
    });

    it("hands an issue left in ASSIGNED to the coder", async () => {
      store.add(makeIssue({ state: "ASSIGNED", currentTaskId: undefined }));
      await controller.poll();

      expect(store.issues.get("issue-1")?.state).toBe("IN_PROGRESS");
      expect(sent).toEqual([{ agentType: "coder", issueId: "issue-1" }]);
    });

    it("dispatches the coder for IN_PROGRESS with no outstanding task", async () => {
      store.add(makeIssue({ state: "IN_PROGRESS", currentTaskId: undefined }));
      await controller.poll();

      expect(sent).toEqual([{ agentType: "coder", issueId: "issue-1" }]);
    });

    it("dispatches the reviewer for UNDER_REVIEW with no outstanding task", async () => {
      store.add(makeIssue({ state: "UNDER_REVIEW", currentTaskId: undefined }));
      await controller.poll();

      expect(sent).toEqual([{ agentType: "reviewer", issueId: "issue-1" }]);
    });

    it.each(["IN_PROGRESS", "UNDER_REVIEW"] as const)(
      "does not dispatch again while a task is outstanding in %s",
      async (state) => {
        store.add(makeIssue({ state }));
        await controller.poll();
        await controller.poll();

        expect(sent).toEqual([]);
      }
    );
  });

  describe("coder results", () => {
    it("moves to UNDER_REVIEW and dispatches the reviewer", async () => {
      store.add(makeIssue({ state: "IN_PROGRESS" }));
      enqueue(coderResult({ "src/fix.ts": "export {};\n" }));
      await controller.poll();

      expect(store.path("issue-1")).toEqual(["IMPLEMENTED", "UNDER_REVIEW"]);
      expect(sent).toEqual([{ agentType: "reviewer", issueId: "issue-1" }]);
      expect(deleted).toEqual(["r1"]);
    });

    it("records the pull request the coder opened", async () => {
      store.add(makeIssue({ state: "IN_PROGRESS" }));
      enqueue(coderResult({ "src/fix.ts": "export {};\n" }));
      await controller.poll();

      expect(store.issues.get("issue-1")?.pullRequest).toEqual(PR);
      expect(listPRFiles).toHaveBeenCalledWith("owner", "repo", 42);
    });

    it("escalates when the pull request touches a protected path", async () => {
      listPRFiles.mockResolvedValue([
        { filename: ".github/workflows/ci.yml", status: "added", additions: 5, deletions: 0 },
      ]);
      store.add(makeIssue({ state: "IN_PROGRESS" }));
      // What the agent says it wrote is irrelevant; the real diff decides
      enqueue(coderResult({ "src/fix.ts": "export {};\n" }));
      await controller.poll();

      expect(store.issues.get("issue-1")?.state).toBe("ESCALATED");
      expect(store.issues.get("issue-1")?.pullRequest).toEqual(PR);
      expect(sent).toEqual([]);
    });

    it("escalates when the pull request exceeds the diff limit", async () => {
      listPRFiles.mockResolvedValue([
        { filename: "src/big.ts", status: "added", additions: 5000, deletions: 0 },
      ]);
      store.add(makeIssue({ state: "IN_PROGRESS" }));
      enqueue(coderResult({}));
      await controller.poll();

      expect(store.issues.get("issue-1")?.state).toBe("ESCALATED");
    });

    it("escalates when the reported pull request does not exist", async () => {
      listPRFiles.mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));
      store.add(makeIssue({ state: "IN_PROGRESS" }));
      enqueue(coderResult({}));
      await controller.poll();

      expect(store.issues.get("issue-1")?.state).toBe("ESCALATED");
      expect(store.transitions.at(-1)?.reason).toContain("NO_PULL_REQUEST");
      expect(deleted).toEqual(["r1"]);
    });

    it("rejects a pull request on a branch the system did not assign", async () => {
      store.add(makeIssue({ state: "IN_PROGRESS" }));
      enqueue({
        ...coderResult({}),
        output: { prNumber: 1, prUrl: "", branch: "main" },
      });
      await controller.poll();

      expect(store.issues.get("issue-1")?.state).toBe("ESCALATED");
      expect(store.issues.get("issue-1")?.pullRequest).toBeUndefined();
      expect(listPRFiles).not.toHaveBeenCalled();
    });

    it("escalates when the fact check rejects the result", async () => {
      factCheck.mockResolvedValue({
        valid: false,
        score: 0,
        errors: [
          { code: "GUARDRAIL_NOT_CONFIGURED", message: "x", severity: "error" },
        ],
        warnings: [],
      });
      store.add(makeIssue({ state: "IN_PROGRESS" }));
      enqueue(coderResult({}));
      await controller.poll();

      expect(store.issues.get("issue-1")?.state).toBe("ESCALATED");
      expect(store.transitions.at(-1)?.reason).toContain(
        "GUARDRAIL_NOT_CONFIGURED"
      );
    });

    it("escalates when the coder reports failure", async () => {
      store.add(makeIssue({ state: "IN_PROGRESS" }));
      enqueue(coderResult({}, false));
      await controller.poll();

      expect(store.issues.get("issue-1")?.state).toBe("ESCALATED");
    });

    it("resumes review for an issue left in IMPLEMENTED", async () => {
      store.add(makeIssue({ state: "IMPLEMENTED" }));
      await controller.poll();

      expect(store.issues.get("issue-1")?.state).toBe("UNDER_REVIEW");
      expect(sent).toEqual([{ agentType: "reviewer", issueId: "issue-1" }]);
    });
  });

  describe("reviewer results", () => {
    it("validates an approved review and leaves the merge to a human", async () => {
      store.add(makeIssue({ state: "UNDER_REVIEW", pullRequest: PR }));
      enqueue(reviewerResult("approve"));
      await controller.poll();
      await controller.poll();

      expect(store.issues.get("issue-1")?.state).toBe("VALIDATED");
      expect(mergePR).not.toHaveBeenCalled();
      expect(createComment).toHaveBeenCalledTimes(1);
      expect(createComment.mock.calls[0]?.[2]).toBe(42);
    });

    it("merges an approved pull request when policy allows it", async () => {
      policy.getPolicy().merge.auto_merge = true;
      store.add(makeIssue({ state: "UNDER_REVIEW", pullRequest: PR }));
      enqueue(reviewerResult("approve"));
      await controller.poll();

      expect(mergePR).toHaveBeenCalledWith("owner", "repo", 42, "squash");
      expect(store.issues.get("issue-1")?.state).toBe("MERGED");
    });

    it("does not merge twice when the pull request is already merged", async () => {
      policy.getPolicy().merge.auto_merge = true;
      isMerged.mockResolvedValue(true);
      store.add(makeIssue({ state: "VALIDATED", pullRequest: PR }));
      await controller.poll();

      expect(mergePR).not.toHaveBeenCalled();
      expect(store.issues.get("issue-1")?.state).toBe("MERGED");
    });

    it("escalates when the automatic merge fails", async () => {
      policy.getPolicy().merge.auto_merge = true;
      mergePR.mockRejectedValue(new Error("checks failing"));
      store.add(makeIssue({ state: "UNDER_REVIEW", pullRequest: PR }));
      enqueue(reviewerResult("approve"));
      await controller.poll();

      expect(store.issues.get("issue-1")?.state).toBe("ESCALATED");
    });

    it("posts the review on the pull request when changes are requested", async () => {
      store.add(makeIssue({ state: "UNDER_REVIEW", pullRequest: PR }));
      enqueue({
        ...reviewerResult("request_changes"),
        output: {
          decision: "request_changes",
          reasoning: "Missing null check",
          comments: [
            { path: "src/fix.ts", line: 3, body: "guard this", severity: "error" },
          ],
        },
      });
      await controller.poll();

      const body = createComment.mock.calls[0]?.[3] as string;
      expect(createComment.mock.calls[0]?.[2]).toBe(42);
      expect(body.startsWith("<!-- code-monkey:review -->")).toBe(true);
      expect(body).toContain("Missing null check");
      expect(body).toContain("src/fix.ts:3");
      expect(store.issues.get("issue-1")?.state).toBe("IN_PROGRESS");
    });

    it("sends requested changes back to the coder", async () => {
      store.add(makeIssue({ state: "UNDER_REVIEW" }));
      enqueue(reviewerResult("request_changes"));
      await controller.poll();

      expect(store.issues.get("issue-1")?.state).toBe("IN_PROGRESS");
      expect(sent).toEqual([{ agentType: "coder", issueId: "issue-1" }]);
    });

    it("records the trigger, not the loop-limit reason, for an ordinary change request", async () => {
      store.add(makeIssue({ state: "UNDER_REVIEW" }));
      enqueue(reviewerResult("request_changes"));
      await controller.poll();

      expect(store.transitions.at(-1)).toMatchObject({
        to: "IN_PROGRESS",
        reason: undefined,
      });
    });

    it("escalates once the review cycle limit is reached", async () => {
      const issue = store.add(makeIssue({ state: "UNDER_REVIEW" }));
      for (let cycle = 0; cycle < MAX_REVIEW_CYCLES; cycle++) {
        store.transitions.push({
          issueId: issue.id,
          from: "UNDER_REVIEW",
          to: "IN_PROGRESS",
        });
      }
      enqueue(reviewerResult("request_changes"));
      await controller.poll();

      expect(store.issues.get("issue-1")?.state).toBe("ESCALATED");
      expect(sent).toEqual([]);
      expect(notifyEscalation).toHaveBeenCalledTimes(1);
      expect(store.transitions.at(-1)?.reason).toBe("Review loop limit reached");
      // No review is posted for a coder that will never run
      expect(
        createComment.mock.calls.some((call) =>
          String(call[3]).includes("<!-- code-monkey:review -->")
        )
      ).toBe(false);
    });

    it("escalates when the review feedback cannot be posted", async () => {
      createComment.mockRejectedValue(new Error("GitHub unavailable"));
      store.add(makeIssue({ state: "UNDER_REVIEW", pullRequest: PR }));
      enqueue(reviewerResult("request_changes"));
      await controller.poll();

      expect(store.path("issue-1")).toEqual(["IN_PROGRESS", "ESCALATED"]);
      expect(sent).toEqual([]);
      expect(deleted).toEqual(["r1"]);
    });

    it("escalates on an unknown decision", async () => {
      store.add(makeIssue({ state: "UNDER_REVIEW" }));
      enqueue(reviewerResult("escalate"));
      await controller.poll();

      expect(store.issues.get("issue-1")?.state).toBe("ESCALATED");
    });
  });

  describe("result queue handling", () => {
    it("drops a result that does not match the issue state", async () => {
      store.add(makeIssue({ state: "VALIDATED" }));
      enqueue(reviewerResult("request_changes"));
      await controller.poll();

      expect(store.issues.get("issue-1")?.state).toBe("VALIDATED");
      expect(sent).toEqual([]);
      expect(deleted).toEqual(["r1"]);
    });

    it("drops a reviewer result from an earlier dispatch", async () => {
      store.add(makeIssue({ state: "UNDER_REVIEW", currentTaskId: "task-2" }));
      enqueue(reviewerResult("approve", "task-1"));
      await controller.poll();

      expect(store.issues.get("issue-1")?.state).toBe("UNDER_REVIEW");
      expect(deleted).toEqual(["r1"]);
    });

    it("accepts the result of the current dispatch after a re-review", async () => {
      store.add(makeIssue({ state: "UNDER_REVIEW" }));
      enqueue(reviewerResult("request_changes"));
      await controller.poll();
      const coderTask = store.issues.get("issue-1")?.currentTaskId;
      expect(coderTask).toBeDefined();
      expect(coderTask).not.toBe("task-1");

      // The first review's result is redelivered after the issue moved on
      enqueue({ ...coderResult({ "src/fix.ts": "export {};\n" }), taskId: coderTask });
      await controller.poll();
      expect(store.issues.get("issue-1")?.state).toBe("UNDER_REVIEW");

      enqueue(reviewerResult("approve", "task-1"));
      await controller.poll();
      expect(store.issues.get("issue-1")?.state).toBe("UNDER_REVIEW");

      enqueue(
        reviewerResult("approve", store.issues.get("issue-1")?.currentTaskId)
      );
      await controller.poll();
      expect(store.issues.get("issue-1")?.state).toBe("VALIDATED");
    });

    it("processes a duplicated result only once", async () => {
      store.add(makeIssue({ state: "UNDER_REVIEW" }));
      enqueue(reviewerResult("escalate"), "r1");
      enqueue(reviewerResult("escalate"), "r2");
      await controller.poll();

      expect(notifyEscalation).toHaveBeenCalledTimes(1);
      expect(createComment).toHaveBeenCalledTimes(1);
      expect(deleted).toEqual(["r1", "r2"]);
    });

    it("deletes malformed results without acting on them", async () => {
      store.add(makeIssue({ state: "UNDER_REVIEW" }));
      resultQueue.push({ Body: "not json", ReceiptHandle: "bad-json" });
      enqueue({ issueId: "issue-1", agentType: "reviewer" }, "bad-shape");
      await controller.poll();

      expect(store.issues.get("issue-1")?.state).toBe("UNDER_REVIEW");
      expect(deleted).toEqual(["bad-json", "bad-shape"]);
    });

    it("deletes results for unknown issues", async () => {
      enqueue(reviewerResult("approve"));
      await controller.poll();

      expect(deleted).toEqual(["r1"]);
    });

    it("leaves a result that fails to process on the queue for another attempt", async () => {
      listPRFiles.mockRejectedValue(new Error("GitHub unavailable"));
      store.add(makeIssue({ state: "IN_PROGRESS" }));
      resultQueue.push({
        Body: JSON.stringify(coderResult({})),
        ReceiptHandle: "r1",
        Attributes: { ApproximateReceiveCount: "1" },
      });
      await controller.poll();

      expect(store.issues.get("issue-1")?.state).toBe("IN_PROGRESS");
      expect(deleted).toEqual([]);
    });

    it("escalates and drops a result that still fails on its last attempt", async () => {
      listPRFiles.mockRejectedValue(new Error("GitHub unavailable"));
      store.add(makeIssue({ state: "IN_PROGRESS" }));
      resultQueue.push({
        Body: JSON.stringify(coderResult({})),
        ReceiptHandle: "r1",
        Attributes: { ApproximateReceiveCount: "3" },
      });
      await controller.poll();

      expect(store.issues.get("issue-1")?.state).toBe("ESCALATED");
      expect(store.transitions.at(-1)?.reason).toContain("repeated attempts");
      expect(notifyEscalation).toHaveBeenCalledTimes(1);
      expect(deleted).toEqual(["r1"]);
    });

    it("still escalates when the notification fails", async () => {
      notifyEscalation.mockRejectedValue(new Error("SNS down"));
      store.add(makeIssue({ state: "UNDER_REVIEW" }));
      enqueue(reviewerResult("escalate"));
      await controller.poll();

      expect(store.issues.get("issue-1")?.state).toBe("ESCALATED");
      expect(createComment).toHaveBeenCalledTimes(1);
      expect(deleted).toEqual(["r1"]);
    });
  });

  it("skips a poll tick while another is running", async () => {
    store.add(makeIssue());
    await Promise.all([controller.poll(), controller.poll()]);

    expect(triageRun).toHaveBeenCalledTimes(1);
  });
});
