output "controller_repository_url" {
  description = "ECR repository URL for controller"
  value       = aws_ecr_repository.controller.repository_url
}

output "controller_repository_arn" {
  description = "ECR repository ARN for controller"
  value       = aws_ecr_repository.controller.arn
  sensitive   = true
}

output "agent_worker_repository_url" {
  description = "ECR repository URL for agent worker"
  value       = aws_ecr_repository.agent_worker.repository_url
}

output "agent_worker_repository_arn" {
  description = "ECR repository ARN for agent worker"
  value       = aws_ecr_repository.agent_worker.arn
  sensitive   = true
}
