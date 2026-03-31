locals {
  common_tags = {
    project     = var.project_name
    environment = var.environment
    managed_by  = "opentofu"
  }

  name_prefix = "${var.project_name}-${var.environment}"
}

data "aws_caller_identity" "current" {}

# --- KMS ---
module "kms" {
  source = "./modules/kms"

  project_name = var.project_name
  environment  = var.environment
  aws_region   = var.aws_region
  common_tags  = local.common_tags
}

# --- Networking ---
module "networking" {
  source = "./modules/networking"

  project_name = var.project_name
  environment  = var.environment
  vpc_cidr     = var.vpc_cidr
  common_tags  = local.common_tags
  kms_key_arn  = module.kms.key_arn
}

# --- ECR ---
module "ecr" {
  source = "./modules/ecr"

  project_name = var.project_name
  common_tags  = local.common_tags
  kms_key_arn  = module.kms.key_arn
}

# --- Database ---
module "database" {
  source = "./modules/database"

  project_name      = var.project_name
  environment       = var.environment
  common_tags       = local.common_tags
  vpc_id            = module.networking.vpc_id
  private_subnet_ids = module.networking.private_subnet_ids
  rds_security_group_id = module.networking.rds_security_group_id
  db_master_username = var.db_master_username
  kms_key_id         = module.kms.key_id

  instance_class         = var.db_instance_class
  allocated_storage      = var.db_allocated_storage
  backup_retention_period = var.db_backup_retention_days
}

# --- Messaging ---
module "messaging" {
  source = "./modules/messaging"

  project_name       = var.project_name
  environment        = var.environment
  common_tags        = local.common_tags
  notification_email = var.notification_email
  kms_key_arn        = module.kms.key_arn
}

# --- Secrets ---
module "secrets" {
  source = "./modules/secrets"

  project_name = var.project_name
  environment  = var.environment
  common_tags  = local.common_tags
  kms_key_id   = module.kms.key_id
}

# --- ECS ---
module "ecs" {
  source = "./modules/ecs"

  project_name       = var.project_name
  environment        = var.environment
  common_tags        = local.common_tags
  aws_region         = var.aws_region
  account_id         = data.aws_caller_identity.current.account_id
  private_subnet_ids = module.networking.private_subnet_ids
  ecs_security_group_id = module.networking.ecs_security_group_id
  controller_image   = var.controller_image != "" ? var.controller_image : "${module.ecr.controller_repository_url}:latest"
  agent_worker_image = var.agent_worker_image != "" ? var.agent_worker_image : "${module.ecr.agent_worker_repository_url}:latest"

  sqs_queue_url            = module.messaging.task_queue_url
  sqs_queue_arn            = module.messaging.task_queue_arn
  sqs_result_queue_url     = module.messaging.result_queue_url
  sqs_result_queue_arn     = module.messaging.result_queue_arn
  sns_topic_arn            = module.messaging.notification_topic_arn
  db_endpoint              = module.database.db_endpoint
  db_secret_arn            = module.database.db_secret_arn
  github_secret_arn        = module.secrets.github_pat_secret_arn
  github_secret_policy_arn = module.secrets.github_pat_read_policy_arn
  bedrock_invoke_policy_arn = module.bedrock.invoke_policy_arn
  bedrock_guardrail_policy_arn = module.bedrock.guardrail_policy_arn
  kms_key_arn              = module.kms.key_arn

  controller_cpu           = var.controller_cpu
  controller_memory        = var.controller_memory
  agent_worker_cpu         = var.agent_worker_cpu
  agent_worker_memory      = var.agent_worker_memory
  controller_desired_count = var.controller_desired_count
}

# --- SQS Resource Policy (root-level to avoid circular dependency) ---
data "aws_iam_policy_document" "task_queue_policy" {
  statement {
    sid    = "AllowECSTaskRoleAccess"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = [module.ecs.task_role_arn]
    }

    actions = [
      "sqs:SendMessage",
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
      "sqs:ChangeMessageVisibility",
    ]

    resources = [module.messaging.task_queue_arn]
  }
}

resource "aws_sqs_queue_policy" "tasks" {
  queue_url = module.messaging.task_queue_url
  policy    = data.aws_iam_policy_document.task_queue_policy.json
}

# --- SQS Result Queue Policy ---
data "aws_iam_policy_document" "result_queue_policy" {
  statement {
    sid    = "AllowECSTaskRoleAccess"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = [module.ecs.task_role_arn]
    }

    actions = [
      "sqs:SendMessage",
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
      "sqs:ChangeMessageVisibility",
    ]

    resources = [module.messaging.result_queue_arn]
  }
}

resource "aws_sqs_queue_policy" "results" {
  queue_url = module.messaging.result_queue_url
  policy    = data.aws_iam_policy_document.result_queue_policy.json
}

# --- Bedrock ---
module "bedrock" {
  source = "./modules/bedrock"

  project_name   = var.project_name
  environment    = var.environment
  common_tags    = local.common_tags
  aws_region     = var.aws_region
  account_id     = data.aws_caller_identity.current.account_id
  ecs_task_role_arn  = module.ecs.task_role_arn
  ecs_task_role_name = module.ecs.task_role_name
  vpc_id             = module.networking.vpc_id
}

# --- Monitoring ---
module "monitoring" {
  source = "./modules/monitoring"

  project_name          = var.project_name
  environment           = var.environment
  common_tags           = local.common_tags
  aws_region            = var.aws_region
  ecs_cluster_name      = module.ecs.cluster_name
  ecs_controller_service_name = module.ecs.controller_service_name
  rds_instance_id       = module.database.db_instance_id
  dlq_queue_name        = module.messaging.dlq_queue_name
  sns_alarm_topic_arn   = module.messaging.notification_topic_arn
}
