# DynamoDB table for colony snapshots (time-series metrics)
resource "aws_dynamodb_table" "colony_snapshots" {
  name         = "${var.project_name}-snapshots"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "roomName"
  range_key    = "timestamp"

  attribute {
    name = "roomName"
    type = "S"
  }

  attribute {
    name = "timestamp"
    type = "N"
  }

  # Enable TTL for automatic cleanup
  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  tags = {
    Project     = var.project_name
    Environment = var.environment
  }
}

# DynamoDB table for colony events (deaths, spawns, attacks, etc)
resource "aws_dynamodb_table" "colony_events" {
  name         = "${var.project_name}-events"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "roomName"
  range_key    = "eventId"

  attribute {
    name = "roomName"
    type = "S"
  }

  attribute {
    name = "eventId"
    type = "S"
  }

  attribute {
    name = "timestamp"
    type = "N"
  }

  # Global secondary index for querying by time
  global_secondary_index {
    name            = "timestamp-index"
    hash_key        = "roomName"
    range_key       = "timestamp"
    projection_type = "ALL"
  }

  # Enable TTL for automatic cleanup
  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  tags = {
    Project     = var.project_name
    Environment = var.environment
  }
}

# DynamoDB table for AI recommendations
resource "aws_dynamodb_table" "recommendations" {
  name         = "${var.project_name}-recommendations"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "id"

  attribute {
    name = "id"
    type = "S"
  }

  attribute {
    name = "status"
    type = "S"
  }

  attribute {
    name = "createdAt"
    type = "N"
  }

  # Index for querying by status
  global_secondary_index {
    name            = "status-index"
    hash_key        = "status"
    range_key       = "createdAt"
    projection_type = "ALL"
  }

  tags = {
    Project     = var.project_name
    Environment = var.environment
  }
}

# DynamoDB table for pattern detection state
resource "aws_dynamodb_table" "pattern_state" {
  name         = "${var.project_name}-pattern-state"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "patternId"

  attribute {
    name = "patternId"
    type = "S"
  }

  tags = {
    Project     = var.project_name
    Environment = var.environment
  }
}

# DynamoDB table for signal metrics (time-series)
resource "aws_dynamodb_table" "signals" {
  name         = "${var.project_name}-signals"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "roomName"
  range_key    = "timestamp"

  attribute {
    name = "roomName"
    type = "S"
  }

  attribute {
    name = "timestamp"
    type = "N"
  }

  # Enable TTL for automatic cleanup
  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  tags = {
    Project     = var.project_name
    Environment = var.environment
  }
}

# DynamoDB table for AI observations (replaces recommendations)
resource "aws_dynamodb_table" "observations" {
  name         = "${var.project_name}-observations"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "roomName"
  range_key    = "timestamp"

  attribute {
    name = "roomName"
    type = "S"
  }

  attribute {
    name = "timestamp"
    type = "N"
  }

  # Enable TTL for automatic cleanup (30 days)
  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  tags = {
    Project     = var.project_name
    Environment = var.environment
  }
}
