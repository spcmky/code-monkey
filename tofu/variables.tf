variable "project_name" {
  description = "Project name used for resource naming and tagging"
  type        = string
  default     = "code-monkey"
}

variable "environment" {
  description = "Environment name (dev, staging, prod)"
  type        = string
  default     = "dev"

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "Environment must be one of: dev, staging, prod."
  }
}

variable "aws_region" {
  description = "AWS region for all resources"
  type        = string
  default     = "us-east-2"
}

variable "notification_email" {
  description = "Email address for SNS escalation notifications"
  type        = string

  validation {
    condition     = can(regex("^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$", var.notification_email))
    error_message = "Must be a valid email address."
  }
}

variable "controller_image" {
  description = "Container image URI for the controller service"
  type        = string
  default     = ""

  validation {
    condition     = var.controller_image == "" || length(trimspace(var.controller_image)) > 0
    error_message = "controller_image must be a non-empty string if provided."
  }
}

variable "agent_worker_image" {
  description = "Container image URI for agent worker tasks"
  type        = string
  default     = ""

  validation {
    condition     = var.agent_worker_image == "" || length(trimspace(var.agent_worker_image)) > 0
    error_message = "agent_worker_image must be a non-empty string if provided."
  }
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC"
  type        = string
  default     = "10.0.0.0/16"

  validation {
    condition     = can(cidrhost(var.vpc_cidr, 0))
    error_message = "Must be a valid CIDR block."
  }
}

variable "db_master_username" {
  description = "Master username for the RDS instance"
  type        = string
  default     = "codemonkey"
  sensitive   = true
}

variable "db_instance_class" {
  description = "RDS instance class"
  type        = string
  default     = "db.t4g.micro"
}

variable "db_allocated_storage" {
  description = "Allocated storage in GB for the RDS instance"
  type        = number
  default     = 20
}

variable "db_backup_retention_days" {
  description = "Number of days to retain RDS backups"
  type        = number
  default     = 7
}

variable "controller_cpu" {
  description = "CPU units for controller Fargate tasks"
  type        = number
  default     = 256

  validation {
    condition     = contains([256, 512, 1024, 2048, 4096], var.controller_cpu)
    error_message = "Must be a valid Fargate CPU value: 256, 512, 1024, 2048, or 4096."
  }
}

variable "controller_memory" {
  description = "Memory (MiB) for controller Fargate tasks"
  type        = number
  default     = 512

  validation {
    condition     = contains([512, 1024, 2048, 3072, 4096, 5120, 6144, 7168, 8192, 16384, 30720], var.controller_memory)
    error_message = "Must be a valid Fargate memory value for the selected CPU."
  }
}

variable "agent_worker_cpu" {
  description = "CPU units for agent worker Fargate tasks"
  type        = number
  default     = 512

  validation {
    condition     = contains([256, 512, 1024, 2048, 4096], var.agent_worker_cpu)
    error_message = "Must be a valid Fargate CPU value: 256, 512, 1024, 2048, or 4096."
  }
}

variable "agent_worker_memory" {
  description = "Memory (MiB) for agent worker Fargate tasks"
  type        = number
  default     = 1024

  validation {
    condition     = contains([512, 1024, 2048, 3072, 4096, 5120, 6144, 7168, 8192, 16384, 30720], var.agent_worker_memory)
    error_message = "Must be a valid Fargate memory value for the selected CPU."
  }
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
