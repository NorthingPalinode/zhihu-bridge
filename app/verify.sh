#!/usr/bin/env bash
# Zhihu Bridge 本地验收脚本（Linux / macOS；Windows 请按 README_zh.md 逐条执行）。
# 用法：./verify.sh            后端测试 + 数据/契约/凭证检查 + 前端测试 + 构建 + 启动冒烟
#       ./verify.sh --e2e      另外用系统已有 Chromium 跑无头浏览器冒烟（需要 CHROMIUM_PATH 或 /usr/bin/chromium）
# 所有服务只绑定 127.0.0.1，并在结束时关闭。日志：var/verify-<时间>.log
set -u
cd "$(dirname "$0")"
APP="$(pwd)"
PY="$APP/.venv/bin/python"
E2E=0; [ "${1:-}" = "--e2e" ] && E2E=1
mkdir -p var
LOG="var/verify-$(date +%Y%m%d-%H%M%S).log"
SUMMARY=()

step() {  # step <名称> <命令...>
  local name="$1"; shift
  echo "=== $name" | tee -a "$LOG"
  echo "\$ $*" | tee -a "$LOG"
  "$@" >>"$LOG" 2>&1
  local rc=$?
  echo "exit=$rc" | tee -a "$LOG"
  SUMMARY+=("$( [ $rc -eq 0 ] && echo PASS || echo FAIL )  exit=$rc  $name")
  return 0
}

child_pid=""
stop_owned() {
  if [ -n "$child_pid" ]; then
    kill "$child_pid" 2>/dev/null || true
    wait "$child_pid" 2>/dev/null || true
    child_pid=""
  fi
}
trap stop_owned EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

free_port() {
  "$PY" -c 'from socket import socket; s = socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'
}

wait_url() {
  for _ in $(seq 1 60); do
    kill -0 "$child_pid" 2>/dev/null || return 1
    if curl --noproxy '*' -fsS --max-time 1 -o /dev/null "$1" 2>/dev/null; then
      kill -0 "$child_pid" 2>/dev/null
      return $?
    fi
    sleep 0.5
  done
  return 1
}

startup_smoke() {
  local port
  port=$(free_port) || return 1
  "$PY" start.py --smoke --skip-install --port "$port" "$@"
}

browser_smoke() {
  local scenario="$1" port base path script rc=1
  port=$(free_port) || return 1
  base="http://127.0.0.1:$port"
  script=smoke.mjs
  if [ "$scenario" = offline ]; then
    "$PY" -m http.server "$port" --bind 127.0.0.1 --directory "$WEB_DIST" &
    path=/
  else
    FAKE_FAILURE="$scenario" "$PY" -m uvicorn bridge.api.app:get_app --factory --app-dir server --host 127.0.0.1 --port "$port" &
    path=/api/health
    [ "$scenario" = generate ] && script=degrade.mjs
  fi
  child_pid=$!
  if wait_url "$base$path"; then
    shift
    (cd web && node "e2e/$script" "$base" "$SCREEN_DIR" "$@")
    rc=$?
    if [ "$scenario" = none ] && [ "$rc" -eq 0 ]; then
      (cd web && node e2e/prototype.mjs "$base" "$SCREEN_DIR")
      rc=$?
    fi
  else
    echo "验收服务未就绪：$base"
  fi
  stop_owned
  return "$rc"
}

# 0. venv 与依赖（含测试依赖）
step "准备 venv 与依赖（start.py 逻辑，含 --with-dev）" python3 -c "
import sys; sys.argv=['start.py','--with-dev']; sys.path.insert(0,'.')
import start; py=start.ensure_venv(start.DEFAULT_VENV); start.ensure_deps(py, start.DEFAULT_VENV, True)"

export LLM_PROVIDER=fake ZHIHU_LIVE_ENABLED=false FAKE_FAILURE=none
DAY0="$APP/../fixtures/day0_zhihu_search_samples.json"
[ -f "$DAY0" ] || DAY0="$APP/../../refs/fixtures/day0_zhihu_search_samples.json"
step "后端测试 pytest" bash -c "cd server && '$PY' -m pytest -q --basetemp=../var/pytest-tmp"
if [ -f "$DAY0" ]; then
  step "fixtures 校验（含 Day 0 原始字段对照，只读）" bash -c "cd server && '$PY' scripts/check_fixtures.py --day0 '$DAY0'"
else
  step "fixtures 校验" bash -c "cd server && '$PY' scripts/check_fixtures.py"
fi
step "契约 JSON Schema 与 Pydantic 一致" bash -c "cd server && '$PY' scripts/export_schema.py --check"
step "凭证扫描" "$PY" server/scripts/scan_secrets.py
VERIFY_DIR=$(mktemp -d "$APP/var/verify-artifacts.XXXXXX") || exit 1
export FIXTURES_DIR="$VERIFY_DIR/fixtures" WEB_DIST="$VERIFY_DIR/dist" ZB_TEST_BUNDLE="$VERIFY_DIR/bundle.json"
mkdir -p "$FIXTURES_DIR" || exit 1
cp -R fixtures/cases fixtures/evidence fixtures/guard fixtures/personas fixtures/dev_stubs fixtures/zhihu_cache "$FIXTURES_DIR/" || exit 1
step "导出验收用占位离线包" "$PY" server/scripts/export_offline_bundle.py --output "$ZB_TEST_BUNDLE"
step "安装前端锁定依赖" bash -c "cd web && npm ci --no-audit --no-fund"
step "前端测试 vitest" bash -c "cd web && npx vitest run"
step "前端构建 tsc + vite build" bash -c 'cd web && npm run build -- --outDir "$WEB_DIST"'
step "安装验收用离线包" cp "$ZB_TEST_BUNDLE" "$WEB_DIST/offline/bundle.json"
step "启动冒烟（后端 + 托管前端）" startup_smoke
step "启动冒烟（离线包）" startup_smoke --offline

if [ $E2E -eq 1 ]; then
  export DB_PATH="$APP/var/e2e-$(date +%s).sqlite3" RATE_LIMIT_RUNS_PER_IP_HOUR=100 RATE_LIMIT_TESTS_PER_IP_HOUR=100 RATE_LIMIT_DRAFTS_PER_IP_HOUR=100
  SCREEN_DIR="$VERIFY_DIR/screens"
  echo "浏览器截图：$SCREEN_DIR"
  step "浏览器冒烟（在线）" browser_smoke none
  step "浏览器冒烟（降级：FAKE_FAILURE=generate）" browser_smoke generate
  step "浏览器冒烟（离线包）" browser_smoke offline --offline
  unset DB_PATH
fi

echo
echo "================ 汇总（详细输出见 $LOG）"
printf '%s\n' "${SUMMARY[@]}" | tee -a "$LOG"
printf '%s\n' "${SUMMARY[@]}" | grep -q '^FAIL' && exit 1 || exit 0
