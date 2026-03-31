output "invoke_policy_arn" {
  description = "IAM policy ARN for Bedrock model invocation"
  value       = aws_iam_policy.bedrock_invoke.arn
  sensitive   = true
}

output "guardrail_policy_arn" {
  description = "IAM policy ARN for Bedrock guardrails"
  value       = aws_iam_policy.bedrock_guardrails.arn
  sensitive   = true
}

output "guardrail_id" {
  description = "Bedrock guardrail ID"
  value       = aws_bedrock_guardrail.main.guardrail_id
}

output "guardrail_arn" {
  description = "Bedrock guardrail ARN"
  value       = aws_bedrock_guardrail.main.guardrail_arn
  sensitive   = true
}
