#!/bin/bash
# Money Engine — запуск из корня репозитория (одна кнопка)
exec "$(dirname "$0")/money_engine/run.sh" "$@"
