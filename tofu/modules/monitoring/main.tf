locals {
  name_prefix = "${var.project_name}-${var.environment}"

  # Environment-specific alarm thresholds
  rds_cpu_threshold = var.environment == "prod" ? 80 : 90
  rds_cpu_evaluation_periods = var.environment == "prod" ? 3 : 5
}

# Log groups are managed by the ECS module.
# This module focuses on alarms and dashboards.

# --- Alarms ---
resource "aws_cloudwatch_metric_alarm" "dlq_messages" {
  alarm_name          = "${local.name_prefix}-dlq-messages"
  alarm_description   = "Messages in DLQ indicate failed task processing"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = var.dlq_queue_name
  }

  alarm_actions = [var.sns_alarm_topic_arn]
  ok_actions    = [var.sns_alarm_topic_arn]

  tags = var.common_tags
}

resource "aws_cloudwatch_metric_alarm" "ecs_task_failures" {
  alarm_name          = "${local.name_prefix}-ecs-task-failures"
  alarm_description   = "ECS controller service task failures"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "ServiceCount"
  namespace           = "ECS/ContainerInsights"
  period              = 300
  statistic           = "Minimum"
  threshold           = 0
  treat_missing_data  = "breaching"

  dimensions = {
    ClusterName = var.ecs_cluster_name
    ServiceName = var.ecs_controller_service_name
  }

  alarm_actions = [var.sns_alarm_topic_arn]

  tags = var.common_tags
}

resource "aws_cloudwatch_metric_alarm" "rds_cpu" {
  alarm_name          = "${local.name_prefix}-rds-cpu-high"
  alarm_description   = "RDS CPU utilization above ${local.rds_cpu_threshold}%"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = local.rds_cpu_evaluation_periods
  metric_name         = "CPUUtilization"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Average"
  threshold           = local.rds_cpu_threshold
  treat_missing_data  = "notBreaching"

  dimensions = {
    DBInstanceIdentifier = var.rds_instance_id
  }

  alarm_actions = [var.sns_alarm_topic_arn]
  ok_actions    = [var.sns_alarm_topic_arn]

  tags = var.common_tags
}

# --- Dashboard ---
resource "aws_cloudwatch_dashboard" "main" {
  dashboard_name = "${local.name_prefix}-dashboard"

  dashboard_body = jsonencode({
    widgets = [
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 12
        height = 6
        properties = {
          title   = "ECS Controller - CPU & Memory"
          region  = var.aws_region
          metrics = [
            ["AWS/ECS", "CPUUtilization", "ClusterName", var.ecs_cluster_name, "ServiceName", var.ecs_controller_service_name],
            ["AWS/ECS", "MemoryUtilization", "ClusterName", var.ecs_cluster_name, "ServiceName", var.ecs_controller_service_name],
          ]
          period = 300
          stat   = "Average"
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 0
        width  = 12
        height = 6
        properties = {
          title   = "RDS - CPU & Connections"
          region  = var.aws_region
          metrics = [
            ["AWS/RDS", "CPUUtilization", "DBInstanceIdentifier", var.rds_instance_id],
            ["AWS/RDS", "DatabaseConnections", "DBInstanceIdentifier", var.rds_instance_id],
          ]
          period = 300
          stat   = "Average"
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 6
        width  = 12
        height = 6
        properties = {
          title   = "SQS - Task Queue Depth"
          region  = var.aws_region
          metrics = [
            ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", "${var.project_name}-tasks"],
            ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", var.dlq_queue_name],
          ]
          period = 300
          stat   = "Sum"
        }
      },
      {
        type   = "log"
        x      = 12
        y      = 6
        width  = 12
        height = 6
        properties = {
          title   = "Controller Logs (Recent Errors)"
          region  = var.aws_region
          query   = "SOURCE '/ecs/${var.project_name}/controller' | fields @timestamp, @message | filter @message like /ERROR|Exception|error/ | sort @timestamp desc | limit 20"
          view    = "table"
        }
      },
    ]
  })
}
