# Data Collector Lambda
data "archive_file" "data_collector" {
  type        = "zip"
  source_dir  = "${path.module}/../lambda/data-collector"
  output_path = "${path.module}/builds/data-collector.zip"
}

resource "aws_lambda_function" "data_collector" {
  function_name    = "screeps-data-collector-${var.environment}"
  filename         = data.archive_file.data_collector.output_path
  source_code_hash = data.archive_file.data_collector.output_base64sha256
  role             = aws_iam_role.data_collector.arn
  handler          = "index.handler"
  runtime          = "nodejs20.x"
  timeout          = 30
  memory_size      = 256

  environment {
    variables = {
      SNAPSHOTS_TABLE       = aws_dynamodb_table.colony_snapshots.name
      EVENTS_TABLE          = aws_dynamodb_table.colony_events.name
      SIGNALS_TABLE         = aws_dynamodb_table.signals.name
      SCREEPS_TOKEN_SECRET  = aws_secretsmanager_secret.screeps_token.arn
      SCREEPS_SHARD         = var.screeps_shard
    }
  }
}

# Analysis Engine Lambda
data "archive_file" "analysis_engine" {
  type        = "zip"
  source_dir  = "${path.module}/../lambda/analysis-engine"
  output_path = "${path.module}/builds/analysis-engine.zip"
}

resource "aws_lambda_function" "analysis_engine" {
  function_name    = "screeps-analysis-engine-${var.environment}"
  filename         = data.archive_file.analysis_engine.output_path
  source_code_hash = data.archive_file.analysis_engine.output_base64sha256
  role             = aws_iam_role.analysis_engine.arn
  handler          = "index.handler"
  runtime          = "nodejs20.x"
  timeout          = 120
  memory_size      = 512

  environment {
    variables = {
      SNAPSHOTS_TABLE       = aws_dynamodb_table.colony_snapshots.name
      OBSERVATIONS_TABLE    = aws_dynamodb_table.observations.name
      SIGNALS_TABLE         = aws_dynamodb_table.signals.name
      ANTHROPIC_KEY_SECRET  = aws_secretsmanager_secret.anthropic_key.arn
    }
  }
}

# API Lambda
data "archive_file" "api" {
  type        = "zip"
  source_dir  = "${path.module}/../lambda/api"
  output_path = "${path.module}/builds/api.zip"
}

resource "aws_lambda_function" "api" {
  function_name    = "screeps-api-${var.environment}"
  filename         = data.archive_file.api.output_path
  source_code_hash = data.archive_file.api.output_base64sha256
  role             = aws_iam_role.api.arn
  handler          = "index.handler"
  runtime          = "nodejs20.x"
  timeout          = 30
  memory_size      = 256

  environment {
    variables = {
      SNAPSHOTS_TABLE       = aws_dynamodb_table.colony_snapshots.name
      EVENTS_TABLE          = aws_dynamodb_table.colony_events.name
      RECOMMENDATIONS_TABLE = aws_dynamodb_table.recommendations.name
      SIGNALS_TABLE         = aws_dynamodb_table.signals.name
      OBSERVATIONS_TABLE    = aws_dynamodb_table.observations.name
      SCREEPS_TOKEN_SECRET  = aws_secretsmanager_secret.screeps_token.arn
      SCREEPS_SHARD         = var.screeps_shard
    }
  }
}

# Observation Writer Lambda
data "archive_file" "observation_writer" {
  type        = "zip"
  source_dir  = "${path.module}/../lambda/observation-writer"
  output_path = "${path.module}/builds/observation-writer.zip"
}

resource "aws_lambda_function" "observation_writer" {
  function_name    = "screeps-observation-writer-${var.environment}"
  filename         = data.archive_file.observation_writer.output_path
  source_code_hash = data.archive_file.observation_writer.output_base64sha256
  role             = aws_iam_role.observation_writer.arn
  handler          = "index.handler"
  runtime          = "nodejs20.x"
  timeout          = 30
  memory_size      = 256

  environment {
    variables = {
      OBSERVATIONS_TABLE = aws_dynamodb_table.observations.name
      RETENTION_DAYS     = "30"
    }
  }
}
