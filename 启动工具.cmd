@echo off
setlocal
chcp 65001 >nul
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
cd /d "%~dp0"
if errorlevel 1 goto folder_error
py -3 --version >nul 2>&1
if not errorlevel 1 goto run_py
python -c "import sys; sys.exit(sys.version_info.major != 3)" >nul 2>&1
if not errorlevel 1 goto run_python
echo Python 3 was not found. Please install Python 3 and try again.
pause
exit /b 1
:run_py
py -3 -B server.py %*
goto finished
:run_python
python -B server.py %*
goto finished
:folder_error
echo Cannot open the tool directory.
pause
exit /b 1
:finished
set "COURSE_EXIT_CODE=%errorlevel%"
echo.
echo Server stopped.
pause
exit /b %COURSE_EXIT_CODE%
