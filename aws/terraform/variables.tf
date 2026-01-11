variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}

variable "aws_profile" {
  description = "AWS CLI profile to use"
  type        = string
  default     = "screeps-monitor"
}

variable "project_name" {
  description = "Project name prefix for resources"
  type        = string
  default     = "screeps-advisor"
}

variable "environment" {
  description = "Environment (dev, prod)"
  type        = string
  default     = "prod"
}

variable "screeps_token_secret_name" {
  description = "Name of the Secrets Manager secret containing Screeps API token"
  type        = string
  default     = "screeps/api-token"
}

variable "anthropic_api_key_secret_name" {
  description = "Name of the Secrets Manager secret containing Anthropic API key"
  type        = string
  default     = "screeps/anthropic-api-key"
}

variable "snapshot_retention_days" {
  description = "Number of days to retain snapshot data"
  type        = number
  default     = 30
}

variable "event_retention_days" {
  description = "Number of days to retain event data"
  type        = number
  default     = 90
}
