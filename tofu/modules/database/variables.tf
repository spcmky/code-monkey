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

variable "vpc_id" {
  description = "VPC ID for database resources"
  type        = string
}

variable "private_subnet_ids" {
  description = "List of private subnet IDs for the DB subnet group"
  type        = list(string)
}

variable "rds_security_group_id" {
  description = "Security group ID for RDS instance"
  type        = string
}

variable "db_master_username" {
  type      = string
  sensitive = true
}

variable "instance_class" {
  description = "RDS instance class"
  type        = string
  default     = "db.t4g.micro"
}

variable "allocated_storage" {
  description = "Allocated storage in GB for the RDS instance"
  type        = number
  default     = 20
}

variable "backup_retention_period" {
  description = "Number of days to retain RDS backups"
  type        = number
  default     = 7
}

variable "kms_key_id" {
  description = "KMS key ID for encryption (Secrets Manager, RDS storage, CloudWatch Logs)"
  type        = string
}
