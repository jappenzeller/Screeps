@echo off
set AWS_CONFIG_FILE=%~dp0.aws\config
set AWS_SHARED_CREDENTIALS_FILE=%~dp0.aws\credentials
set AWS_PROFILE=your-profile-name
echo AWS environment set for this project
echo Profile: %AWS_PROFILE%