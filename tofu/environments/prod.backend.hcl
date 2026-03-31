bucket         = "code-monkey-tfstate-prod"
key            = "code-monkey/terraform.tfstate"
region         = "us-east-2"
encrypt        = true
dynamodb_table = "code-monkey-tfstate-lock-prod"
