variable "project_name" {
  description = "Project name used for resource naming"
  type        = string
}

variable "common_tags" {
  description = "Common tags applied to all resources"
  type        = map(string)
}

variable "kms_key_arn" {
  description = "KMS key ARN for ECR repository encryption"
  type        = string
}
