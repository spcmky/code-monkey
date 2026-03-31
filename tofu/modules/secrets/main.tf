locals {
  name_prefix = "${var.project_name}-${var.environment}"
}

resource "aws_secretsmanager_secret" "github_pat" {
  name_prefix = "${local.name_prefix}-github-pat-"
  description = "GitHub Personal Access Token for ${var.project_name}"
  kms_key_id  = var.kms_key_id

  tags = merge(var.common_tags, {
    Name = "${local.name_prefix}-github-pat"
  })
}

resource "aws_secretsmanager_secret_version" "github_pat" {
  secret_id     = aws_secretsmanager_secret.github_pat.id
  secret_string = jsonencode({
    token = "REPLACE_ME_WITH_ACTUAL_GITHUB_PAT"
  })

  lifecycle {
    ignore_changes = [secret_string]
  }
}

data "aws_iam_policy_document" "github_pat_read" {
  statement {
    sid    = "AllowReadGitHubPAT"
    effect = "Allow"

    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
    ]

    resources = [aws_secretsmanager_secret.github_pat.arn]
  }
}

resource "aws_iam_policy" "github_pat_read" {
  name_prefix = "${local.name_prefix}-github-pat-read-"
  description = "Allow reading GitHub PAT secret"
  policy      = data.aws_iam_policy_document.github_pat_read.json

  tags = var.common_tags
}
