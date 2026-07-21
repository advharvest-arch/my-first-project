#!/bin/sh
set -e
cd /app

if [ ! -f data/opportunities.db ]; then
  echo "→ Первый запуск: turnkey setup..."
  python main.py turnkey --count "${FLEET_TARGET_SIZE:-50}" --no-serve
else
  echo "→ База найдена, пропуск установки"
fi

echo "→ Запуск сервера..."
exec python main.py start --port "${PORT:-8000}"
