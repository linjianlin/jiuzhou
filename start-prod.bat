@echo off
setlocal EnableExtensions
for /f "tokens=2 delims=:" %%a in ('chcp') do set "_OLDCP=%%a"
set "_OLDCP=%_OLDCP: =%"
chcp 65001 >nul
mode con cols=60 lines=28
title 九州修仙录 - 生产模式

echo.
echo   ========================================
echo        九州修仙录 - 生产模式启动器
echo   ========================================
echo.

cd /d %~dp0

echo   [0/5] 设置国内镜像源...
call npm config set registry https://registry.npmmirror.com >nul 2>&1

echo   [1/5] 检查 Rust 后端工具链...
where cargo >nul 2>&1
if errorlevel 1 (
    echo        未检测到 cargo，请先安装 Rust 工具链。
    goto :FAIL
)

echo   [2/5] 检查前端依赖...
pushd client
if not exist node_modules (
    echo        正在安装前端依赖...
    call npm install
    if errorlevel 1 goto :FAIL
)
popd

echo   [3/5] 构建前端项目...
pushd client
echo        设置构建 API / Socket 地址...
set VITE_API_BASE=http://localhost:6011/api
set VITE_SOCKET_URL=http://localhost:6011
call npm run build
if errorlevel 1 (
    echo   X 前端构建失败!
    popd
    goto :FAIL
)
echo        前端构建完成
popd

echo   [4/5] 构建 Rust 后端项目...
pushd server-rs
cargo build --release
if errorlevel 1 (
    echo   X Rust 后端构建失败!
    popd
    goto :FAIL
)
echo        Rust 后端构建完成
popd

echo   [5/5] 启动服务...
echo        启动 Rust 后端 (6011)...
start "" /b /min cmd /c "cd server-rs && set HOST=0.0.0.0 && set PORT=6011 && set NODE_ENV=production && cargo run --release"
timeout /t 2 /nobreak >nul
echo        启动前端 (6010)...
start "" /b /min cmd /c "cd client && npm run preview -- --host 0.0.0.0 --port 6010 --strictPort"
timeout /t 2 /nobreak >nul

echo.
echo   ----------------------------------------
echo     前端: http://localhost:6010  (外网: http://<服务器IP>:6010)
echo     后端: http://localhost:6011  (外网: http://<服务器IP>:6011)
echo   ----------------------------------------
echo.
echo   按任意键停止所有服务并退出...
pause >nul

echo   正在停止服务...
set "_NETSTAT=%SystemRoot%\System32\netstat.exe"
set "_FINDSTR=%SystemRoot%\System32\findstr.exe"
for /f "tokens=5" %%a in ('"%_NETSTAT%" -ano ^| "%_FINDSTR%" :6010 2^>nul') do taskkill /f /pid %%a >nul 2>&1
for /f "tokens=5" %%a in ('"%_NETSTAT%" -ano ^| "%_FINDSTR%" :6011 2^>nul') do taskkill /f /pid %%a >nul 2>&1
echo   已停止!

goto :END

:FAIL
echo.
echo   启动失败，请检查上面的错误输出。
pause

:END
if defined _OLDCP chcp %_OLDCP% >nul 2>&1
endlocal
