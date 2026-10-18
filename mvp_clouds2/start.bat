@echo off
rem Локальный сервер mvp_clouds2 (ES-модули не грузятся по file://).
rem Порт 8081, чтобы mvp_clouds (8080) и mvp_clouds2 открывались одновременно.
cd /d "%~dp0"
start "" http://localhost:8081/
python -m http.server 8081
