import { loadPolicyConfig } from "../config/loader.js";
import type {
  PolicyConfig,
  AgentType,
  Issue,
  EscalationConfig,
} from "../types/index.js";
import logger from "../logger.js";
import { minimatch } from "minimatch";

export class PolicyEngine {
  private config: PolicyConfig;

  constructor(configPath: string) {
    this.config = loadPolicyConfig(configPath);
    logger.info("PolicyEngine initialized", {
      allowedLabels: this.config.scope.allowed_labels.length,
      escalateLabels: this.config.scope.escalate_labels.length,
    });
  }

  hasEscalationLabel(issue: Issue): boolean {
    return issue.labels.some((l) =>
      this.config.scope.escalate_labels.includes(l)
    );
  }

  canHandle(issue: Issue): boolean {
    // Check auto-close labels (equivalent to old excludedLabels)
    const hasAutoClose = issue.labels.some((l) =>
      this.config.auto_close.labels.includes(l)
    );
    if (hasAutoClose) {
      logger.debug(`Issue ${issue.id} has auto-close label`);
      return false;
    }

    if (this.hasEscalationLabel(issue)) {
      logger.debug(`Issue ${issue.id} has escalation label`);
      return false;
    }

    // If allowed_labels is set, check that issue has at least one
    if (this.config.scope.allowed_labels.length > 0) {
      const hasAllowed = issue.labels.some((l) =>
        this.config.scope.allowed_labels.includes(l)
      );
      if (!hasAllowed) {
        logger.debug(`Issue ${issue.id} missing required label`);
        return false;
      }
    }

    return true;
  }

  getAllowedPaths(): string[] {
    return this.config.paths.allowed;
  }

  getProtectedPaths(): string[] {
    return this.config.paths.protected;
  }

  isPathAllowed(path: string, _agentType?: AgentType): boolean {
    const protectedPaths = this.getProtectedPaths();
    for (const pattern of protectedPaths) {
      if (minimatch(path, pattern)) return false;
    }

    const allowed = this.getAllowedPaths();
    for (const pattern of allowed) {
      if (minimatch(path, pattern)) return true;
    }

    return false;
  }

  getMaxDiffSize(): number {
    return this.config.thresholds.max_diff_lines;
  }

  getEscalationRules(): EscalationConfig {
    return this.config.escalation;
  }

  getConfidenceThreshold(): number {
    return this.config.thresholds.confidence_threshold;
  }

  getMaxRetries(): number {
    return this.config.thresholds.max_retries;
  }

  getPolicy(): PolicyConfig {
    return this.config;
  }
}
