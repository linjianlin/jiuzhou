@echo off
setlocal

rem Windows Docker build entry. Keep build logic in docker-build.ps1.
rem Pass all arguments through unchanged.

chcp 65001 > nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0docker-build.ps1" %*
exit /b %ERRORLEVEL%
