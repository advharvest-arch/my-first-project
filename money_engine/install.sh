#!/bin/bash
# Money Engine — установка под ключ (одна команда)
set -euo pipefail
cd "$(dirname "$0")"

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║     💰 Money Engine — Установка под ключ        ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

# Python
if ! command -v python3 &>/dev/null; then
  echo "❌ Python 3 не найден. Установите: apt install python3 python3-pip"
  exit 1
fi

echo "→ Установка зависимостей..."
python3 -m pip install -r requirements.txt --user -q 2>/dev/null || pip3 install -r requirements.txt -q

echo "→ Настройка окружения..."
[ -f .env ] || cp .env.example .env

FLEET_SIZE="${1:-50}"
echo "→ Запуск turnkey (флот: ${FLEET_SIZE} проектов)..."
python3 main.py turnkey --count "$FLEET_SIZE"

echo ""
echo "✅ Установка завершена!"
echo ""
echo "   Запуск:    ./start.sh"
echo "   Дашборд:   http://localhost:8000"
echo ""
