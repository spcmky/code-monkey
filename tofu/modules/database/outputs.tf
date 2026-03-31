output "db_endpoint" {
  description = "RDS instance endpoint (host:port)"
  value       = aws_db_instance.main.endpoint
  sensitive   = true
}

output "db_instance_id" {
  description = "RDS instance identifier"
  value       = aws_db_instance.main.identifier
}

output "db_secret_arn" {
  description = "Secrets Manager ARN for DB credentials"
  value       = aws_secretsmanager_secret.db_credentials.arn
  sensitive   = true
}

output "db_address" {
  description = "RDS instance hostname"
  value       = aws_db_instance.main.address
  sensitive   = true
}
