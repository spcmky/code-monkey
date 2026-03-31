locals {
  name_prefix = "${var.project_name}-${var.environment}"
}

# --- ECS Cluster ---
resource "aws_ecs_cluster" "main" {
  name = "${local.name_prefix}-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = merge(var.common_tags, {
    Name = "${local.name_prefix}-cluster"
  })
}

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name = aws_ecs_cluster.main.name

  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
    base              = 1
  }
}

# --- IAM: Execution Role (ECR pull, log writing) ---
data "aws_iam_policy_document" "ecs_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name_prefix = "${local.name_prefix}-exec-"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json

  tags = var.common_tags
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Execution role needs to read secrets for container env injection
data "aws_iam_policy_document" "execution_secrets" {
  statement {
    sid    = "ReadSecrets"
    effect = "Allow"
    actions = [
      "secretsmanager:GetSecretValue",
    ]
    resources = [
      var.db_secret_arn,
      var.github_secret_arn,
    ]
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  name   = "secrets-access"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secrets.json
}

# --- IAM: Task Role (app-level permissions) ---
resource "aws_iam_role" "task" {
  name_prefix        = "${local.name_prefix}-task-"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json

  tags = var.common_tags
}

# SQS permissions
data "aws_iam_policy_document" "task_sqs" {
  statement {
    sid    = "SQSAccess"
    effect = "Allow"
    actions = [
      "sqs:SendMessage",
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
      "sqs:ChangeMessageVisibility",
    ]
    resources = [
      var.sqs_queue_arn,
      var.sqs_result_queue_arn,
    ]
  }
}

resource "aws_iam_role_policy" "task_sqs" {
  name   = "sqs-access"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task_sqs.json
}

# SNS permissions
data "aws_iam_policy_document" "task_sns" {
  statement {
    sid       = "SNSPublish"
    effect    = "Allow"
    actions   = ["sns:Publish"]
    resources = [var.sns_topic_arn]
  }
}

resource "aws_iam_role_policy" "task_sns" {
  name   = "sns-access"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task_sns.json
}

# Secrets Manager read (task-level for runtime access)
data "aws_iam_policy_document" "task_secrets" {
  statement {
    sid    = "ReadSecrets"
    effect = "Allow"
    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
    ]
    resources = [
      var.db_secret_arn,
      var.github_secret_arn,
    ]
  }
}

resource "aws_iam_role_policy" "task_secrets" {
  name   = "secrets-access"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task_secrets.json
}

# ECS RunTask permission (controller spawns agent workers)
data "aws_iam_policy_document" "task_ecs_run" {
  statement {
    sid    = "ECSRunTask"
    effect = "Allow"
    actions = [
      "ecs:RunTask",
      "ecs:DescribeTasks",
      "ecs:StopTask",
    ]
    resources = [
      "arn:aws:ecs:${var.aws_region}:${var.account_id}:task/${aws_ecs_cluster.main.name}/*",
      "arn:aws:ecs:${var.aws_region}:${var.account_id}:task-definition/${local.name_prefix}-agent-worker:*",
    ]
  }

  statement {
    sid       = "PassRole"
    effect    = "Allow"
    actions   = ["iam:PassRole"]
    resources = [
      aws_iam_role.execution.arn,
      aws_iam_role.task.arn,
    ]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "task_ecs_run" {
  name   = "ecs-run-task"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task_ecs_run.json
}

# Attach Bedrock policies (passed from bedrock module)
resource "aws_iam_role_policy_attachment" "task_bedrock_invoke" {
  role       = aws_iam_role.task.name
  policy_arn = var.bedrock_invoke_policy_arn
}

resource "aws_iam_role_policy_attachment" "task_bedrock_guardrail" {
  role       = aws_iam_role.task.name
  policy_arn = var.bedrock_guardrail_policy_arn
}

resource "aws_iam_role_policy_attachment" "task_github_secret" {
  role       = aws_iam_role.task.name
  policy_arn = var.github_secret_policy_arn
}

# --- CloudWatch Log Groups ---
# NOTE: aws_cloudwatch_log_group.kms_key_id accepts a KMS key ARN (despite the
# attribute name suggesting a Key ID). Using var.kms_key_arn here is correct.
# See: https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/cloudwatch_log_group#kms_key_id
resource "aws_cloudwatch_log_group" "controller" {
  name              = "/ecs/${var.project_name}/controller"
  retention_in_days = 30
  kms_key_id        = var.kms_key_arn
  tags              = var.common_tags
}

resource "aws_cloudwatch_log_group" "agent_worker" {
  name              = "/ecs/${var.project_name}/agent-worker"
  retention_in_days = 30
  kms_key_id        = var.kms_key_arn
  tags              = var.common_tags
}

# --- Task Definition: Controller ---
resource "aws_ecs_task_definition" "controller" {
  family                   = "${local.name_prefix}-controller"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.controller_cpu
  memory                   = var.controller_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([
    {
      name      = "controller"
      image     = var.controller_image
      essential = true
      cpu       = var.controller_cpu
      memory    = var.controller_memory

      environment = [
        { name = "PROJECT_NAME", value = var.project_name },
        { name = "ENVIRONMENT", value = var.environment },
        { name = "AWS_REGION", value = var.aws_region },
        { name = "SQS_QUEUE_URL", value = var.sqs_queue_url },
        { name = "SQS_RESULT_QUEUE_URL", value = var.sqs_result_queue_url },
        { name = "SNS_TOPIC_ARN", value = var.sns_topic_arn },
        { name = "DB_ENDPOINT", value = var.db_endpoint },
        { name = "POLL_INTERVAL_SECONDS", value = tostring(var.controller_poll_interval_seconds) },
        { name = "ECS_CLUSTER", value = aws_ecs_cluster.main.name },
        { name = "AGENT_TASK_DEFINITION", value = "${local.name_prefix}-agent-worker" },
        { name = "AGENT_SUBNETS", value = join(",", var.private_subnet_ids) },
        { name = "AGENT_SECURITY_GROUP", value = var.ecs_security_group_id },
      ]

      secrets = [
        {
          name      = "DB_CREDENTIALS"
          valueFrom = var.db_secret_arn
        },
        {
          name      = "GITHUB_PAT"
          valueFrom = var.github_secret_arn
        },
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.controller.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "controller"
        }
      }

      healthCheck = {
        command     = ["CMD-SHELL", "pgrep -f 'node dist/index.js' || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 60
      }
    }
  ])

  tags = merge(var.common_tags, {
    Name = "${local.name_prefix}-controller"
  })
}

# --- Task Definition: Agent Worker ---
resource "aws_ecs_task_definition" "agent_worker" {
  family                   = "${local.name_prefix}-agent-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.agent_worker_cpu
  memory                   = var.agent_worker_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([
    {
      name      = "agent-worker"
      image     = var.agent_worker_image
      essential = true
      cpu       = var.agent_worker_cpu
      memory    = var.agent_worker_memory

      environment = [
        { name = "PROJECT_NAME", value = var.project_name },
        { name = "ENVIRONMENT", value = var.environment },
        { name = "AWS_REGION", value = var.aws_region },
        { name = "SQS_QUEUE_URL", value = var.sqs_queue_url },
        { name = "SQS_RESULT_QUEUE_URL", value = var.sqs_result_queue_url },
        { name = "SNS_TOPIC_ARN", value = var.sns_topic_arn },
        { name = "DB_ENDPOINT", value = var.db_endpoint },
      ]

      secrets = [
        {
          name      = "DB_CREDENTIALS"
          valueFrom = var.db_secret_arn
        },
        {
          name      = "GITHUB_PAT"
          valueFrom = var.github_secret_arn
        },
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.agent_worker.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "agent"
        }
      }
    }
  ])

  tags = merge(var.common_tags, {
    Name = "${local.name_prefix}-agent-worker"
  })
}

# --- ECS Service: Controller ---
resource "aws_ecs_service" "controller" {
  name            = "${local.name_prefix}-controller"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.controller.arn
  desired_count   = var.controller_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [var.ecs_security_group_id]
    assign_public_ip = false
  }

  deployment_configuration {
    maximum_percent         = 200
    minimum_healthy_percent = 100
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  tags = merge(var.common_tags, {
    Name = "${local.name_prefix}-controller-service"
  })

  lifecycle {
    ignore_changes = [task_definition]
  }
}
