@echo off
title Mr.Huang Agent Desktop

cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
    echo [ERROR] npm not found. Please install Node.js first.
    echo Download: https://nodejs.org/zh-cn
    pause
    exit /b 1
)

set "NODE_OPTIONS="
echo [INFO] NODE_OPTIONS cleared (avoid proxy flags not allowed by Node).

if not exist "node_modules" (
    echo [INFO] node_modules not found. Running npm install...
    call npm install
    if errorlevel 1 (
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
)

echo [INFO] Starting desktop app (Vite + Electron)...
call npm run desktop

pause
