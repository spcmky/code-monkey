locals {
  name_prefix = "${var.project_name}-${var.environment}"

  allowed_models = [
    "arn:aws:bedrock:${var.aws_region}::foundation-model/anthropic.claude-opus-4-6-v1*",
    "arn:aws:bedrock:${var.aws_region}::foundation-model/anthropic.claude-sonnet-4-6-v1*",
    "arn:aws:bedrock:${var.aws_region}::foundation-model/anthropic.claude-haiku-4-5-v1*",
    "arn:aws:bedrock:${var.aws_region}::foundation-model/amazon.titan-embed-text-v2*",
  ]
}

# --- InvokeModel Policy ---
data "aws_iam_policy_document" "bedrock_invoke" {
  statement {
    sid    = "AllowBedrockInvoke"
    effect = "Allow"

    actions = [
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
    ]

    resources = local.allowed_models

    condition {
      test     = "StringEquals"
      variable = "aws:SourceVpc"
      values   = [var.vpc_id]
    }
  }
}

resource "aws_iam_policy" "bedrock_invoke" {
  name_prefix = "${local.name_prefix}-bedrock-invoke-"
  description = "Allow invoking Bedrock models for ${var.project_name}"
  policy      = data.aws_iam_policy_document.bedrock_invoke.json

  tags = var.common_tags
}

# --- Guardrail Policy ---
data "aws_iam_policy_document" "bedrock_guardrails" {
  statement {
    sid    = "AllowBedrockGuardrails"
    effect = "Allow"

    actions = [
      "bedrock:ApplyGuardrail",
      "bedrock:GetGuardrail",
    ]

    resources = [
      "arn:aws:bedrock:${var.aws_region}:${var.account_id}:guardrail/*",
    ]
  }
}

resource "aws_iam_policy" "bedrock_guardrails" {
  name_prefix = "${local.name_prefix}-bedrock-guardrails-"
  description = "Allow managing and applying Bedrock guardrails"
  policy      = data.aws_iam_policy_document.bedrock_guardrails.json

  tags = var.common_tags
}

# --- Attach policies to ECS task role ---
resource "aws_iam_role_policy_attachment" "bedrock_invoke" {
  role       = var.ecs_task_role_name
  policy_arn = aws_iam_policy.bedrock_invoke.arn
}

resource "aws_iam_role_policy_attachment" "bedrock_guardrails" {
  role       = var.ecs_task_role_name
  policy_arn = aws_iam_policy.bedrock_guardrails.arn
}

# --- Bedrock Guardrail ---
resource "aws_bedrock_guardrail" "main" {
  name                      = "${local.name_prefix}-guardrail"
  description               = "Content safety guardrail for ${var.project_name} AI agents"
  blocked_input_messaging   = "Your request was blocked by content safety filters."
  blocked_outputs_messaging = "The model response was blocked by content safety filters."

  content_policy_config {
    filters_config {
      type            = "HATE"
      input_strength  = "HIGH"
      output_strength = "HIGH"
    }
    filters_config {
      type            = "VIOLENCE"
      input_strength  = "HIGH"
      output_strength = "HIGH"
    }
    filters_config {
      type            = "SEXUAL"
      input_strength  = "HIGH"
      output_strength = "HIGH"
    }
    filters_config {
      type            = "MISCONDUCT"
      input_strength  = "HIGH"
      output_strength = "HIGH"
    }
    filters_config {
      type            = "INSULTS"
      input_strength  = "MEDIUM"
      output_strength = "MEDIUM"
    }
    filters_config {
      type            = "PROMPT_ATTACK"
      input_strength  = "HIGH"
      output_strength = "NONE"
    }
  }

  sensitive_information_policy_config {
    pii_entities_config {
      type   = "EMAIL"
      action = "ANONYMIZE"
    }
    pii_entities_config {
      type   = "PHONE"
      action = "ANONYMIZE"
    }
    pii_entities_config {
      type   = "US_SOCIAL_SECURITY_NUMBER"
      action = "BLOCK"
    }
    pii_entities_config {
      type   = "CREDIT_DEBIT_CARD_NUMBER"
      action = "BLOCK"
    }
    pii_entities_config {
      type   = "AWS_ACCESS_KEY"
      action = "BLOCK"
    }
    pii_entities_config {
      type   = "AWS_SECRET_KEY"
      action = "BLOCK"
    }
  }

  contextual_grounding_policy_config {
    filters_config {
      type      = "GROUNDING"
      threshold = 0.7
    }
    filters_config {
      type      = "RELEVANCE"
      threshold = 0.7
    }
  }

  tags = var.common_tags
}
