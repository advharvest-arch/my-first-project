#!/bin/bash
# Money Engine — запуск сервера
set -euo pipefail
cd "$(dirname "$0")"

[ -f .env ] || { echo "Сначала запустите: ./install.sh"; exit 1; }

PORT=$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 || echo 8000)
PORT=${PORT:-8000}

echo "🚀 Money Engine запущен → http://localhost:${PORT}"
echo "   Ctrl+C для остановки"
echo ""

python3 main.py start --port "$PORT"
