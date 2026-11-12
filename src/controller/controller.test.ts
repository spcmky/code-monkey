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
  StateTransition,
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
    createdAt: new Date(),
    updatedAt: new Date(),
    url: "https://github.com/owner/repo/issues/7",
    ...overrides,
  };
}

/** In-memory stand-in for the parts of Store the controller uses. */
class FakeStore {
  issues = new Map<string, Issue>();
  transitions: Array<{ issueId: string; from: string; to: string }> = [];
  triage = new Map<string, { classification: string; priority: string }>();

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

  async transitionIssue(id: string, t: StateTransition): Promise<boolean> {
    const issue = this.issues.get(id);
    if (!issue || issue.state !== t.from) return false;
    issue.state = t.to;
    this.transitions.push({ issueId: id, from: t.from, to: t.to });
    return true;
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

function coderResult(files: Record<string, string>, success = true): AgentResult {
  return {
    success,
    agentType: "coder",
    issueId: "issue-1",
    output: {},
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

function reviewerResult(decision: string): AgentResult {
  return {
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
  let resultQueue: Array<{ Body: string; ReceiptHandle: string }>;
  let sent: Array<{ agentType: string; issueId: string }>;
  let deleted: string[];
  let triageRun: ReturnType<typeof vi.fn>;
  let notifyEscalation: ReturnType<typeof vi.fn>;
  let createComment: ReturnType<typeof vi.fn>;
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
      github: { createComment },
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

    it("escalates when the coder task cannot be dispatched", async () => {
      sendShouldFail = true;
      store.add(makeIssue());
      await controller.poll();

      expect(store.issues.get("issue-1")?.state).toBe("ESCALATED");
    });
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

    it("escalates when the coder touches a protected path", async () => {
      store.add(makeIssue({ state: "IN_PROGRESS" }));
      enqueue(coderResult({ ".github/workflows/ci.yml": "on: push\n" }));
      await controller.poll();

      expect(store.issues.get("issue-1")?.state).toBe("ESCALATED");
      expect(sent).toEqual([]);
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
    it("validates an approved review", async () => {
      store.add(makeIssue({ state: "UNDER_REVIEW" }));
      enqueue(reviewerResult("approve"));
      await controller.poll();

      expect(store.issues.get("issue-1")?.state).toBe("VALIDATED");
    });

    it("sends requested changes back to the coder", async () => {
      store.add(makeIssue({ state: "UNDER_REVIEW" }));
      enqueue(reviewerResult("request_changes"));
      await controller.poll();

      expect(store.issues.get("issue-1")?.state).toBe("IN_PROGRESS");
      expect(sent).toEqual([{ agentType: "coder", issueId: "issue-1" }]);
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
