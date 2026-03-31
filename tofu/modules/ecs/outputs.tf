output "cluster_arn" {
  description = "ECS cluster ARN"
  value       = aws_ecs_cluster.main.arn
}

output "cluster_name" {
  description = "ECS cluster name"
  value       = aws_ecs_cluster.main.name
}

output "controller_service_name" {
  description = "ECS controller service name"
  value       = aws_ecs_service.controller.name
}

output "task_role_arn" {
  description = "ECS task role ARN"
  value       = aws_iam_role.task.arn
  sensitive   = true
}

output "task_role_name" {
  description = "ECS task role name"
  value       = aws_iam_role.task.name
}

output "execution_role_arn" {
  description = "ECS execution role ARN"
  value       = aws_iam_role.execution.arn
  sensitive   = true
}

output "controller_task_definition_arn" {
  description = "Controller task definition ARN"
  value       = aws_ecs_task_definition.controller.arn
}

output "agent_worker_task_definition_arn" {
  description = "Agent worker task definition ARN"
  value       = aws_ecs_task_definition.agent_worker.arn
}
