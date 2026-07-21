#!/bin/bash
# Совместимость — перенаправляет на run.sh
exec "$(dirname "$0")/run.sh" "$@"
