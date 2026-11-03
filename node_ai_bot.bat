@echo off
cd /d "%~dp0"

call .\myvenv\Scripts\activate.bat
python main.py

pause