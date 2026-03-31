locals {
  name_prefix = "${var.project_name}-${var.environment}"
}

resource "aws_db_subnet_group" "main" {
  name       = "${local.name_prefix}-db-subnet"
  subnet_ids = var.private_subnet_ids

  tags = merge(var.common_tags, {
    Name = "${local.name_prefix}-db-subnet"
  })
}

resource "aws_db_parameter_group" "postgres16_pgvector" {
  name_prefix = "${local.name_prefix}-pg16-"
  family      = "postgres16"
  description = "PostgreSQL 16 with pgvector support"

  parameter {
    name         = "shared_preload_libraries"
    value        = "pgvector"
    apply_method = "pending-reboot"
  }

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  tags = merge(var.common_tags, {
    Name = "${local.name_prefix}-pg16-params"
  })

  lifecycle {
    create_before_destroy = true
  }
}

resource "random_password" "db_master" {
  length  = 32
  special = true
  override_special = "!#$%^&*()-_=+"
}

resource "aws_secretsmanager_secret" "db_credentials" {
  name_prefix = "${local.name_prefix}-db-creds-"
  description = "RDS master credentials for ${var.project_name}"
  kms_key_id  = var.kms_key_id

  tags = var.common_tags
}

resource "aws_secretsmanager_secret_version" "db_credentials" {
  secret_id = aws_secretsmanager_secret.db_credentials.id
  secret_string = jsonencode({
    username = var.db_master_username
    password = random_password.db_master.result
    host     = aws_db_instance.main.address
    port     = 5432
    dbname   = var.project_name
  })
}

resource "aws_db_instance" "main" {
  identifier = "${local.name_prefix}-postgres"

  engine               = "postgres"
  engine_version       = "16"
  instance_class       = var.instance_class
  allocated_storage    = var.allocated_storage
  storage_type         = "gp3"
  storage_encrypted    = true
  kms_key_id           = var.kms_key_id

  db_name  = replace(var.project_name, "-", "_")
  username = var.db_master_username
  password = random_password.db_master.result

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [var.rds_security_group_id]
  parameter_group_name   = aws_db_parameter_group.postgres16_pgvector.name

  multi_az            = false
  publicly_accessible = false
  skip_final_snapshot = var.environment != "prod"
  final_snapshot_identifier = var.environment == "prod" ? "${local.name_prefix}-final-snapshot" : null

  backup_retention_period = var.backup_retention_period
  backup_window           = "03:00-04:00"
  maintenance_window      = "Mon:04:00-Mon:05:00"

  enabled_cloudwatch_logs_exports = ["postgresql"]

  auto_minor_version_upgrade = true
  deletion_protection        = var.environment == "prod"

  tags = merge(var.common_tags, {
    Name = "${local.name_prefix}-postgres"
  })
}

resource "aws_cloudwatch_log_group" "rds_postgresql" {
  name              = "/aws/rds/instance/${local.name_prefix}-postgres/postgresql"
  retention_in_days = 30
  kms_key_id        = var.kms_key_id

  tags = var.common_tags
}
