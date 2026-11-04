@echo off
title DiscordIA - servidor (deixe aberta; fechar = desligar)
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -LiteralPath '%~dp0' -Recurse -File -Include *.ps1,*.bat,*.mjs -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch '\\node_modules\\|\\dist\\' } | Unblock-File" >nul 2>nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\discordia.ps1"
if errorlevel 1 (
  echo.
  echo Algo deu errado. Leia a mensagem acima.
  pause
)
