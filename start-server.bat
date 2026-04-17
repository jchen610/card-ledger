@echo off
cd /d "%~dp0"
echo Starting CardLedger server...
:loop
node .\server\index.js
echo.
echo Server exited. Restarting in 2 seconds... (Ctrl+C to abort)
timeout /t 2 >nul
goto loop
