@echo off
set AWS_CONFIG_FILE=%~dp0.aws\config
set AWS_SHARED_CREDENTIALS_FILE=%~dp0.aws\credentials
set AWS_PROFILE=screeps-monitor
echo AWS environment set to use project-local config with screeps-monitor profile
