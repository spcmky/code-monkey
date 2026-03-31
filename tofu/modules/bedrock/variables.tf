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
  description = "AWS region for Bedrock resource ARNs"
  type        = string
}

variable "account_id" {
  description = "AWS account ID for resource ARN construction"
  type        = string
}

variable "ecs_task_role_arn" {
  description = "ECS task role ARN to attach Bedrock policies to"
  type        = string
}

variable "vpc_id" {
  description = "VPC ID for IAM policy source VPC condition"
  type        = string
}

variable "ecs_task_role_name" {
  description = "ECS task role name for policy attachments"
  type        = string
}
