output "task_queue_url" {
  description = "SQS task queue URL"
  value       = aws_sqs_queue.tasks.url
}

output "task_queue_arn" {
  description = "SQS task queue ARN"
  value       = aws_sqs_queue.tasks.arn
}

output "dlq_queue_url" {
  description = "SQS DLQ URL"
  value       = aws_sqs_queue.tasks_dlq.url
}

output "dlq_queue_arn" {
  description = "SQS DLQ ARN"
  value       = aws_sqs_queue.tasks_dlq.arn
}

output "dlq_queue_name" {
  description = "SQS DLQ name"
  value       = aws_sqs_queue.tasks_dlq.name
}

output "result_queue_url" {
  description = "SQS result queue URL"
  value       = aws_sqs_queue.results.url
}

output "result_queue_arn" {
  description = "SQS result queue ARN"
  value       = aws_sqs_queue.results.arn
}

output "notification_topic_arn" {
  description = "SNS notification topic ARN"
  value       = aws_sns_topic.notifications.arn
}
