# Secrets Manager secrets for API credentials
# NOTE: After terraform apply, manually set the secret values in AWS Console
# or use AWS CLI: aws secretsmanager put-secret-value --secret-id <name> --secret-string <value>

resource "aws_secretsmanager_secret" "screeps_token" {
  name                    = var.screeps_token_secret_name
  description             = "Screeps API token for data collection"
  recovery_window_in_days = 0 # Allow immediate deletion for dev

  tags = {
    Project     = var.project_name
    Environment = var.environment
  }
}

resource "aws_secretsmanager_secret" "anthropic_key" {
  name                    = var.anthropic_api_key_secret_name
  description             = "Anthropic API key for Claude analysis"
  recovery_window_in_days = 0

  tags = {
    Project     = var.project_name
    Environment = var.environment
  }
}

# Outputs for reference
output "screeps_token_secret_arn" {
  description = "ARN of Screeps token secret"
  value       = aws_secretsmanager_secret.screeps_token.arn
}

output "anthropic_key_secret_arn" {
  description = "ARN of Anthropic API key secret"
  value       = aws_secretsmanager_secret.anthropic_key.arn
}
