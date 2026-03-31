#!/bin/bash
set -euo pipefail

# Initialize LocalStack with required AWS resources for local dev

REGION=us-east-2
GITHUB_PAT="${GITHUB_PAT:-ghp_REPLACE_WITH_YOUR_PAT}"

if [ "$GITHUB_PAT" = "ghp_REPLACE_WITH_YOUR_PAT" ]; then
  echo "WARNING: Using placeholder GitHub PAT. Set GITHUB_PAT env var for real usage." >&2
fi

echo "Creating SQS queues..."

# Dead letter queue first
awslocal sqs create-queue \
  --queue-name code-monkey-tasks-dlq \
  --region "$REGION"

DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url http://localhost:4566/000000000000/code-monkey-tasks-dlq \
  --attribute-names QueueArn \
  --region "$REGION" \
  --query 'Attributes.QueueArn' \
  --output text)

if [ -z "$DLQ_ARN" ]; then
  echo "ERROR: Failed to retrieve DLQ ARN" >&2
  exit 1
fi

# Task queue with DLQ
awslocal sqs create-queue \
  --queue-name code-monkey-tasks \
  --region "$REGION" \
  --attributes "{\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"${DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"3\\\"}\"}"

# Results queue
awslocal sqs create-queue \
  --queue-name code-monkey-results \
  --region "$REGION"

echo "Creating SNS topic..."
awslocal sns create-topic \
  --name code-monkey-notifications \
  --region "$REGION"

echo "Creating Secrets Manager secret..."
awslocal secretsmanager create-secret \
  --name code-monkey/github-pat \
  --secret-string "$GITHUB_PAT" \
  --region "$REGION"

echo "LocalStack initialization complete!"
echo ""
echo "SQS Task Queue: http://localhost:4566/000000000000/code-monkey-tasks"
echo "SQS DLQ:        http://localhost:4566/000000000000/code-monkey-tasks-dlq"
echo "SQS Results:    http://localhost:4566/000000000000/code-monkey-results"
echo "SNS Topic:      arn:aws:sns:us-east-2:000000000000:code-monkey-notifications"
echo "Secret:         code-monkey/github-pat"
