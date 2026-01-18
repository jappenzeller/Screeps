# AWS Project Configuration Template

This template sets up project-local AWS configuration that works with AWS CLI, SDKs, and Amazon Q.

## Setup Instructions

### 1. Create Project-Local AWS Config

Create `.aws/config` in your project root:

```ini
[default]
region = us-east-1
output = json

[sso-session {PROJECT_NAME}]
sso_start_url = {SSO_START_URL}
sso_region = us-east-1
sso_registration_scopes = sso:account:access

[profile {PROJECT_NAME}]
sso_session = {PROJECT_NAME}
sso_account_id = {AWS_ACCOUNT_ID}
sso_role_name = {SSO_ROLE_NAME}
region = us-east-1
```

### 2. Create Environment File

Create `.env` in your project root:

```
AWS_PROFILE={PROJECT_NAME}
AWS_CONFIG_FILE={PROJECT_PATH}\.aws\config
```

### 3. Configure VS Code PowerShell Profile

Add to `C:\Users\{USERNAME}\Documents\WindowsPowerShell\Microsoft.VSCode_profile.ps1`:

```powershell
# Auto-load AWS config for {PROJECT_NAME} project
if ($PWD.Path -like "*\{PROJECT_NAME}*") {
    $env:AWS_CONFIG_FILE = "{PROJECT_PATH}\.aws\config"
    $env:AWS_PROFILE = "{PROJECT_NAME}"
}
```

### 4. Login to AWS SSO

```bash
aws sso login --profile {PROJECT_NAME}
```

## Parameters to Replace

- `{PROJECT_NAME}` - Your project folder name (e.g., `policy`, `my-app`)
- `{SSO_START_URL}` - Your AWS SSO portal URL (e.g., `https://d-xxxxxxxxxx.awsapps.com/start`)
- `{AWS_ACCOUNT_ID}` - Your AWS account ID (12-digit number)
- `{SSO_ROLE_NAME}` - SSO role name (e.g., `AdministratorAccess`, `PowerUserAccess`)
- `{PROJECT_PATH}` - Full path to project (e.g., `h:\Policy`, `C:\Projects\my-app`)
- `{USERNAME}` - Your Windows username

## Example

For a project named `policy` at `h:\Policy`:

**.aws/config:**
```ini
[sso-session policy]
sso_start_url = https://d-9066183ff8.awsapps.com/start
sso_region = us-east-1
sso_registration_scopes = sso:account:access

[profile policy]
sso_session = policy
sso_account_id = 488218643044
sso_role_name = AdministratorAccess
region = us-east-1
```

**.env:**
```
AWS_PROFILE=policy
AWS_CONFIG_FILE=h:\Policy\.aws\config
```

**PowerShell Profile:**
```powershell
if ($PWD.Path -like "*\policy*") {
    $env:AWS_CONFIG_FILE = "h:\Policy\.aws\config"
    $env:AWS_PROFILE = "policy"
}
```

## Verification

Test your configuration:

```bash
aws sts get-caller-identity --profile {PROJECT_NAME}
```

Should return your AWS account and user information.
