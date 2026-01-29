resource "aws_apigatewayv2_api" "main" {
  name          = "screeps-ai-advisor-${var.environment}"
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins = ["*"]
    allow_methods = ["GET", "POST", "OPTIONS"]
    allow_headers = ["Content-Type"]
  }
}

resource "aws_apigatewayv2_stage" "main" {
  api_id      = aws_apigatewayv2_api.main.id
  name        = "$default"
  auto_deploy = true
}

resource "aws_apigatewayv2_integration" "api" {
  api_id             = aws_apigatewayv2_api.main.id
  integration_type   = "AWS_PROXY"
  integration_method = "POST"
  integration_uri    = aws_lambda_function.api.invoke_arn
}

# Routes
resource "aws_apigatewayv2_route" "get_summary" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "GET /summary/{roomName}"
  target    = "integrations/${aws_apigatewayv2_integration.api.id}"
}

resource "aws_apigatewayv2_route" "get_recommendations" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "GET /recommendations/{roomName}"
  target    = "integrations/${aws_apigatewayv2_integration.api.id}"
}

resource "aws_apigatewayv2_route" "get_metrics" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "GET /metrics/{roomName}"
  target    = "integrations/${aws_apigatewayv2_integration.api.id}"
}

resource "aws_apigatewayv2_route" "post_feedback" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "POST /feedback/{recommendationId}"
  target    = "integrations/${aws_apigatewayv2_integration.api.id}"
}

resource "aws_apigatewayv2_route" "get_diagnostics" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "GET /diagnostics/{roomName}"
  target    = "integrations/${aws_apigatewayv2_integration.api.id}"
}

resource "aws_apigatewayv2_route" "get_live_room" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "GET /live/{roomName}"
  target    = "integrations/${aws_apigatewayv2_integration.api.id}"
}

resource "aws_apigatewayv2_route" "get_live_all" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "GET /live"
  target    = "integrations/${aws_apigatewayv2_integration.api.id}"
}

resource "aws_apigatewayv2_route" "get_room_data" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "GET /room/{roomName}"
  target    = "integrations/${aws_apigatewayv2_integration.api.id}"
}

# Signal layer routes
resource "aws_apigatewayv2_route" "get_signals" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "GET /signals/{roomName}"
  target    = "integrations/${aws_apigatewayv2_integration.api.id}"
}

resource "aws_apigatewayv2_route" "get_signal_events" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "GET /signals/{roomName}/events"
  target    = "integrations/${aws_apigatewayv2_integration.api.id}"
}

# Observation layer routes
resource "aws_apigatewayv2_route" "get_observations" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "GET /observations/{roomName}"
  target    = "integrations/${aws_apigatewayv2_integration.api.id}"
}

resource "aws_apigatewayv2_route" "get_patterns" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "GET /observations/{roomName}/patterns"
  target    = "integrations/${aws_apigatewayv2_integration.api.id}"
}

resource "aws_apigatewayv2_route" "search_observations" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "GET /observations/{roomName}/search"
  target    = "integrations/${aws_apigatewayv2_integration.api.id}"
}

resource "aws_lambda_permission" "api_gateway" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*"
}

output "api_endpoint" {
  value = aws_apigatewayv2_api.main.api_endpoint
}
