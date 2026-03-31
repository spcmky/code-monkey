variable "project_name" {
  description = "Project name used for resource naming"
  type        = string
}

variable "environment" {
  description = "Environment name (dev, staging, prod)"
  type        = string
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC"
  type        = string
  default     = "10.0.0.0/16"
}

variable "common_tags" {
  description = "Common tags applied to all resources"
  type        = map(string)
}

variable "kms_key_arn" {
  description = "KMS key ARN for CloudWatch log group encryption"
  type        = string
}
