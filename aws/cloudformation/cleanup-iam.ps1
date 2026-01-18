$roles = @('screeps-advisor-api-role', 'screeps-advisor-data-collector-role', 'screeps-advisor-analysis-engine-role')
foreach ($role in $roles) {
    Write-Host "Processing $role..."
    # Delete inline policies
    $policies = aws iam list-role-policies --role-name $role --profile screeps-monitor --region us-east-1 2>&1 | ConvertFrom-Json
    if ($policies.PolicyNames) {
        foreach ($policy in $policies.PolicyNames) {
            Write-Host "  Deleting inline policy: $policy"
            aws iam delete-role-policy --role-name $role --policy-name $policy --profile screeps-monitor --region us-east-1
        }
    }
    # Detach managed policies
    $attached = aws iam list-attached-role-policies --role-name $role --profile screeps-monitor --region us-east-1 2>&1 | ConvertFrom-Json
    if ($attached.AttachedPolicies) {
        foreach ($policy in $attached.AttachedPolicies) {
            Write-Host "  Detaching managed policy: $($policy.PolicyArn)"
            aws iam detach-role-policy --role-name $role --policy-arn $policy.PolicyArn --profile screeps-monitor --region us-east-1
        }
    }
    # Delete the role
    Write-Host "  Deleting role..."
    aws iam delete-role --role-name $role --profile screeps-monitor --region us-east-1 2>&1
}
Write-Host "Done cleaning IAM roles."
