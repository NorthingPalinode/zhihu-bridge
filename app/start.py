#!/usr/bin/env python3
"""Zhihu Bridge 本地启动器（Windows / Linux / macOS 通用，只用 Python 标准库）。

做的事（全部只在本目录内）：
  1. 在 app/.venv（Windows 为 app/.venv-win）创建或复用虚拟环境；
  2. 按 server/requirements.txt 安装依赖，版本受 server/requirements.lock.txt 约束（依赖文件不变时跳过）；
  3. 若 web/dist 不存在（或指定 --rebuild-web），用 npm 构建前端（需要 Node.js）；
  4. 用 uvicorn 的 app factory 启动后端：bridge.api.app:get_app --factory --app-dir server，
     只绑定 127.0.0.1；后端同时托管 web/dist，浏览器打开 http://127.0.0.1:<port>/ 即可。

默认 LLM_PROVIDER=disabled、ZHIHU_LIVE_ENABLED=false：可查看已收录证据，生成和实时检索须配置后启用。

用法：
  python start.py                 启动（默认端口 8787）
  python start.py --port 9000
  python start.py --offline       不启动后端，只用静态服务器打开离线包（http://127.0.0.1:8788/）
  python start.py --smoke         启动 → 自动检查关键接口 → 关闭（用于验收）
  python start.py --rebuild-web   重新导出离线包并重新构建前端（需要 Node.js / npm）
  python start.py --with-dev      额外安装测试依赖（pytest 等）
  python start.py --skip-install  跳过依赖检查
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

APP = Path(__file__).resolve().parent
SERVER = APP / "server"
WEB = APP / "web"
DIST = Path(os.environ.get("WEB_DIST") or WEB / "dist").resolve()
HOST = "127.0.0.1"  # 只绑定本机回环地址；本阶段不部署、不对外暴露
IS_WIN = os.name == "nt"
DEFAULT_VENV = APP / (".venv-win" if IS_WIN else ".venv")
REQ = SERVER / "requirements.txt"
REQ_DEV = SERVER / "requirements-dev.txt"
LOCK = SERVER / "requirements.lock.txt"
FACTORY = "bridge.api.app:get_app"


def say(msg: str) -> None:
    print(f"[zhihu-bridge] {msg}", flush=True)


def fail(msg: str, code: int = 1) -> "NoReturn":  # type: ignore[name-defined]
    print(f"[zhihu-bridge] 错误：{msg}", file=sys.stderr, flush=True)
    sys.exit(code)


def venv_python(venv_dir: Path) -> Path:
    return venv_dir / ("Scripts/python.exe" if IS_WIN else "bin/python")


def ensure_venv(venv_dir: Path) -> Path:
    py = venv_python(venv_dir)
    if py.exists():
        return py
    if venv_dir.exists() and any(venv_dir.iterdir()):
        fail(f"{venv_dir} 已存在但不是当前系统可用的虚拟环境（缺少 {py.relative_to(venv_dir)}）。"
             f"请换一个目录：python start.py --venv <新目录>")
    say(f"创建虚拟环境：{venv_dir}")
    r = subprocess.run([sys.executable, "-m", "venv", str(venv_dir)])
    if r.returncode != 0 or not py.exists():
        fail("创建虚拟环境失败。Debian/Ubuntu 可能缺少 python3-venv（需要系统管理员安装，本脚本不会使用 sudo）。")
    return py


def ensure_deps(py: Path, venv_dir: Path, with_dev: bool) -> None:
    files = [REQ, LOCK] + ([REQ_DEV] if with_dev else [])
    digest = hashlib.sha256(b"".join(f.read_bytes() for f in files) + sys.version.encode()).hexdigest()
    marker = venv_dir / ".zb-deps.sha256"
    if marker.exists() and marker.read_text().strip() == digest:
        say("依赖已是最新（跳过安装）")
        return
    cmd = [str(py), "-m", "pip", "install", "--disable-pip-version-check", "-r", str(REQ)]
    if with_dev:
        cmd += ["-r", str(REQ_DEV)]
    cmd += ["-c", str(LOCK)]
    say("安装依赖：" + " ".join(Path(c).name if os.sep in c else c for c in cmd[1:]))
    if subprocess.run(cmd).returncode != 0:
        fail("pip 安装依赖失败（检查网络或 pip 源）。")
    marker.write_text(digest)


def ensure_web(py: Path, rebuild: bool) -> None:
    if (DIST / "index.html").exists() and not rebuild:
        return
    npm = shutil.which("npm")
    if not npm:
        fail("web/dist 不存在且找不到 npm。请安装 Node.js 18+ 后重试，或使用随附的 web/dist。")
    say("导出离线包数据")
    if subprocess.run([str(py), str(SERVER / "scripts" / "export_offline_bundle.py")], cwd=SERVER).returncode != 0:
        fail("导出离线包失败")
    for args in (["ci", "--no-fund", "--no-audit"], ["run", "build", "--", "--outDir", str(DIST)]):
        say("npm " + " ".join(args))
        if subprocess.run([npm, *args], cwd=WEB).returncode != 0:
            fail(f"npm {' '.join(args)} 失败")


def server_env() -> dict:
    env = os.environ.copy()
    env.setdefault("LLM_PROVIDER", "disabled")
    env.setdefault("ZHIHU_LIVE_ENABLED", "false")
    env["PYTHONPATH"] = str(SERVER) + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
    return env


def backend_cmd(py: Path, port: int) -> list[str]:
    return [str(py), "-m", "uvicorn", FACTORY, "--factory", "--app-dir", str(SERVER), "--host", HOST, "--port", str(port)]


def offline_cmd(py: Path, port: int) -> list[str]:
    return [str(py), "-m", "http.server", str(port), "--bind", HOST, "--directory", str(DIST)]


# ---------------- 冒烟检查 ----------------
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # 本机请求不走代理


def http(method: str, url: str, body: dict | None = None, timeout: float = 30) -> tuple[int, str]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json"} if data else {})
    try:
        with _OPENER.open(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


def wait_up(url: str, proc: subprocess.Popen, seconds: float = 40) -> None:
    end = time.time() + seconds
    while time.time() < end:
        if proc.poll() is not None:
            fail(f"服务进程提前退出（退出码 {proc.returncode}）")
        try:
            _OPENER.open(url, timeout=2).read()
            return
        except urllib.error.HTTPError:
            return  # 有响应（哪怕 404）即说明已监听
        except Exception:  # noqa: BLE001
            time.sleep(0.4)
    fail("服务在限定时间内没有就绪")


def sse_ready(base: str, body: dict) -> dict:
    status, text = http("POST", f"{base}/api/runs", body, timeout=60)
    if status != 200:
        raise AssertionError(f"/api/runs HTTP {status}: {text[:200]}")
    events = [json.loads(line[6:]) for line in text.splitlines() if line.startswith("data: ")]
    types = [e["type"] for e in events]
    if types != ["started", "terms", "evidence", "ready"]:
        raise AssertionError(f"SSE 事件顺序异常：{types}")
    return events[-1]["payload"]


def smoke_backend(base: str) -> list[tuple[str, bool, str]]:
    out: list[tuple[str, bool, str]] = []

    def check(name: str, fn) -> None:
        try:
            detail = fn() or ""
            out.append((name, True, str(detail)))
        except Exception as exc:  # noqa: BLE001
            out.append((name, False, f"{exc.__class__.__name__}: {exc}"))

    def health():
        s, t = http("GET", f"{base}/api/health")
        h = json.loads(t)
        assert s == 200 and h["ok"] and h["generationMode"] == "dev_stub" and h["zhihuLive"] is False, t
        return f"generationMode={h['generationMode']} llmProvider={h['llmProvider']} replayCount={h['replayCount']}"

    def cases():
        s, t = http("GET", f"{base}/api/cases")
        labels = [c["label"] for c in json.loads(t)["cases"]]
        assert s == 200 and labels == ["仙侠字幕 · 广深短剧", "硬件文案 · 智能穿戴众筹", "草本茶 · 岭南品牌"], labels
        return " / ".join(labels)

    state: dict = {}

    def case_a():
        snap = sse_ready(base, {"text": "此乃天道因果，若扛不过九重雷劫，便只能魂飞魄散。", "audienceId": "a_genre", "caseId": "case_a"})
        assert snap["mode"] == "dev_stub" and snap["provenance"] == "dev_stub", snap["mode"]
        genre = next(v for v in snap["variants"] if v["level"] == "genre")
        assert genre["exportState"] == "exportable"
        state["run"] = snap["runId"]
        return "mode=dev_stub recommended=" + snap["recommendedLevel"] + " evidenceSource=" + snap["evidenceSource"]

    def test_a():
        s, t = http("POST", f"{base}/api/runs/{state['run']}/tests", {"revision": 1, "level": "genre", "keyPointIds": ["KP1", "KP2", "KP3"]})
        r = json.loads(t)
        assert s == 200 and r["completed"] == r["expected"] == 6 and r["provenance"] == "dev_stub", t[:200]
        return f"completed={r['completed']}/{r['expected']} provenance={r['provenance']}"

    def draft_a():
        s, t = http("POST", f"{base}/api/questions/draft", {"source": {"kind": "reader_misreading", "text": "A huge thunderstorm is coming.", "keyPointId": "KP2"},
                                                            "caseId": "case_a", "runId": state["run"], "termIds": ["T2"]})
        d = json.loads(t)
        assert s == 200 and d["sourceLabel"] == "模拟读者误解（非真实用户）" and d["existingSource"] == "cache", t[:200]
        return f"existingSource={d['existingSource']} existing={len(d['existing'])} recommendation={d['recommendation']}"

    def case_c():
        snap = sse_ready(base, {"text": "回南天祛湿茶，清热解毒，拯救熬夜上火。", "audienceId": "c_shopper", "caseId": "case_c"})
        single = next(v for v in snap["variants"] if v["level"] == "single")
        final = "".join(s["text"] for s in single["segments"])
        assert final == "A light, refreshing herbal tea for humid days — cooling and soothing to rescue you from late-night burnout." and single["exportState"] == "exportable", final
        return f"final={final!r} claims={[c['label'] for c in single['checks'] if c['kind'] == 'claim']}"

    def index():
        s, t = http("GET", f"{base}/")
        assert s == 200 and '<div id="app">' in t, s
        return "web/dist 由后端托管"

    for name, fn in [("GET /api/health", health), ("GET /api/cases", cases), ("POST /api/runs 案例 A（a_genre）", case_a),
                     ("POST /api/runs/{id}/tests", test_a), ("POST /api/questions/draft", draft_a),
                     ("POST /api/runs 案例 C", case_c), ("GET / 前端页面", index)]:
        check(name, fn)
    return out


def smoke_offline(base: str) -> list[tuple[str, bool, str]]:
    out = []
    s, t = http("GET", f"{base}/?offline=1")
    out.append(("GET /?offline=1 前端页面", s == 200 and '<div id="app">' in t, f"HTTP {s}"))
    s, t = http("GET", f"{base}/offline/bundle.json")
    bundle = json.loads(t) if s == 200 else {}
    provenance = bundle.get("provenance")
    ok = provenance in ("dev_stub", "mixed", "real_run") and bool(bundle.get("runs"))
    out.append(("GET /offline/bundle.json", ok, f"HTTP {s} provenance={provenance}"))
    s, _ = http("GET", f"{base}/api/health")
    out.append(("GET /api/health 在静态服务中不可用", s == 404, f"HTTP {s}"))
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="Zhihu Bridge 本地启动器（只绑定 127.0.0.1）")
    ap.add_argument("--port", type=int, default=None)
    ap.add_argument("--offline", action="store_true", help="只用静态服务器打开离线包，不启动后端")
    ap.add_argument("--smoke", action="store_true", help="启动后自动检查关键接口，然后关闭")
    ap.add_argument("--rebuild-web", action="store_true", help="重新导出离线包并构建前端（需要 npm）")
    ap.add_argument("--with-dev", action="store_true", help="额外安装测试依赖")
    ap.add_argument("--skip-install", action="store_true", help="跳过依赖检查")
    ap.add_argument("--venv", type=Path, default=DEFAULT_VENV, help=f"虚拟环境目录（默认 {DEFAULT_VENV.name}）")
    a = ap.parse_args()

    if sys.version_info < (3, 10):
        fail(f"需要 Python 3.10+，当前为 {sys.version.split()[0]}")
    port = a.port if a.port is not None else (8788 if a.offline else 8787)
    if not 1 <= port <= 65535:
        ap.error("--port 必须在 1–65535 之间")
    if a.offline and not a.rebuild_web:
        if not (DIST / "index.html").is_file() or not (DIST / "offline" / "bundle.json").is_file():
            fail("未找到完整的离线构建。请使用随附的 web/dist，或联网后用 --rebuild-web 构建。")
        py = Path(sys.executable)
    else:
        venv_dir = a.venv.resolve()
        py = ensure_venv(venv_dir)
        if not a.skip_install:
            ensure_deps(py, venv_dir, a.with_dev)
        ensure_web(py, a.rebuild_web)

    cmd = offline_cmd(py, port) if a.offline else backend_cmd(py, port)
    base = f"http://{HOST}:{port}"
    say(("离线包模式（静态服务器）：" if a.offline else "后端 + 前端：") + base + ("/?offline=1" if a.offline else "/"))
    env = server_env()
    if a.smoke and not a.offline:
        # 自动冒烟使用开发占位和独立的库，避免调用外部接口或占用产品预算。
        (APP / "var").mkdir(exist_ok=True)
        env.update(LLM_PROVIDER="fake", ZHIHU_LIVE_ENABLED="false", FAKE_FAILURE="none",
                   DB_PATH=str(APP / "var" / f"smoke-{int(time.time())}.sqlite3"))
    if not a.offline:
        say("模式：LLM_PROVIDER=" + env["LLM_PROVIDER"] + "，ZHIHU_LIVE_ENABLED=" + env["ZHIHU_LIVE_ENABLED"])
    say("命令：" + " ".join(cmd))

    if not a.smoke:
        try:
            return subprocess.run(cmd, cwd=APP, env=env).returncode
        except KeyboardInterrupt:
            say("已停止")
            return 0

    proc = subprocess.Popen(cmd, cwd=APP, env=env)
    try:
        wait_up(base + "/", proc)
        results = smoke_offline(base) if a.offline else smoke_backend(base)
    finally:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
    for name, ok, detail in results:
        print(f"{'PASS' if ok else 'FAIL'}  {name}  {detail}")
    failed = sum(1 for _, ok, _ in results if not ok)
    say(f"冒烟 {len(results) - failed}/{len(results)} 通过；服务已关闭")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
