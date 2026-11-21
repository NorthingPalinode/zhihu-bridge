@echo off
rem Zhihu Bridge launcher for Windows cmd. Usage: start.bat [--smoke] [--port 9000] [--offline]
rem All logic lives in start.py (binds 127.0.0.1 only).
setlocal
cd /d "%~dp0"
where py >nul 2>nul
if %ERRORLEVEL%==0 (
  py -3 "%~dp0start.py" %*
) else (
  python "%~dp0start.py" %*
)
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" pause
exit /b %RC%
