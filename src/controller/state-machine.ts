import { IssueState, type StateTransition, type AgentType } from "../types/index.js";
import logger from "../logger.js";

const MAX_REVIEW_CYCLES = 3;

// Track transition counts per issue to detect loops
const transitionCounts = new Map<string, Map<string, number>>();
// Track recent transitions for deduplication (key -> timestamp in seconds)
const recentTransitions = new Map<string, number>();

function trackTransition(issueId: string, from: string, to: string): void {
  if (!transitionCounts.has(issueId)) {
    transitionCounts.set(issueId, new Map());
  }

  // Deduplication: skip if same transition was tracked within last 5 seconds
  const nowSeconds = Math.floor(Date.now() / 1000);
  const dedupeKey = `${issueId}:${from}->${to}`;
  const lastSeen = recentTransitions.get(dedupeKey);
  if (lastSeen !== undefined && nowSeconds - lastSeen < 5) {
    logger.debug("Duplicate transition suppressed", { issueId, from, to });
    return;
  }
  recentTransitions.set(dedupeKey, nowSeconds);

  const counts = transitionCounts.get(issueId)!;
  const key = `${from}->${to}`;
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function detectLoop(issueId: string, from: string, to: string): boolean {
  const counts = transitionCounts.get(issueId);
  if (!counts) return false;

  // Check IN_PROGRESS -> UNDER_REVIEW -> IN_PROGRESS cycle
  const reviewToProgress = counts.get(`${IssueState.UNDER_REVIEW}->${IssueState.IN_PROGRESS}`) ?? 0;
  if (
    from === IssueState.UNDER_REVIEW &&
    to === IssueState.IN_PROGRESS &&
    reviewToProgress >= MAX_REVIEW_CYCLES
  ) {
    return true;
  }
  return false;
}

export function clearTransitionHistory(issueId: string): void {
  transitionCounts.delete(issueId);
}

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

export function createTransition(
  from: IssueState,
  to: IssueState,
  trigger: string,
  agentType?: AgentType,
  issueId?: string
): StateTransition {
  if (!isValidTransition(from, to)) {
    throw new Error(
      `Invalid state transition: ${from} -> ${to}. Valid: ${getValidNextStates(from).join(", ")}`
    );
  }

  // Detect and prevent infinite review loops
  if (issueId) {
    if (detectLoop(issueId, from, to)) {
      logger.warn(
        `Loop detected for issue ${issueId}: ${from} -> ${to} exceeded ${MAX_REVIEW_CYCLES} cycles, forcing escalation`
      );
      // Force escalation instead of the requested transition
      trackTransition(issueId, from, IssueState.ESCALATED);
      return {
        from,
        to: IssueState.ESCALATED,
        trigger: "loop_detection_escalation",
        agentType,
        timestamp: new Date(),
      };
    }
    trackTransition(issueId, from, to);
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
  // TODO: expand event-to-state mapping as needed
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
