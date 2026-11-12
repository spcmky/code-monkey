import { IssueState, type StateTransition, type AgentType } from "../types/index.js";
import logger from "../logger.js";

export const MAX_REVIEW_CYCLES = 3;

const VALID_TRANSITIONS: Record<string, string[]> = {
  [IssueState.DETECTED]: [IssueState.TRIAGED, IssueState.ESCALATED],
  [IssueState.TRIAGED]: [
    IssueState.ASSIGNED,
    IssueState.ESCALATED,
    IssueState.CLOSED,
  ],
  [IssueState.ASSIGNED]: [
    IssueState.IN_PROGRESS,
    IssueState.ESCALATED,
  ],
  [IssueState.IN_PROGRESS]: [
    IssueState.IMPLEMENTED,
    IssueState.ESCALATED,
  ],
  [IssueState.IMPLEMENTED]: [
    IssueState.UNDER_REVIEW,
    IssueState.ESCALATED,
  ],
  [IssueState.UNDER_REVIEW]: [
    IssueState.VALIDATED,
    IssueState.IN_PROGRESS, // request_changes loops back
    IssueState.ESCALATED,
  ],
  [IssueState.VALIDATED]: [
    IssueState.MERGED,
    IssueState.ESCALATED,
  ],
  [IssueState.MERGED]: [IssueState.CLOSED],
  [IssueState.ESCALATED]: [
    IssueState.ASSIGNED, // human can reassign
    IssueState.CLOSED,
  ],
  [IssueState.CLOSED]: [],
};

export function isValidTransition(from: IssueState, to: IssueState): boolean {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to);
}

export function getValidNextStates(state: IssueState): IssueState[] {
  return (VALID_TRANSITIONS[state] ?? []) as IssueState[];
}

/**
 * Validates a requested transition and returns the one that should be applied.
 *
 * `reviewCycles` is the number of UNDER_REVIEW -> IN_PROGRESS transitions the
 * issue has already been through. Once it reaches MAX_REVIEW_CYCLES a further
 * request for changes is turned into an escalation, so callers must persist
 * the returned `to` state rather than the one they asked for.
 */
export function createTransition(
  from: IssueState,
  to: IssueState,
  trigger: string,
  agentType?: AgentType,
  reviewCycles = 0
): StateTransition {
  if (!isValidTransition(from, to)) {
    throw new Error(
      `Invalid state transition: ${from} -> ${to}. Valid: ${getValidNextStates(from).join(", ")}`
    );
  }

  if (
    from === IssueState.UNDER_REVIEW &&
    to === IssueState.IN_PROGRESS &&
    reviewCycles >= MAX_REVIEW_CYCLES
  ) {
    logger.warn(
      `Review loop limit reached: ${reviewCycles} cycles (max ${MAX_REVIEW_CYCLES}), forcing escalation`
    );
    return {
      from,
      to: IssueState.ESCALATED,
      trigger: "loop_detection_escalation",
      agentType,
      timestamp: new Date(),
    };
  }

  logger.info(`State transition: ${from} -> ${to}`, { trigger, agentType });

  return {
    from,
    to,
    trigger,
    agentType,
    timestamp: new Date(),
  };
}

export function getNextState(
  current: IssueState,
  event: string
): IssueState | null {
  const eventMap: Record<string, Record<string, IssueState>> = {
    triage_complete: {
      [IssueState.DETECTED]: IssueState.TRIAGED,
    },
    assigned: {
      [IssueState.TRIAGED]: IssueState.ASSIGNED,
    },
    work_started: {
      [IssueState.ASSIGNED]: IssueState.IN_PROGRESS,
    },
    implementation_complete: {
      [IssueState.IN_PROGRESS]: IssueState.IMPLEMENTED,
    },
    review_started: {
      [IssueState.IMPLEMENTED]: IssueState.UNDER_REVIEW,
    },
    review_approved: {
      [IssueState.UNDER_REVIEW]: IssueState.VALIDATED,
    },
    review_changes_requested: {
      [IssueState.UNDER_REVIEW]: IssueState.IN_PROGRESS,
    },
    merged: {
      [IssueState.VALIDATED]: IssueState.MERGED,
    },
    closed: {
      [IssueState.MERGED]: IssueState.CLOSED,
      [IssueState.TRIAGED]: IssueState.CLOSED,
      [IssueState.ESCALATED]: IssueState.CLOSED,
    },
    escalated: Object.fromEntries(
      Object.keys(VALID_TRANSITIONS)
        .filter((s) => VALID_TRANSITIONS[s].includes(IssueState.ESCALATED))
        .map((s) => [s, IssueState.ESCALATED])
    ),
  };

  const stateMap = eventMap[event];
  if (!stateMap) return null;
  return (stateMap[current] as IssueState) ?? null;
}
