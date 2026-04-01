@echo off
cd /d "%~dp0client"
npm run dev -- --host 0.0.0.0
