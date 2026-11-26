"""工作台持久化：项目状态（JSON 文档）与操作日志（前后快照，栈式撤销）。与旧 Store 共用同一个 SQLite 文件。"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Optional


class WorkbenchStore:
    def __init__(self, path: Path):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS wb_projects(
              id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at REAL NOT NULL, updated_at REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS wb_actions(
              id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, actor TEXT NOT NULL,
              action_type TEXT NOT NULL, label TEXT NOT NULL, before TEXT NOT NULL, after TEXT NOT NULL,
              created_at REAL NOT NULL, undone_at REAL);
            CREATE INDEX IF NOT EXISTS wb_actions_project ON wb_actions(project_id, id);
            """
        )

    def create(self, pid: str, state: dict) -> None:
        now = time.time()
        with self._lock:
            self._conn.execute("INSERT INTO wb_projects(id,data,created_at,updated_at) VALUES(?,?,?,?)",
                               (pid, json.dumps(state, ensure_ascii=False), now, now))

    def get(self, pid: str) -> Optional[dict]:
        with self._lock:
            row = self._conn.execute("SELECT data FROM wb_projects WHERE id=?", (pid,)).fetchone()
        return json.loads(row[0]) if row else None

    def list(self, limit: int = 20) -> list[dict]:
        with self._lock:
            rows = self._conn.execute("SELECT data, updated_at FROM wb_projects ORDER BY updated_at DESC LIMIT ?", (limit,)).fetchall()
        return [dict(json.loads(d), _updated_at=u) for d, u in rows]

    def commit(self, pid: str, before: dict, after: dict, action_type: str, label: str, actor: str = "user") -> int:
        """原子地写入新状态与一条操作日志。"""
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                self._conn.execute("UPDATE wb_projects SET data=?, updated_at=? WHERE id=?",
                                   (json.dumps(after, ensure_ascii=False), time.time(), pid))
                cur = self._conn.execute(
                    "INSERT INTO wb_actions(project_id,actor,action_type,label,before,after,created_at) VALUES(?,?,?,?,?,?,?)",
                    (pid, actor, action_type, label, json.dumps(before, ensure_ascii=False), json.dumps(after, ensure_ascii=False), time.time()))
                self._conn.execute("COMMIT")
                return int(cur.lastrowid)
            except Exception:
                self._conn.execute("ROLLBACK")
                raise

    def undo_last(self, pid: str) -> Optional[tuple[dict, str]]:
        """撤销最近一次未撤销的操作：恢复它的 before 快照。当前状态必须等于它的 after（否则说明日志断了）。"""
        with self._lock:
            row = self._conn.execute(
                "SELECT id, before, after, label FROM wb_actions WHERE project_id=? AND undone_at IS NULL ORDER BY id DESC LIMIT 1",
                (pid,)).fetchone()
            if not row:
                return None
            aid, before, after, label = row
            cur = self._conn.execute("SELECT data FROM wb_projects WHERE id=?", (pid,)).fetchone()
            if not cur or json.loads(cur[0]) != json.loads(after):
                raise RuntimeError("操作记录与当前状态不一致，无法撤销")
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                self._conn.execute("UPDATE wb_projects SET data=?, updated_at=? WHERE id=?", (before, time.time(), pid))
                self._conn.execute("UPDATE wb_actions SET undone_at=? WHERE id=?", (time.time(), aid))
                self._conn.execute("COMMIT")
            except Exception:
                self._conn.execute("ROLLBACK")
                raise
            return json.loads(before), label

    def actions(self, pid: str, limit: int = 50) -> list[dict]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT id, actor, action_type, label, created_at, undone_at FROM wb_actions WHERE project_id=? ORDER BY id DESC LIMIT ?",
                (pid, limit)).fetchall()
        return [{"id": r[0], "actor": r[1], "type": r[2], "label": r[3], "created_at": r[4], "undone": r[5] is not None} for r in rows]
