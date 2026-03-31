output "dashboard_name" {
  description = "CloudWatch dashboard name"
  value       = aws_cloudwatch_dashboard.main.dashboard_name
}

output "dlq_alarm_arn" {
  description = "DLQ alarm ARN"
  value       = aws_cloudwatch_metric_alarm.dlq_messages.arn
  sensitive   = true
}

output "rds_cpu_alarm_arn" {
  description = "RDS CPU alarm ARN"
  value       = aws_cloudwatch_metric_alarm.rds_cpu.arn
  sensitive   = true
}
