@echo off
setlocal
set "ROOT=%~dp0.."
if not exist "%ROOT%\dist\cli.js" (
  echo Envidence is not built. Run: npm run build
  exit /b 1
)
node "%ROOT%\dist\cli.js" %*
