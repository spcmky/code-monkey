# OpenTofu Infrastructure

Multi-environment infrastructure as code for the Code Monkey project.

## Structure

```
tofu/
├── main.tf                  # Root module - wires all submodules
├── variables.tf             # Root-level variables
├── providers.tf             # AWS provider and S3 backend config
├── versions.tf              # OpenTofu and provider version constraints
├── environments/            # Environment-specific configurations
│   ├── dev.tfvars          # Dev environment variables
│   ├── dev.backend.hcl     # Dev S3 backend configuration
│   ├── prod.tfvars         # Prod environment variables
│   └── prod.backend.hcl    # Prod S3 backend configuration
└── modules/                 # Reusable infrastructure modules
    ├── kms/
    ├── networking/
    ├── ecr/
    ├── database/
    ├── messaging/
    ├── secrets/
    ├── ecs/
    ├── bedrock/
    └── monitoring/
```

## Prerequisites

1. OpenTofu >= 1.6.0 installed
2. AWS CLI configured with appropriate credentials
3. S3 buckets and DynamoDB tables created for state management:

   **Development:**
   - S3 bucket: `code-monkey-tfstate-dev`
   - DynamoDB table: `code-monkey-tfstate-lock-dev`

   **Production:**
   - S3 bucket: `code-monkey-tfstate-prod`
   - DynamoDB table: `code-monkey-tfstate-lock-prod`

   Create these manually before first deployment:
   ```bash
   # Dev
   aws s3api create-bucket --bucket code-monkey-tfstate-dev --region us-east-2 --create-bucket-configuration LocationConstraint=us-east-2
   aws s3api put-bucket-versioning --bucket code-monkey-tfstate-dev --versioning-configuration Status=Enabled
   aws dynamodb create-table --table-name code-monkey-tfstate-lock-dev --attribute-definitions AttributeName=LockID,AttributeType=S --key-schema AttributeName=LockID,KeyType=HASH --billing-mode PAY_PER_REQUEST --region us-east-2

   # Prod
   aws s3api create-bucket --bucket code-monkey-tfstate-prod --region us-east-2 --create-bucket-configuration LocationConstraint=us-east-2
   aws s3api put-bucket-versioning --bucket code-monkey-tfstate-prod --versioning-configuration Status=Enabled
   aws dynamodb create-table --table-name code-monkey-tfstate-lock-prod --attribute-definitions AttributeName=LockID,AttributeType=S --key-schema AttributeName=LockID,KeyType=HASH --billing-mode PAY_PER_REQUEST --region us-east-2
   ```

## Environment Configurations

### Development (dev)
- VPC CIDR: 10.0.0.0/16
- Single NAT Gateway (cost-optimized)
- RDS: db.t4g.micro, single-AZ, 20GB storage
- ECS Controller: 256 CPU / 512 MB
- ECS Agent Worker: 512 CPU / 1024 MB
- Controller desired count: 1
- Deletion protection: disabled
- Backup retention: 3 days

### Production (prod)
- VPC CIDR: 10.1.0.0/16
- NAT Gateway per AZ (high availability)
- RDS: db.t4g.small, multi-AZ, 100GB storage
- ECS Controller: 512 CPU / 1024 MB
- ECS Agent Worker: 1024 CPU / 2048 MB
- Controller desired count: 2
- Deletion protection: enabled
- Backup retention: 30 days

## Deployment

### Using the deploy script (recommended)

```bash
# Deploy to dev
./scripts/deploy.sh dev

# Deploy to prod
./scripts/deploy.sh prod
```

The script will:
1. Initialize OpenTofu with environment-specific backend
2. Run a plan with environment-specific variables
3. Ask for confirmation
4. Apply the changes

### Manual deployment

```bash
cd tofu

# Initialize with backend configuration
tofu init -backend-config=environments/dev.backend.hcl -reconfigure

# Plan with environment-specific variables
tofu plan -var-file=environments/dev.tfvars -out=tfplan

# Review the plan, then apply
tofu apply tfplan
```

## Key Features

### Environment Isolation
- Separate state files per environment
- Environment-specific VPC CIDRs to avoid conflicts
- Conditional resource sizing and configuration
- Separate S3 buckets and DynamoDB tables

### Database Module
- Automatic multi-AZ for prod
- Environment-specific instance sizing
- Deletion protection enabled for prod only
- Skip final snapshot in dev for faster teardown

### ECS Module
- Environment-specific CPU/memory allocations
- Variable controller desired count (1 for dev, 2 for prod)
- Shared task definitions with environment-aware sizing

### Networking Module
- Single NAT Gateway for dev (cost-optimized)
- One NAT Gateway per AZ for prod (HA)
- Conditional route table associations

### Monitoring Module
- Relaxed alarm thresholds for dev
- Production-grade thresholds for prod
- CloudWatch dashboards per environment

## Modifying Configuration

To change environment-specific settings, edit the appropriate `.tfvars` file:
- `environments/dev.tfvars`
- `environments/prod.tfvars`

Common modifications:
```hcl
# Update notification email
notification_email = "your-email@example.com"

# Adjust ECS sizing
controller_cpu    = 512
controller_memory = 1024

# Scale controller instances
controller_desired_count = 2
```

After editing, run the deploy script to apply changes.

## State Management

State is stored in S3 with DynamoDB locking. Each environment has its own:
- S3 bucket for state storage
- DynamoDB table for state locking
- Separate state file path

State files are encrypted at rest and versioned for rollback capability.

## Troubleshooting

### Backend initialization fails
Ensure S3 bucket and DynamoDB table exist and you have appropriate AWS credentials:
```bash
aws sts get-caller-identity
aws s3 ls s3://code-monkey-tfstate-dev
aws dynamodb describe-table --table-name code-monkey-tfstate-lock-dev
```

### Plan shows unexpected changes
Check that you're using the correct tfvars file for your environment:
```bash
tofu plan -var-file=environments/dev.tfvars
```

### Switching between environments
Always use `-reconfigure` when switching backend configurations:
```bash
tofu init -backend-config=environments/prod.backend.hcl -reconfigure
```

## Best Practices

1. Always review the plan output before applying
2. Use the deploy script to prevent configuration drift
3. Never edit tfvars files directly in production without review
4. Keep backend state buckets secured and versioned
5. Test changes in dev before deploying to prod
6. Use workspace isolation via separate backends, not workspaces
