@echo off
setlocal
chcp 65001 >nul
set PYTHONUTF8=1
cd /d "%~dp0"
if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" -m scripts.runtime_check check
  goto finish
)
where py >nul 2>nul
if not errorlevel 1 (
  py -3 -m scripts.runtime_check check
  goto finish
)
where python >nul 2>nul
if not errorlevel 1 (
  python -m scripts.runtime_check check
  goto finish
)
echo Python 3.11 or newer is required. Install Python and run setup.cmd.
if /I not "%~1"=="--no-pause" pause
exit /b 1
:finish
set CHECK_RESULT=%errorlevel%
if /I not "%~1"=="--no-pause" pause
exit /b %CHECK_RESULT%
