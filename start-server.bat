@echo off
chcp 65001 >nul
title Doi Hinh Bong Da - Server
cd /d "%~dp0"

echo.
echo ================================================================
echo.
echo    DOI HINH BONG DA - KHOI DONG SERVER
echo.
echo ================================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo [LOI] Khong tim thay Node.js tren may nay.
    echo       Vui long tai va cai dat tai: https://nodejs.org
    echo.
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo [*] Lan dau chay - dang cai dat thu vien can thiet ^(express, ws^)...
    echo     Viec nay chi can lam 1 lan, hay doi trong giay lat...
    echo.
    call npm install
    if errorlevel 1 (
        echo.
        echo [LOI] Cai dat thu vien that bai. Kiem tra ket noi mang roi thu lai.
        echo.
        pause
        exit /b 1
    )
    echo.
    echo [+] Cai dat xong!
    echo.
)

echo [*] Dang khoi dong server...
start "Server Doi Hinh Bong Da" cmd /k "node server.js"

echo [*] Doi server khoi dong...
timeout /t 3 /nobreak >nul

echo [*] Dang mo trinh duyet...
start "" "http://localhost:3000/lineup.html"

echo.
echo ================================================================
echo   [+] Da khoi dong xong!
echo   [+] Trinh duyet da mo: http://localhost:3000/lineup.html
echo   [+] Cac may khac trong CUNG mang LAN/WiFi: xem dia chi
echo       "LAN: http://..." trong cua so Server vua mo ra.
echo   [+] Dong cua so "Server Doi Hinh Bong Da" ^(hoac nhan Ctrl+C
echo       trong do^) de tat server.
echo ================================================================
echo.
pause
