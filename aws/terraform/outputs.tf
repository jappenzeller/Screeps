output "api_endpoint" {
  description = "API Gateway endpoint URL"
  value       = aws_apigatewayv2_api.advisor.api_endpoint
}

output "snapshots_table_name" {
  description = "DynamoDB snapshots table name"
  value       = aws_dynamodb_table.colony_snapshots.name
}

output "events_table_name" {
  description = "DynamoDB events table name"
  value       = aws_dynamodb_table.colony_events.name
}

output "recommendations_table_name" {
  description = "DynamoDB recommendations table name"
  value       = aws_dynamodb_table.recommendations.name
}

output "data_collector_function_name" {
  description = "Data collector Lambda function name"
  value       = aws_lambda_function.data_collector.function_name
}

output "analysis_engine_function_name" {
  description = "Analysis engine Lambda function name"
  value       = aws_lambda_function.analysis_engine.function_name
}
