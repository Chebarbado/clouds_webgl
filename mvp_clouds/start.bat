@echo off
rem Локальный сервер (ES-модули не грузятся по file://)
cd /d "%~dp0"
start "" http://localhost:8080/
python -m http.server 8080
