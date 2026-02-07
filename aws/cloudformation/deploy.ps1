# Screeps AI Advisor - CloudFormation Deployment Script
# Run with: powershell -ExecutionPolicy Bypass -File deploy.ps1

param(
    [string]$Region = "us-east-1",
    [string]$Profile = "screeps-monitor",
    [string]$Environment = "prod",
    [string]$ScreepsToken = "",
    [string]$AnthropicKey = ""
)

$ErrorActionPreference = "Stop"
$ProjectName = "screeps-advisor"
$StackName = "$ProjectName-$Environment"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Screeps AI Advisor Deployment" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Region: $Region"
Write-Host "Profile: $Profile"
Write-Host "Environment: $Environment"
Write-Host ""

# Get AWS account ID
Write-Host "Getting AWS account ID..." -ForegroundColor Yellow
$AccountId = aws sts get-caller-identity --query Account --output text --profile $Profile --region $Region
if (-not $AccountId) {
    Write-Host "ERROR: Could not get AWS account ID. Check your credentials." -ForegroundColor Red
    exit 1
}
Write-Host "Account ID: $AccountId" -ForegroundColor Green

$BucketName = "$ProjectName-lambda-code-$AccountId"

# Step 1: Create S3 bucket for Lambda code (if it doesn't exist)
Write-Host ""
Write-Host "Step 1: Creating S3 bucket for Lambda code..." -ForegroundColor Yellow
$ErrorActionPreference = "SilentlyContinue"
$null = aws s3api head-bucket --bucket $BucketName --profile $Profile --region $Region 2>&1
$bucketMissing = $LASTEXITCODE -ne 0
$ErrorActionPreference = "Stop"
if ($bucketMissing) {
    Write-Host "Creating bucket: $BucketName"
    if ($Region -eq "us-east-1") {
        aws s3api create-bucket --bucket $BucketName --profile $Profile --region $Region
    } else {
        aws s3api create-bucket --bucket $BucketName --profile $Profile --region $Region --create-bucket-configuration LocationConstraint=$Region
    }

    # Block public access
    aws s3api put-public-access-block --bucket $BucketName --profile $Profile --region $Region `
        --public-access-block-configuration "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
} else {
    Write-Host "Bucket already exists: $BucketName" -ForegroundColor Green
}

# Step 2: Install dependencies and package Lambda functions
Write-Host ""
Write-Host "Step 2: Installing dependencies and packaging Lambda functions..." -ForegroundColor Yellow

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$LambdaDir = Join-Path (Split-Path -Parent $ScriptDir) "lambda"
$BuildDir = Join-Path $ScriptDir "builds"

# Create builds directory
if (-not (Test-Path $BuildDir)) {
    New-Item -ItemType Directory -Path $BuildDir | Out-Null
}

$functions = @(
    "data-collector",
    "analysis-engine",
    "api",
    "stream-processor",
    "metrics-writer",
    "context-builder",
    "claude-analyzer",
    "recommendation-writer",
    "outcome-evaluator",
    "cleanup-recommendations",
    "room-recorder",
    "recording-analyzer"
)

foreach ($func in $functions) {
    $funcDir = Join-Path $LambdaDir $func
    $zipFile = Join-Path $BuildDir "$func.zip"

    Write-Host "  Packaging $func..."

    if (-not (Test-Path $funcDir)) {
        Write-Host "  WARNING: Directory not found: $funcDir - skipping" -ForegroundColor Yellow
        continue
    }

    # Install npm dependencies if package.json exists
    $packageJson = Join-Path $funcDir "package.json"
    if (Test-Path $packageJson) {
        $nodeModules = Join-Path $funcDir "node_modules"
        if (-not (Test-Path $nodeModules)) {
            Write-Host "    Installing npm dependencies..."
            Push-Location $funcDir
            $null = npm install --omit=dev 2>&1
            Pop-Location
        }
    }

    # Remove old zip if exists
    if (Test-Path $zipFile) {
        Remove-Item $zipFile -Force
    }

    # Create zip (using PowerShell's Compress-Archive)
    Push-Location $funcDir
    Compress-Archive -Path .\* -DestinationPath $zipFile -Force
    Pop-Location

    Write-Host "  Created: $zipFile" -ForegroundColor Green
}

# Step 3: Upload Lambda packages to S3
Write-Host ""
Write-Host "Step 3: Uploading Lambda packages to S3..." -ForegroundColor Yellow

foreach ($func in $functions) {
    $zipFile = Join-Path $BuildDir "$func.zip"
    Write-Host "  Uploading $func.zip..."
    aws s3 cp $zipFile "s3://$BucketName/$func.zip" --profile $Profile --region $Region
}
Write-Host "Upload complete!" -ForegroundColor Green

# Step 4: Deploy CloudFormation stack
Write-Host ""
Write-Host "Step 4: Deploying CloudFormation stack..." -ForegroundColor Yellow

$templateFile = Join-Path $ScriptDir "template.yaml"

# Upload template to S3 (required for large templates > 51200 bytes)
Write-Host "  Uploading template to S3..."
aws s3 cp $templateFile "s3://$BucketName/template.yaml" --profile $Profile --region $Region
$templateUrl = "https://$BucketName.s3.$Region.amazonaws.com/template.yaml"

# Check if stack exists
$ErrorActionPreference = "SilentlyContinue"
$null = aws cloudformation describe-stacks --stack-name $StackName --profile $Profile --region $Region 2>&1
$stackExists = $LASTEXITCODE -eq 0
$ErrorActionPreference = "Stop"

if ($stackExists) {
    Write-Host "Updating existing stack: $StackName"
    aws cloudformation update-stack `
        --stack-name $StackName `
        --template-url $templateUrl `
        --parameters "ParameterKey=Environment,ParameterValue=$Environment" "ParameterKey=LambdaCodeBucket,ParameterValue=$BucketName" `
        --capabilities CAPABILITY_NAMED_IAM `
        --profile $Profile `
        --region $Region

    if ($LASTEXITCODE -eq 0) {
        Write-Host "Waiting for stack update to complete..."
        aws cloudformation wait stack-update-complete --stack-name $StackName --profile $Profile --region $Region
    }
} else {
    Write-Host "Creating new stack: $StackName"
    aws cloudformation create-stack `
        --stack-name $StackName `
        --template-url $templateUrl `
        --parameters "ParameterKey=Environment,ParameterValue=$Environment" "ParameterKey=LambdaCodeBucket,ParameterValue=$BucketName" `
        --capabilities CAPABILITY_NAMED_IAM `
        --profile $Profile `
        --region $Region

    Write-Host "Waiting for stack creation to complete (this may take 5-10 minutes)..."
    aws cloudformation wait stack-create-complete --stack-name $StackName --profile $Profile --region $Region
}

if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Stack deployment failed!" -ForegroundColor Red
    Write-Host "Check the CloudFormation console for details." -ForegroundColor Red
    exit 1
}

Write-Host "Stack deployed successfully!" -ForegroundColor Green

# Step 5: Update Lambda function code (point to S3)
Write-Host ""
Write-Host "Step 5: Updating Lambda function code..." -ForegroundColor Yellow

foreach ($func in $functions) {
    $funcName = "screeps-$func-$Environment"
    Write-Host "  Updating $funcName..."
    aws lambda update-function-code `
        --function-name $funcName `
        --s3-bucket $BucketName `
        --s3-key "$func.zip" `
        --profile $Profile `
        --region $Region | Out-Null
}
Write-Host "Lambda functions updated!" -ForegroundColor Green

# Step 6: Set secrets (if provided)
Write-Host ""
Write-Host "Step 6: Configuring secrets..." -ForegroundColor Yellow

if ($ScreepsToken) {
    Write-Host "  Setting Screeps API token..."
    aws secretsmanager put-secret-value `
        --secret-id "screeps/api-token" `
        --secret-string $ScreepsToken `
        --profile $Profile `
        --region $Region
    Write-Host "  Screeps token set!" -ForegroundColor Green
} else {
    Write-Host "  Screeps token not provided. Set it later with:" -ForegroundColor Yellow
    Write-Host "    aws secretsmanager put-secret-value --secret-id screeps/api-token --secret-string YOUR_TOKEN" -ForegroundColor Gray
}

if ($AnthropicKey) {
    Write-Host "  Setting Anthropic API key..."
    aws secretsmanager put-secret-value `
        --secret-id "screeps/anthropic-api-key" `
        --secret-string $AnthropicKey `
        --profile $Profile `
        --region $Region
    Write-Host "  Anthropic key set!" -ForegroundColor Green
} else {
    Write-Host "  Anthropic key not provided. Set it later with:" -ForegroundColor Yellow
    Write-Host "    aws secretsmanager put-secret-value --secret-id screeps/anthropic-api-key --secret-string YOUR_KEY" -ForegroundColor Gray
}

# Step 7: Get outputs
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Deployment Complete!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

$apiEndpoint = aws cloudformation describe-stacks `
    --stack-name $StackName `
    --query "Stacks[0].Outputs[?OutputKey=='ApiEndpoint'].OutputValue" `
    --output text `
    --profile $Profile `
    --region $Region

Write-Host "API Endpoint: $apiEndpoint" -ForegroundColor Green
Write-Host ""
Write-Host "Available Routes:" -ForegroundColor Cyan
Write-Host "  GET  $apiEndpoint/summary/{roomName}"
Write-Host "  GET  $apiEndpoint/recommendations/{roomName}"
Write-Host "  GET  $apiEndpoint/metrics/{roomName}"
Write-Host "  POST $apiEndpoint/feedback/{recommendationId}"
Write-Host "  GET  $apiEndpoint/live                       (real-time segment 90)"
Write-Host "  GET  $apiEndpoint/live/{roomName}            (real-time for room)"
Write-Host "  GET  $apiEndpoint/room/{roomName}            (room objects + terrain)"
Write-Host ""
Write-Host "Event-Driven Architecture:" -ForegroundColor Cyan
Write-Host "  - DynamoDB Streams -> Stream Processor -> EventBridge"
Write-Host "  - EventBridge -> Metrics Writer -> TimeStream"
Write-Host "  - EventBridge -> Step Functions Analysis Workflow"
Write-Host "  - Outcome Evaluator -> Knowledge Table (learning loop)"
Write-Host "  - Firehose -> S3 Archive (historical analysis)"
Write-Host ""
Write-Host "Example:" -ForegroundColor Yellow
Write-Host "  curl `"$apiEndpoint/summary/E48N36`""
Write-Host ""

if (-not $ScreepsToken -or -not $AnthropicKey) {
    Write-Host "IMPORTANT: Don't forget to set your secrets!" -ForegroundColor Red
    Write-Host "The data collector and analysis engine won't work until secrets are configured."
}
