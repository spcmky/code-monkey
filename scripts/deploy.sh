#!/usr/bin/env bash
set -euo pipefail

# Deploy script for OpenTofu infrastructure
# Usage: ./scripts/deploy.sh <environment>

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TOFU_DIR="${PROJECT_ROOT}/tofu"

usage() {
    cat <<EOF
Usage: $(basename "$0") <environment>

Deploy infrastructure to the specified environment.

Arguments:
  environment    Environment to deploy to (dev, prod)

Options:
  -h, --help    Show this help message

Examples:
  $(basename "$0") dev
  $(basename "$0") prod

EOF
    exit 1
}

# Parse arguments
if [[ $# -eq 0 ]] || [[ "$1" == "-h" ]] || [[ "$1" == "--help" ]]; then
    usage
fi

ENVIRONMENT="$1"

# Validate environment
if [[ ! "$ENVIRONMENT" =~ ^(dev|prod)$ ]]; then
    echo "ERROR: Invalid environment '$ENVIRONMENT'. Must be 'dev' or 'prod'."
    exit 1
fi

BACKEND_CONFIG="${TOFU_DIR}/environments/${ENVIRONMENT}.backend.hcl"
TFVARS_FILE="${TOFU_DIR}/environments/${ENVIRONMENT}.tfvars"

# Validate files exist
if [[ ! -f "$BACKEND_CONFIG" ]]; then
    echo "ERROR: Backend configuration not found: $BACKEND_CONFIG"
    exit 1
fi

if [[ ! -f "$TFVARS_FILE" ]]; then
    echo "ERROR: Variables file not found: $TFVARS_FILE"
    exit 1
fi

echo "=========================================="
echo "OpenTofu Deployment"
echo "=========================================="
echo "Environment:  $ENVIRONMENT"
echo "Backend:      $BACKEND_CONFIG"
echo "Variables:    $TFVARS_FILE"
echo "=========================================="
echo ""

cd "$TOFU_DIR"

# Initialize with backend configuration
echo "Initializing OpenTofu with backend configuration..."
tofu init -backend-config="$BACKEND_CONFIG" -reconfigure

echo ""
echo "Running OpenTofu plan..."
tofu plan -var-file="$TFVARS_FILE" -out=tfplan

echo ""
echo "=========================================="
echo "Plan complete. Review the changes above."
echo "=========================================="
echo ""

# Ask for confirmation
read -p "Do you want to apply these changes? (yes/no): " -r
echo

if [[ ! "$REPLY" =~ ^[Yy][Ee][Ss]$ ]]; then
    echo "Deployment cancelled."
    rm -f tfplan
    exit 0
fi

echo "Applying changes..."
tofu apply tfplan

echo ""
echo "=========================================="
echo "Deployment complete!"
echo "=========================================="
