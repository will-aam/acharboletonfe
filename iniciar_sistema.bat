@echo off
chcp 65001 > nul
title Localizador de Boletos x NF-e
echo ======================================================
echo    LOCALIZADOR INTELIGENTE DE BOLETOS x XML DE NF-e
echo ======================================================
echo.
echo Iniciando o sistema no seu navegador...
echo.

where node >nul 2>nul
if %errorlevel% equ 0 (
    echo [OK] Node.js detectado! Iniciando servidor local...
    node server.js
) else (
    echo [OK] Abrindo diretamente no navegador padrao...
    start "" "%~dp0index.html"
)

