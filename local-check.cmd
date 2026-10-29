@echo off
rem ZCode claim bot local check (Windows Task Scheduler)
cd /d "%~dp0"
set STATE_FILE=%~dp0state-local.json
"D:\software\nodejs\node.exe" "%~dp0claim.mjs" >> "%~dp0local-check.log" 2>&1
