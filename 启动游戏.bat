@echo off
chcp 65001 > nul
title 伊甸园游戏服务器
color 0A

echo.
echo  ===================================================
echo   🌿 伊甸园团建游戏 — 启动脚本
echo  ===================================================
echo.

:: 检查 Node.js
node --version > nul 2>&1
if %errorlevel% neq 0 (
    color 0C
    echo  ❌ 未检测到 Node.js！
    echo.
    echo  请先安装 Node.js：
    echo  1. 打开浏览器访问：https://nodejs.org
    echo  2. 下载 LTS 版本并安装
    echo  3. 安装完成后重新运行此脚本
    echo.
    pause
    exit /b 1
)

echo  ✅ Node.js 已安装

:: 检查依赖
if not exist "node_modules" (
    echo.
    echo  📦 首次运行，安装依赖包（约1-2分钟）...
    echo.
    npm install
    if %errorlevel% neq 0 (
        color 0C
        echo.
        echo  ❌ 依赖安装失败！请检查网络连接。
        pause
        exit /b 1
    )
    echo.
    echo  ✅ 依赖安装完成
)

echo.
echo  🚀 正在启动服务器...
echo.
echo  启动后请：
echo  1. 将大屏地址复制到投影仪电脑浏览器
echo  2. 将控制端地址在你的电脑打开
echo  3. 让玩家扫描二维码或输入玩家端地址
echo.
echo  按 Ctrl+C 可停止服务器
echo  ===================================================
echo.

node server/index.js

pause
