@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo [1/3] Оновлення з GitHub...
git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=15 fetch origin master 2>nul
if errorlevel 1 (
    echo     Немає зв'язку з GitHub — запускаю локальну версію.
) else (
    git stash -q 2>nul
    git -c advice.mergeConflict=false rebase -q FETCH_HEAD
    if errorlevel 1 (
        echo     Конфлікт злиття — відкочую і запускаю локальну версію.
        git rebase --abort 2>nul
    ) else (
        git stash pop -q 2>nul
    )
)

echo [2/3] Перевірка залежностей...
call npm install --no-audit --no-fund --loglevel=error

echo [3/3] Запуск Reels Generator...
call npm run dev