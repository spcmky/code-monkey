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
  description = "AWS region for CloudWatch dashboard widgets"
  type        = string
}

variable "ecs_cluster_name" {
  description = "ECS cluster name for alarm dimensions"
  type        = string
}

variable "ecs_controller_service_name" {
  description = "ECS controller service name for alarm dimensions"
  type        = string
}

variable "rds_instance_id" {
  description = "RDS instance identifier for alarm dimensions"
  type        = string
}

variable "dlq_queue_name" {
  description = "SQS DLQ name for alarm dimensions"
  type        = string
}

variable "sns_alarm_topic_arn" {
  description = "SNS topic ARN for alarm notifications"
  type        = string
}
