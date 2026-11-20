@echo off
setlocal
pushd "%~dp0backend-node"
node.exe --env-file=.env src/server.js
set "result=%errorlevel%"
popd
if not "%result%"=="0" pause
exit /b %result%
