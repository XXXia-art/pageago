@echo off
setlocal
set "PAGEAGO_HTML=%~dp0prototypes\trace-next\dist\index.html"
if not exist "%PAGEAGO_HTML%" (
  echo PageAgo page not found: "%PAGEAGO_HTML%"
  echo Run python prototypes\trace-next\build.py to build the preview.
  pause
  exit /b 1
)
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
  start "" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" "%PAGEAGO_HTML%"
  exit /b 0
)
if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" (
  start "" "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" "%PAGEAGO_HTML%"
  exit /b 0
)
if exist "%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe" (
  start "" "%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe" "%PAGEAGO_HTML%"
  exit /b 0
)
start "" "%PAGEAGO_HTML%"
