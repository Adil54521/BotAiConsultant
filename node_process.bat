@echo off
cd /d "%~dp0"

start "" /b cmd /c node index.js >> server.log 2>&1