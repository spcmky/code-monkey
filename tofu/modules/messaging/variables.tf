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

variable "notification_email" {
  description = "Email address for SNS notifications"
  type        = string
}

variable "message_retention_seconds" {
  description = "SQS message retention period in seconds"
  type        = number
  default     = 1209600 # 14 days
}

variable "visibility_timeout_seconds" {
  description = "SQS visibility timeout in seconds"
  type        = number
  default     = 900 # 15 min - enough for agent tasks
}

variable "max_receive_count" {
  description = "Maximum number of receives before sending to DLQ"
  type        = number
  default     = 3
}

variable "kms_key_arn" {
  description = "KMS key ARN for SNS topic and SQS queue encryption"
  type        = string
}

