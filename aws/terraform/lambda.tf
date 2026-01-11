# CloudWatch Log Groups
resource "aws_cloudwatch_log_group" "data_collector" {
  name              = "/aws/lambda/${var.project_name}-data-collector"
  retention_in_days = 14

  tags = {
    Project     = var.project_name
    Environment = var.environment
  }
}

resource "aws_cloudwatch_log_group" "analysis_engine" {
  name              = "/aws/lambda/${var.project_name}-analysis-engine"
  retention_in_days = 14

  tags = {
    Project     = var.project_name
    Environment = var.environment
  }
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/lambda/${var.project_name}-api"
  retention_in_days = 14

  tags = {
    Project     = var.project_name
    Environment = var.environment
  }
}

# Data Collector Lambda - pulls stats from Screeps API
resource "aws_lambda_function" "data_collector" {
  filename         = "../lambda-advisor/data-collector.zip"
  function_name    = "${var.project_name}-data-collector"
  role             = aws_iam_role.data_collector.arn
  handler          = "index.handler"
  source_code_hash = filebase64sha256("../lambda-advisor/data-collector.zip")
  runtime          = "nodejs20.x"
  timeout          = 30
  memory_size      = 256

  environment {
    variables = {
      SCREEPS_TOKEN_SECRET  = var.screeps_token_secret_name
      SNAPSHOTS_TABLE       = aws_dynamodb_table.colony_snapshots.name
      EVENTS_TABLE          = aws_dynamodb_table.colony_events.name
      SNAPSHOT_RETENTION_DAYS = var.snapshot_retention_days
      EVENT_RETENTION_DAYS  = var.event_retention_days
    }
  }

  depends_on = [aws_cloudwatch_log_group.data_collector]

  tags = {
    Project     = var.project_name
    Environment = var.environment
  }
}

# Analysis Engine Lambda - runs pattern detection and AI recommendations
resource "aws_lambda_function" "analysis_engine" {
  filename         = "../lambda-advisor/analysis-engine.zip"
  function_name    = "${var.project_name}-analysis-engine"
  role             = aws_iam_role.analysis_engine.arn
  handler          = "index.handler"
  source_code_hash = filebase64sha256("../lambda-advisor/analysis-engine.zip")
  runtime          = "nodejs20.x"
  timeout          = 120
  memory_size      = 512

  environment {
    variables = {
      ANTHROPIC_KEY_SECRET  = var.anthropic_api_key_secret_name
      SNAPSHOTS_TABLE       = aws_dynamodb_table.colony_snapshots.name
      EVENTS_TABLE          = aws_dynamodb_table.colony_events.name
      RECOMMENDATIONS_TABLE = aws_dynamodb_table.recommendations.name
      PATTERN_STATE_TABLE   = aws_dynamodb_table.pattern_state.name
    }
  }

  depends_on = [aws_cloudwatch_log_group.analysis_engine]

  tags = {
    Project     = var.project_name
    Environment = var.environment
  }
}

# API Lambda - serves dashboard and feedback endpoints
resource "aws_lambda_function" "api" {
  filename         = "../lambda-advisor/api.zip"
  function_name    = "${var.project_name}-api"
  role             = aws_iam_role.api.arn
  handler          = "index.handler"
  source_code_hash = filebase64sha256("../lambda-advisor/api.zip")
  runtime          = "nodejs20.x"
  timeout          = 30
  memory_size      = 256

  environment {
    variables = {
      SNAPSHOTS_TABLE       = aws_dynamodb_table.colony_snapshots.name
      EVENTS_TABLE          = aws_dynamodb_table.colony_events.name
      RECOMMENDATIONS_TABLE = aws_dynamodb_table.recommendations.name
    }
  }

  depends_on = [aws_cloudwatch_log_group.api]

  tags = {
    Project     = var.project_name
    Environment = var.environment
  }
}

# EventBridge rule - run data collector every 5 minutes
resource "aws_cloudwatch_event_rule" "data_collector_schedule" {
  name                = "${var.project_name}-collect-data"
  description         = "Collect Screeps colony data every 5 minutes"
  schedule_expression = "rate(5 minutes)"

  tags = {
    Project     = var.project_name
    Environment = var.environment
  }
}

resource "aws_cloudwatch_event_target" "data_collector" {
  rule      = aws_cloudwatch_event_rule.data_collector_schedule.name
  target_id = "DataCollector"
  arn       = aws_lambda_function.data_collector.arn
}

resource "aws_lambda_permission" "data_collector_eventbridge" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.data_collector.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.data_collector_schedule.arn
}

# EventBridge rule - run analysis every hour
resource "aws_cloudwatch_event_rule" "analysis_schedule" {
  name                = "${var.project_name}-run-analysis"
  description         = "Run AI analysis every hour"
  schedule_expression = "rate(1 hour)"

  tags = {
    Project     = var.project_name
    Environment = var.environment
  }
}

resource "aws_cloudwatch_event_target" "analysis_engine" {
  rule      = aws_cloudwatch_event_rule.analysis_schedule.name
  target_id = "AnalysisEngine"
  arn       = aws_lambda_function.analysis_engine.arn
}

resource "aws_lambda_permission" "analysis_engine_eventbridge" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.analysis_engine.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.analysis_schedule.arn
}
