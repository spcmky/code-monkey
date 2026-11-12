import { describe, it, expect, vi } from "vitest";
import {
  isValidTransition,
  getValidNextStates,
  createTransition,
  clearTransitionHistory,
  getNextState,
} from "./state-machine.js";

describe("isValidTransition", () => {
  it("allows the happy path", () => {
    expect(isValidTransition("DETECTED", "TRIAGED")).toBe(true);
    expect(isValidTransition("UNDER_REVIEW", "VALIDATED")).toBe(true);
    expect(isValidTransition("VALIDATED", "MERGED")).toBe(true);
  });

  it("rejects skipping states", () => {
    expect(isValidTransition("DETECTED", "MERGED")).toBe(false);
    expect(isValidTransition("TRIAGED", "IN_PROGRESS")).toBe(false);
  });

  it("treats CLOSED as terminal", () => {
    expect(getValidNextStates("CLOSED")).toEqual([]);
  });
});

describe("createTransition", () => {
  it("returns the requested transition", () => {
    const t = createTransition("DETECTED", "TRIAGED", "triage_complete", "triage");
    expect(t).toMatchObject({
      from: "DETECTED",
      to: "TRIAGED",
      trigger: "triage_complete",
      agentType: "triage",
    });
  });

  it("throws on an invalid transition", () => {
    expect(() => createTransition("DETECTED", "MERGED", "bad")).toThrow(
      /Invalid state transition/
    );
  });

  it("forces escalation after the review cycle limit", () => {
    const issueId = "loop-issue";
    clearTransitionHistory(issueId);
    vi.useFakeTimers();
    try {
      const requestChanges = () => {
        // Step past the 5s duplicate-suppression window
        vi.advanceTimersByTime(10_000);
        return createTransition(
          "UNDER_REVIEW",
          "IN_PROGRESS",
          "review_changes_requested",
          "reviewer",
          issueId
        );
      };

      for (let cycle = 0; cycle < 3; cycle++) {
        expect(requestChanges().to).toBe("IN_PROGRESS");
      }

      const forced = requestChanges();
      expect(forced.to).toBe("ESCALATED");
      expect(forced.trigger).toBe("loop_detection_escalation");
    } finally {
      vi.useRealTimers();
      clearTransitionHistory(issueId);
    }
  });
});

describe("getNextState", () => {
  it("maps known events", () => {
    expect(getNextState("DETECTED", "triage_complete")).toBe("TRIAGED");
    expect(getNextState("UNDER_REVIEW", "review_changes_requested")).toBe(
      "IN_PROGRESS"
    );
    expect(getNextState("IN_PROGRESS", "escalated")).toBe("ESCALATED");
  });

  it("returns null for unknown events or wrong states", () => {
    expect(getNextState("DETECTED", "nope")).toBeNull();
    expect(getNextState("CLOSED", "escalated")).toBeNull();
    expect(getNextState("DETECTED", "merged")).toBeNull();
  });
});
