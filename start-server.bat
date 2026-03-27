@echo off
cd /d "%~dp0"
echo Starting CardLedger server...
node .\server\index.js
pause
