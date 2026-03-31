variable "project_name" {
  description = "Project name used for resource naming"
  type        = string
}

variable "environment" {
  description = "Environment name (dev, staging, prod)"
  type        = string
}

variable "common_tags" {
  description = "Common tags applied to all resources"
  type        = map(string)
}

variable "aws_region" {
  description = "AWS region for resource ARN construction"
  type        = string
}

variable "account_id" {
  description = "AWS account ID for resource ARN construction"
  type        = string
}

variable "private_subnet_ids" {
  description = "List of private subnet IDs for ECS tasks"
  type        = list(string)
}

variable "ecs_security_group_id" {
  description = "Security group ID for ECS tasks"
  type        = string
}

variable "controller_image" {
  description = "Container image URI for the controller service"
  type        = string
}

variable "agent_worker_image" {
  description = "Container image URI for agent worker tasks"
  type        = string
}

variable "sqs_queue_url" {
  description = "SQS task queue URL"
  type        = string
}

variable "sqs_queue_arn" {
  description = "SQS task queue ARN"
  type        = string
}

variable "sqs_result_queue_url" {
  description = "SQS result queue URL"
  type        = string
}

variable "sqs_result_queue_arn" {
  description = "SQS result queue ARN"
  type        = string
}

variable "sns_topic_arn" {
  description = "SNS notification topic ARN"
  type        = string
}

variable "db_endpoint" {
  description = "RDS database endpoint"
  type        = string
}

variable "db_secret_arn" {
  description = "Secrets Manager ARN for DB credentials"
  type        = string
}

variable "github_secret_arn" {
  description = "Secrets Manager ARN for GitHub PAT"
  type        = string
}

variable "github_secret_policy_arn" {
  description = "IAM policy ARN for reading GitHub PAT secret"
  type        = string
}

variable "bedrock_invoke_policy_arn" {
  description = "IAM policy ARN for Bedrock model invocation"
  type        = string
}

variable "bedrock_guardrail_policy_arn" {
  description = "IAM policy ARN for Bedrock guardrails"
  type        = string
}

variable "controller_cpu" {
  description = "CPU units for controller Fargate tasks"
  type        = number
  default     = 512

  validation {
    condition     = contains([256, 512, 1024, 2048, 4096], var.controller_cpu)
    error_message = "Must be a valid Fargate CPU value: 256, 512, 1024, 2048, or 4096."
  }
}

variable "controller_memory" {
  description = "Memory (MiB) for controller Fargate tasks"
  type        = number
  default     = 1024

  validation {
    condition     = contains([512, 1024, 2048, 3072, 4096, 5120, 6144, 7168, 8192, 16384, 30720], var.controller_memory)
    error_message = "Must be a valid Fargate memory value for the selected CPU."
  }
}

variable "agent_worker_cpu" {
  description = "CPU units for agent worker Fargate tasks"
  type        = number
  default     = 1024

  validation {
    condition     = contains([256, 512, 1024, 2048, 4096], var.agent_worker_cpu)
    error_message = "Must be a valid Fargate CPU value: 256, 512, 1024, 2048, or 4096."
  }
}

variable "agent_worker_memory" {
  description = "Memory (MiB) for agent worker Fargate tasks"
  type        = number
  default     = 2048

  validation {
    condition     = contains([512, 1024, 2048, 3072, 4096, 5120, 6144, 7168, 8192, 16384, 30720], var.agent_worker_memory)
    error_message = "Must be a valid Fargate memory value for the selected CPU."
  }
}

variable "kms_key_arn" {
  description = "KMS key ARN for CloudWatch log group encryption"
  type        = string
}

variable "controller_poll_interval_seconds" {
  description = "Interval in seconds between controller poll cycles"
  type        = number
  default     = 300
}

variable "controller_desired_count" {
  description = "Desired count for the controller ECS service"
  type        = number
  default     = 1

  validation {
    condition     = var.controller_desired_count > 0
    error_message = "Controller desired count must be at least 1."
  }
}
