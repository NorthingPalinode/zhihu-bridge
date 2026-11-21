#!/usr/bin/env sh
# Linux / macOS：在本目录运行 Python 启动器（参数原样透传，例如 ./start.sh --smoke）
set -e
cd "$(dirname "$0")"
if command -v python3 >/dev/null 2>&1; then PY=python3; else PY=python; fi
exec "$PY" start.py "$@"
