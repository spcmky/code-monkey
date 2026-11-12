import { describe, it, expect } from "vitest";
import {
  isValidTransition,
  getValidNextStates,
  createTransition,
  MAX_REVIEW_CYCLES,
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

  it("allows a review cycle below the limit", () => {
    const t = createTransition(
      "UNDER_REVIEW",
      "IN_PROGRESS",
      "review_changes_requested",
      "reviewer",
      MAX_REVIEW_CYCLES - 1
    );
    expect(t.to).toBe("IN_PROGRESS");
  });

  it("forces escalation once the review cycle limit is reached", () => {
    const t = createTransition(
      "UNDER_REVIEW",
      "IN_PROGRESS",
      "review_changes_requested",
      "reviewer",
      MAX_REVIEW_CYCLES
    );
    expect(t.to).toBe("ESCALATED");
    expect(t.trigger).toBe("loop_detection_escalation");
  });

  it("does not apply the cycle limit to other transitions", () => {
    const t = createTransition(
      "UNDER_REVIEW",
      "VALIDATED",
      "review_approved",
      "reviewer",
      MAX_REVIEW_CYCLES + 5
    );
    expect(t.to).toBe("VALIDATED");
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
