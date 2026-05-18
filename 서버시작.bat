@echo off
chcp 65001 >nul
cls
echo.
echo ╔════════════════════════════════════════════════════════╗
echo ║   교촌에프앤비 상권분석 프록시 서버                      ║
echo ║   http://localhost:3000                                 ║
echo ╚════════════════════════════════════════════════════════╝
echo.
echo   서버를 시작합니다. 이 창을 닫지 마세요.
echo   브라우저에서 index.html을 열어주세요.
echo.
echo   종료하려면: Ctrl+C 또는 이 창 닫기
echo.
echo ────────────────────────────────────────────────────────
echo.

node server.js

pause
