import { BedrockClient } from "../tools/bedrock.js";
import type { AgentResult, ValidationResult, ValidationError } from "../types/index.js";
import logger from "../logger.js";

export class FactChecker {
  private bedrock: Pick<BedrockClient, "applyGuardrail">;
  private confidenceThreshold: number;
  private requireGuardrail: boolean;

  constructor(
    bedrock: Pick<BedrockClient, "applyGuardrail">,
    confidenceThreshold: number = 0.7,
    requireGuardrail: boolean = true
  ) {
    this.bedrock = bedrock;
    this.confidenceThreshold = confidenceThreshold;
    this.requireGuardrail = requireGuardrail;
  }

  /**
   * Uses Bedrock Guardrails contextual grounding to score response accuracy.
   * Rejects responses below threshold.
   */
  async validate(
    result: AgentResult,
    _groundTruth: string = ""
  ): Promise<ValidationResult> {
    const errors: ValidationError[] = [];
    const warnings: string[] = [];

    // TODO: implement full contextual grounding check with Bedrock Guardrails
    logger.info("Running fact check", {
      agentType: result.agentType,
      issueId: result.issueId,
    });

    // Apply guardrail to the agent's reasoning
    const guardrailResult = await this.bedrock.applyGuardrail(result.reasoning);

    // Fail closed: an unchecked result is not a passed result
    if (guardrailResult.action === "NOT_CONFIGURED") {
      if (this.requireGuardrail) {
        errors.push({
          code: "GUARDRAIL_NOT_CONFIGURED",
          message:
            "No Bedrock Guardrail is configured, so the fact check could not run",
          severity: "error",
        });
      } else {
        warnings.push("Fact check skipped: no Bedrock Guardrail configured");
      }
    }

    if (guardrailResult.action === "BLOCKED") {
      errors.push({
        code: "GUARDRAIL_BLOCKED",
        message: "Agent response was blocked by Bedrock Guardrail",
        severity: "error",
      });
    }

    // Score based on guardrail confidence
    const score = guardrailResult.score;

    if (score < this.confidenceThreshold) {
      errors.push({
        code: "LOW_CONFIDENCE",
        message: `Response confidence (${score.toFixed(2)}) below threshold (${this.confidenceThreshold})`,
        severity: "error",
        details: { score, threshold: this.confidenceThreshold },
      });
    }

    // TODO: cross-reference claims against ground truth document
    // This would involve extracting claims from reasoning, then verifying
    // each against the provided ground truth context

    if (score >= this.confidenceThreshold && score < 0.9) {
      warnings.push(
        `Response confidence (${score.toFixed(2)}) is above threshold but not high`
      );
    }

    logger.info("Fact check complete", {
      score,
      action: guardrailResult.action,
      errors: errors.length,
    });

    return {
      valid: errors.filter((e) => e.severity === "error").length === 0,
      score,
      errors,
      warnings,
    };
  }
}
