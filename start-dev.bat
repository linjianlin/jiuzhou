@echo off
mode con cols=60 lines=24
title ��������¼ - ����ģʽ

echo.
echo   ========================================
echo        ��������¼ - ����ģʽ������
echo   ========================================
echo.

cd /d %~dp0

echo   [0/3] ���ù��ھ���Դ...
call npm config set registry https://registry.npmmirror.com >nul 2>&1

echo   [1/3] 检查 Rust 后端工具链...
where cargo >nul 2>&1
if errorlevel 1 (
    echo        未检测到 cargo，请先安装 Rust 工具链。
    goto :FAIL
)

echo   [2/3] ���ǰ������...
cd client
if not exist node_modules (
    echo        ���ڰ�װǰ������...
    call npm install >nul 2>&1
)
cd ..

echo   [3/3] ��������...
echo        启动 Rust 后端 (6011)...
start /b /min cmd /c "cd server-rs && set HOST=0.0.0.0 && set PORT=6011 && cargo run --bin server-rs"
timeout /t 2 /nobreak >nul
echo        ����ǰ�� (6010)...
start /b /min cmd /c "cd client && npm run dev -- --port 6010"
timeout /t 3 /nobreak >nul

echo.
echo   ----------------------------------------
echo     ǰ��: http://localhost:6010
echo     ���: http://localhost:6011
echo   ----------------------------------------
echo.
echo   按任意键停止所有服务并退出...
pause >nul

echo   正在停止服务...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :6010 2^>nul') do taskkill /f /pid %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :6011 2^>nul') do taskkill /f /pid %%a >nul 2>&1
echo   已停止!

:FAIL
