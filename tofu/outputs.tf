output "vpc_id" {
  description = "VPC ID"
  value       = module.networking.vpc_id
}

output "ecs_cluster_arn" {
  description = "ECS cluster ARN"
  value       = module.ecs.cluster_arn
  sensitive   = true
}

output "controller_service_name" {
  description = "ECS controller service name"
  value       = module.ecs.controller_service_name
}

output "task_queue_url" {
  description = "SQS task queue URL"
  value       = module.messaging.task_queue_url
}

output "notification_topic_arn" {
  description = "SNS notification topic ARN"
  value       = module.messaging.notification_topic_arn
  sensitive   = true
}

output "db_endpoint" {
  description = "RDS Postgres endpoint"
  value       = module.database.db_endpoint
  sensitive   = true
}

output "controller_ecr_url" {
  description = "ECR repository URL for controller image"
  value       = module.ecr.controller_repository_url
}

output "agent_worker_ecr_url" {
  description = "ECR repository URL for agent worker image"
  value       = module.ecr.agent_worker_repository_url
}

output "bedrock_guardrail_id" {
  description = "Bedrock guardrail ID"
  value       = module.bedrock.guardrail_id
}

output "github_pat_secret_arn" {
  description = "Secrets Manager ARN for GitHub PAT"
  value       = module.secrets.github_pat_secret_arn
  sensitive   = true
}
