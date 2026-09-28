@echo off
REM === Check if litellm is already running on port 4000 ===
netstat -ano | findstr ":4000" | findstr "LISTENING" >nul 2>&1
if %errorlevel% equ 0 goto :launch

REM === Start litellm in its own minimized window (stays alive independently) ===
start /min "litellm-proxy" "E:\Python310\Scripts\litellm.exe" --config "E:\CC\litellm_config.yaml" --port 4000

REM === Wait for port 4000 to be ready (max 30 seconds) ===
set /a count=0
:waitloop
if %count% geq 30 goto :launch
netstat -ano | findstr ":4000" | findstr "LISTENING" >nul 2>&1
if %errorlevel% equ 0 goto :launch
timeout /t 1 /nobreak >nul
set /a count+=1
goto :waitloop

:launch
REM === Launch Electron (separate window) ===
cd /d E:\CC\desktop
start "" npx electron .
