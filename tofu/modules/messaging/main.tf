locals {
  name_prefix = "${var.project_name}-${var.environment}"
}

# --- Dead Letter Queue ---
resource "aws_sqs_queue" "tasks_dlq" {
  name                      = "${var.project_name}-tasks-dlq"
  message_retention_seconds = var.message_retention_seconds
  kms_master_key_id         = var.kms_key_arn

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-tasks-dlq"
  })
}

# --- Task Queue ---
resource "aws_sqs_queue" "tasks" {
  name                       = "${var.project_name}-tasks"
  visibility_timeout_seconds = var.visibility_timeout_seconds
  message_retention_seconds  = var.message_retention_seconds
  kms_master_key_id          = var.kms_key_arn

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.tasks_dlq.arn
    maxReceiveCount     = var.max_receive_count
  })

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-tasks"
  })
}

# --- Result Queue DLQ ---
resource "aws_sqs_queue" "results_dlq" {
  name                      = "${var.project_name}-results-dlq"
  message_retention_seconds = var.message_retention_seconds
  kms_master_key_id         = var.kms_key_arn

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-results-dlq"
  })
}

# --- Result Queue ---
resource "aws_sqs_queue" "results" {
  name                       = "${var.project_name}-results"
  visibility_timeout_seconds = var.visibility_timeout_seconds
  message_retention_seconds  = var.message_retention_seconds
  kms_master_key_id          = var.kms_key_arn

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.results_dlq.arn
    maxReceiveCount     = var.max_receive_count
  })

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-results"
  })
}

# --- SNS Notification Topic ---
resource "aws_sns_topic" "notifications" {
  name              = "${var.project_name}-notifications"
  kms_master_key_id = var.kms_key_arn

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-notifications"
  })
}

resource "aws_sns_topic_subscription" "email" {
  topic_arn = aws_sns_topic.notifications.arn
  protocol  = "email"
  endpoint  = var.notification_email
}
