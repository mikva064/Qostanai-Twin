@echo off
setlocal
cd /d "%~dp0"
if exist ".venv\Scripts\python.exe" goto install
where py >nul 2>nul
if not errorlevel 1 (
  py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3,11) else 1)"
  if errorlevel 1 goto unsupported
  py -3 -m venv .venv
  if errorlevel 1 exit /b 1
  goto install
)
where python >nul 2>nul
if errorlevel 1 (
  echo Python 3.11 or newer is required. Install Python, then run setup.cmd again.
  exit /b 1
)
python -c "import sys; sys.exit(0 if sys.version_info >= (3,11) else 1)"
if errorlevel 1 goto unsupported
python -m venv .venv
if errorlevel 1 exit /b 1
:install
".venv\Scripts\python.exe" -c "import sys; sys.exit(0 if sys.version_info >= (3,11) else 1)"
if errorlevel 1 (
  echo Python 3.11 or newer is required. Create the environment with a supported Python.
  exit /b 1
)
".venv\Scripts\python.exe" -m pip install --cache-dir .venv\pip-cache -r requirements.txt
exit /b %errorlevel%
:unsupported
echo Python 3.11 or newer is required. Select a supported Python and run setup.cmd again.
exit /b 1
