locals {
  lifecycle_policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep last 10 images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 10
        }
        action = {
          type = "expire"
        }
      }
    ]
  })
}

resource "aws_ecr_repository" "controller" {
  name                 = "${var.project_name}/controller"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = var.kms_key_arn
  }

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-controller"
  })
}

resource "aws_ecr_lifecycle_policy" "controller" {
  repository = aws_ecr_repository.controller.name
  policy     = local.lifecycle_policy
}

resource "aws_ecr_repository" "agent_worker" {
  name                 = "${var.project_name}/agent-worker"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = var.kms_key_arn
  }

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-agent-worker"
  })
}

resource "aws_ecr_lifecycle_policy" "agent_worker" {
  repository = aws_ecr_repository.agent_worker.name
  policy     = local.lifecycle_policy
}
