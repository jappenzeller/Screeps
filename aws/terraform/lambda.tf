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
      DYNAMODB_TABLE_SNAPSHOTS  = aws_dynamodb_table.colony_snapshots.name
      DYNAMODB_TABLE_EVENTS     = aws_dynamodb_table.colony_events.name
      SCREEPS_TOKEN_SECRET_ARN  = aws_secretsmanager_secret.screeps_token.arn
      SCREEPS_SHARD             = var.screeps_shard
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
      DYNAMODB_TABLE_SNAPSHOTS      = aws_dynamodb_table.colony_snapshots.name
      DYNAMODB_TABLE_RECOMMENDATIONS = aws_dynamodb_table.recommendations.name
      ANTHROPIC_KEY_SECRET_ARN      = aws_secretsmanager_secret.anthropic_key.arn
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
      DYNAMODB_TABLE_SNAPSHOTS      = aws_dynamodb_table.colony_snapshots.name
      DYNAMODB_TABLE_EVENTS         = aws_dynamodb_table.colony_events.name
      DYNAMODB_TABLE_RECOMMENDATIONS = aws_dynamodb_table.recommendations.name
    }
  }
}
