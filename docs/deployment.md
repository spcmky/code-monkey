# Deployment

Guide for running Code Monkey locally and deploying to AWS.

---

## Prerequisites

| Tool | Version | Purpose |
|---|---|---|
| Node.js | >= 22.0.0 | Runtime |
| Docker + Docker Compose | Latest | Local development environment |
| OpenTofu | >= 1.6.0 | AWS infrastructure provisioning |
| AWS CLI | v2 | AWS account configuration |
| Git | Latest | Repository operations |

You also need:
- An AWS account with Bedrock model access enabled in `us-east-2`
- A GitHub Personal Access Token (PAT) with `repo` scope for watched repositories

---

## Environment Setup

Code Monkey supports two environments:

| Environment | Stack | Compute |
|---|---|---|
| **dev** | Docker Compose + LocalStack | Local containers |
| **prod** | AWS ECS Fargate + RDS + SQS/SNS + Bedrock | Managed AWS services |

---

## Local Development

### 1. Configure environment variables

```bash
cp .env.example .env
```

Edit `.env` and set at minimum:

```bash
DB_PASSWORD=<strong-password>
GITHUB_PAT_SECRET_ARN=arn:aws:secretsmanager:us-east-2:000000000000:secret:local-github-pat
WATCHED_REPOS=owner/repo
```

### 2. Start services

```bash
docker-compose up
```

This starts four containers:

| Container | Image | Port | Network |
|---|---|---|---|
| `code-monkey-db` | pgvector/pgvector:0.8.0-pg16 | 127.0.0.1:5432 | db, tools |
| `code-monkey-controller` | Dockerfile.controller | -- | db, services |
| `code-monkey-agent` | Dockerfile.agent | -- | db, services |
| `code-monkey-localstack` | localstack/localstack:3.5 | 127.0.0.1:4566 | services |

LocalStack provides SQS, SNS, and Secrets Manager with `DEFAULT_REGION=us-east-2`.

**Database migrations run automatically on startup** -- the migration SQL files are mounted into the PostgreSQL container's init directory.

### 3. Optional: pgAdmin

```bash
docker-compose --profile tools up
```

This adds pgAdmin at `http://127.0.0.1:5050`. Set `PGADMIN_EMAIL` and `PGADMIN_PASSWORD` in `.env`.

### 4. Development without Docker

```bash
npm install
npm run dev          # Controller with hot reload (tsx watch)
npm run worker:dev   # Agent worker with hot reload
npm run test         # Run tests (vitest)
```

### Docker Compose Networks

| Network | Purpose |
|---|---|
| `db` | PostgreSQL <-> Controller, Agent Worker |
| `services` | Controller <-> Agent Worker <-> LocalStack |
| `tools` | PostgreSQL <-> pgAdmin |

### Container Security

All containers run with:
- `cap_drop: ALL` (minimal capabilities added back per container)
- `security_opt: no-new-privileges:true`
- `read_only: true` filesystem (with tmpfs for `/tmp`)
- Resource limits (CPU and memory)
- `json-file` logging with 10MB rotation, max 3 files

---

## AWS Deployment

### OpenTofu Structure

Infrastructure is defined in `tofu/` with 9 modules:

```
tofu/
  main.tf              # Root module, wires all child modules together
  variables.tf         # Root input variables
  outputs.tf           # Root outputs
  providers.tf         # AWS provider config
  versions.tf          # OpenTofu >= 1.6, AWS provider ~> 5.40
  modules/
    kms/               # KMS key for encrypting everything
    networking/         # VPC, subnets, security groups
    ecr/               # Container registries (controller + agent-worker)
    database/           # RDS PostgreSQL 16 + pgvector
    messaging/          # SQS queues (task + result + DLQ), SNS topic
    secrets/            # Secrets Manager (GitHub PAT)
    ecs/               # ECS cluster, task definitions, services, IAM roles
    bedrock/            # Bedrock model access policies, guardrail
    monitoring/         # CloudWatch alarms and dashboards
```

### Key Infrastructure Decisions

| Resource | Configuration |
|---|---|
| **RDS** | db.t4g.micro (configurable), PostgreSQL 16, pgvector, `force_ssl=1`, KMS encrypted, `multi_az` in prod only |
| **ECS Controller** | FARGATE, single replica, private subnets, no public IP |
| **ECS Agent Worker** | FARGATE_SPOT, private subnets, no public IP |
| **SQS** | Task queue + Result queue + DLQ, KMS encrypted |
| **SNS** | Escalation notification topic, KMS encrypted |
| **Bedrock** | Scoped to 4 models: Opus 4, Sonnet 4, Haiku 4.5, Titan Embed Text v2 |
| **KMS** | Single key encrypts all resources |

### Environment Separation

Environment-specific variable files (`dev.tfvars`, `prod.tfvars`) are being set up. The `environment` variable accepts `dev`, `staging`, or `prod` and controls:

- `multi_az` for RDS (prod only)
- `skip_final_snapshot` (disabled in prod)
- Resource sizing

### State Backend

The S3 backend for remote state is commented out in the configuration, ready to enable once the S3 bucket and DynamoDB lock table are created.

### Deploy Steps

```bash
cd tofu

# Initialize
tofu init

# Plan (review changes)
tofu plan -var-file=dev.tfvars -out=plan.tfplan

# Apply
tofu apply plan.tfplan
```

### Post-Deploy Steps

1. **Push Docker images to ECR:**

```bash
# Authenticate
aws ecr get-login-password --region us-east-2 | \
  docker login --username AWS --password-stdin <account-id>.dkr.ecr.us-east-2.amazonaws.com

# Build and push
docker build -f Dockerfile.controller -t <account-id>.dkr.ecr.us-east-2.amazonaws.com/code-monkey-controller:latest .
docker push <account-id>.dkr.ecr.us-east-2.amazonaws.com/code-monkey-controller:latest

docker build -f Dockerfile.agent -t <account-id>.dkr.ecr.us-east-2.amazonaws.com/code-monkey-agent-worker:latest .
docker push <account-id>.dkr.ecr.us-east-2.amazonaws.com/code-monkey-agent-worker:latest
```

2. **Set GitHub PAT in Secrets Manager:**

```bash
aws secretsmanager put-secret-value \
  --secret-id code-monkey-dev-github-pat \
  --secret-string '{"token":"ghp_your_token_here"}' \
  --region us-east-2
```

3. **Verify ECS services are running:**

```bash
aws ecs describe-services \
  --cluster code-monkey-dev-cluster \
  --services code-monkey-dev-controller \
  --region us-east-2
```

---

## Environment Variables Reference

| Variable | Required | Default | Description |
|---|---|---|---|
| `AWS_REGION` | No | `us-east-2` | AWS region for all services |
| `AWS_PROFILE` | No | `default` | AWS CLI profile |
| `AWS_ENDPOINT_URL` | No | (empty) | Override for LocalStack (`http://localhost:4566`) |
| `GITHUB_PAT_SECRET_ARN` | Yes | -- | Secrets Manager ARN containing the GitHub PAT |
| `DB_HOST` | Yes | `localhost` | PostgreSQL host |
| `DB_PORT` | No | `5432` | PostgreSQL port |
| `DB_NAME` | Yes | `code_monkey` | Database name |
| `DB_USER` | Yes | `code_monkey` | Database user |
| `DB_PASSWORD` | Yes | -- | Database password |
| `DB_SSL` | No | `false` | Enable SSL for database connection |
| `DB_CA_CERT` | No | (empty) | CA certificate path for RDS SSL |
| `PGADMIN_EMAIL` | No | -- | pgAdmin login email (tools profile only) |
| `PGADMIN_PASSWORD` | No | -- | pgAdmin login password (tools profile only) |
| `SQS_TASK_QUEUE_URL` | Yes | -- | SQS task queue URL |
| `SQS_RESULT_QUEUE_URL` | Yes | -- | SQS result queue URL |
| `SNS_ESCALATION_TOPIC_ARN` | Yes | -- | SNS topic ARN for escalation notifications |
| `BEDROCK_GUARDRAIL_ID` | No | (empty) | Bedrock guardrail ID (created by OpenTofu) |
| `BEDROCK_GUARDRAIL_VERSION` | No | `DRAFT` | Bedrock guardrail version |
| `POLL_INTERVAL_CRON` | No | `*/5 * * * *` | Cron expression for GitHub polling interval |
| `WATCHED_REPOS` | Yes | -- | Comma-separated list of `owner/repo` to monitor |
| `WORK_DIR` | No | `/tmp/code-monkey-workspaces` | Directory for Git clones and workspaces |
| `LOG_LEVEL` | No | `info` | Log level: debug, info, warn, error |
