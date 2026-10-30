@echo off
cd /d "%~dp0"
:loop
node main.mjs >> _server_run.log 2>&1
echo [wrapper] node exited %ERRORLEVEL% at %DATE% %TIME% >> _server_run.log
timeout /t 3 /nobreak >nul
goto loop
