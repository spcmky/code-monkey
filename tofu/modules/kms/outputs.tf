output "key_arn" {
  description = "KMS key ARN"
  value       = aws_kms_key.main.arn
  sensitive   = true
}

output "key_id" {
  description = "KMS key ID"
  value       = aws_kms_key.main.key_id
}

output "alias_arn" {
  description = "KMS key alias ARN"
  value       = aws_kms_alias.main.arn
  sensitive   = true
}
