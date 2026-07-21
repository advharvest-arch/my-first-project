#!/bin/bash
# Money Engine — одна кнопка: установка + запуск
set -euo pipefail
cd "$(dirname "$0")"

FLEET_SIZE="${1:-50}"
PORT="${PORT:-8000}"
MARKER="data/.installed"

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║   💰 Money Engine — Установка и запуск            ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

# ── Python ──────────────────────────────────────────
if ! command -v python3 &>/dev/null; then
  echo "❌ Python 3 не найден."
  echo "   Установите: sudo apt install python3 python3-pip"
  exit 1
fi

# ── Зависимости ─────────────────────────────────────
if [ ! -d ".deps_ok" ]; then
  echo "→ [1/4] Установка зависимостей..."
  python3 -m pip install -r requirements.txt --user -q 2>/dev/null \
    || pip3 install -r requirements.txt -q
  mkdir -p .deps_ok
else
  echo "→ [1/4] Зависимости уже установлены ✓"
fi

# ── Конфиг ──────────────────────────────────────────
echo "→ [2/4] Настройка окружения..."
mkdir -p data output
[ -f .env ] || cp .env.example .env

# ── Turnkey setup ───────────────────────────────────
if [ ! -f "$MARKER" ]; then
  echo "→ [3/4] Первый запуск: сканирование + деплой ${FLEET_SIZE} проектов..."
  python3 main.py turnkey --count "$FLEET_SIZE" --no-serve
  touch "$MARKER"
  echo "   ✓ Система настроена"
else
  echo "→ [3/4] Система уже настроена ✓ (для переустановки: rm ${MARKER})"
  # Обновить флот до целевого размера если нужно
  python3 -c "
from src.fleet.scaler import scale_fleet
r = scale_fleet(${FLEET_SIZE})
print(f'   ✓ Флот: {r[\"active_projects\"]} проектов, ~{r.get(\"projected_rub_per_day\",0):.0f} ₽/день')
" 2>/dev/null || true
fi

# ── Запуск сервера ──────────────────────────────────
if [ -f .env ]; then
  PORT=$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 || echo "$PORT")
fi
PORT=${PORT:-8000}

echo "→ [4/4] Запуск сервера..."
echo ""
echo "  ┌─────────────────────────────────────────────┐"
echo "  │  ✅ Готово! Откройте в браузере:            │"
echo "  │                                             │"
echo "  │  🖥  Дашборд:  http://localhost:${PORT}       │"
echo "  │  🎮 Витрина:   http://localhost:${PORT}/hub/  │"
echo "  │                                             │"
echo "  │  Ctrl+C — остановить                        │"
echo "  └─────────────────────────────────────────────┘"
echo ""

exec python3 main.py start --port "$PORT"
