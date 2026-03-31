output "github_pat_secret_arn" {
  description = "ARN of the GitHub PAT secret"
  value       = aws_secretsmanager_secret.github_pat.arn
  sensitive   = true
}

output "github_pat_read_policy_arn" {
  description = "IAM policy ARN for reading GitHub PAT"
  value       = aws_iam_policy.github_pat_read.arn
  sensitive   = true
}
