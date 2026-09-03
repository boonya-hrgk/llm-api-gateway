@echo off
rem ============================================================
rem  LLM API Gateway  -  offline dependency installer
rem  Run this on the TARGET (intranet, no-internet) machine.
rem  Prereq: Python 3.11 x64 already installed (Add to PATH).
rem ============================================================
chcp 65001 >nul
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
    echo [ERROR] python not found in PATH.
    echo Please install Python 3.11 x64 first and check "Add python.exe to PATH".
    pause
    exit /b 1
)

python -m pip install --no-index --find-links="%~dp0wheels-win311" -r requirements.txt
if errorlevel 1 (
    echo.
    echo [ERROR] install failed. Check that "wheels-win311" folder sits next to this bat.
    pause
    exit /b 1
)

echo.
echo [OK] All dependencies installed from local wheels. No internet needed.
pause
