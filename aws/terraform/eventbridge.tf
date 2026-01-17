# Schedule for data collection (every 5 minutes)
resource "aws_cloudwatch_event_rule" "collect_data" {
  name                = "screeps-collect-data-${var.environment}"
  description         = "Collect Screeps colony data every 5 minutes"
  schedule_expression = "rate(5 minutes)"
}

resource "aws_cloudwatch_event_target" "collect_data" {
  rule      = aws_cloudwatch_event_rule.collect_data.name
  target_id = "data-collector"
  arn       = aws_lambda_function.data_collector.arn
}

resource "aws_lambda_permission" "collect_data" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.data_collector.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.collect_data.arn
}

# Schedule for analysis (every hour)
resource "aws_cloudwatch_event_rule" "run_analysis" {
  name                = "screeps-run-analysis-${var.environment}"
  description         = "Run Screeps AI analysis every hour"
  schedule_expression = "rate(1 hour)"
}

resource "aws_cloudwatch_event_target" "run_analysis" {
  rule      = aws_cloudwatch_event_rule.run_analysis.name
  target_id = "analysis-engine"
  arn       = aws_lambda_function.analysis_engine.arn
}

resource "aws_lambda_permission" "run_analysis" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.analysis_engine.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.run_analysis.arn
}
