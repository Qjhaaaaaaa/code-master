@echo off
setlocal

cd /d "%~dp0"
set PORT=%WEB_UI_PORT:3000%

echo.
echo   Starting Claude Code Web UI...
echo   Port: %PORT%
echo.

start http://localhost:%PORT%
bun run server.ts
