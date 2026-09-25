@echo off
chcp 65001 >nul
title Mr.Huang Agent 工作台 - 调试

rem 切换到脚本所在目录，保证从任何位置双击都能正确运行
cd /d "%~dp0"

echo ================================================
echo   Mr.Huang Agent 工作台 - 调试模式
echo ================================================
echo.

rem 检查 npm 是否可用
where npm >nul 2>nul
if errorlevel 1 (
    echo [错误] 未检测到 npm，请先安装 Node.js，安装包自带 npm。
    echo 下载地址：https://nodejs.org/zh-cn
    echo 安装完成后，重新双击本脚本即可。
    echo.
    pause
    exit /b 1
)

rem 首次运行时自动安装依赖
if not exist "node_modules" (
    echo [提示] 首次运行：正在安装依赖，可能需要几分钟，请耐心等待……
    call npm install
    if errorlevel 1 (
        echo [错误] 依赖安装失败，请检查网络连接后重试。
        echo.
        pause
        exit /b 1
    )
    echo [提示] 依赖安装完成。
    echo.
)

echo [提示] 正在启动开发服务器，浏览器将自动打开 http://localhost:5173
echo [提示] 如需停止调试服务器，直接关闭本窗口即可。
echo.

rem 将 --open 传给 Vite，启动后自动打开默认浏览器
call npm run dev -- --open

echo.
echo [提示] 开发服务器已停止，窗口可以关闭。
pause
