"""SQLite（WAL）持久化：日预算计数、每 IP 限流、知乎查询缓存、运行索引（V6 §6.1、§6.5、§6.8）。

- 日界按北京时间 0 点（UTC+8，无夏令时）；是否与官方重置时间一致【待验证】。
- 调用前在一个事务里“检查并 +1”，调用失败也计数（知乎可能已经扣了额度）。
- 重启服务后计数和缓存仍在（回归表第 10 项）。
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Optional

BEIJING = timezone(timedelta(hours=8))


def beijing_date(now: Optional[float] = None) -> str:
    ts = time.time() if now is None else now
    return datetime.fromtimestamp(ts, BEIJING).strftime("%Y-%m-%d")


class Store:
    def __init__(self, path: Path, clock: Callable[[], float] = time.time):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.clock = clock
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(str(self.path), check_same_thread=False, isolation_level=None)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        self._conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS daily_counters(
              date TEXT NOT NULL, resource TEXT NOT NULL, used INTEGER NOT NULL, cap INTEGER NOT NULL,
              PRIMARY KEY(date, resource));
            CREATE TABLE IF NOT EXISTS rate_events(
              ip TEXT NOT NULL, kind TEXT NOT NULL, bucket INTEGER NOT NULL, count INTEGER NOT NULL,
              PRIMARY KEY(ip, kind, bucket));
            CREATE TABLE IF NOT EXISTS zhihu_query_cache(
              kind TEXT NOT NULL, query TEXT NOT NULL, payload TEXT NOT NULL, fetched_at REAL NOT NULL,
              PRIMARY KEY(kind, query));
            CREATE TABLE IF NOT EXISTS run_index(
              run_id TEXT PRIMARY KEY, created_at TEXT, case_id TEXT, audience_id TEXT, mode TEXT,
              provenance TEXT, text_len INTEGER, text_hash TEXT);
            CREATE TABLE IF NOT EXISTS compliance_rules(
              rule_id TEXT PRIMARY KEY,
              category TEXT NOT NULL,
              subcategory TEXT NOT NULL,
              title TEXT NOT NULL,
              markets TEXT NOT NULL,
              jurisdiction TEXT NOT NULL,
              severity TEXT NOT NULL,
              action TEXT NOT NULL,
              patterns_json TEXT NOT NULL,
              zh_cues_json TEXT NOT NULL,
              reason TEXT NOT NULL,
              suggestion TEXT NOT NULL,
              enabled INTEGER NOT NULL DEFAULT 1,
              builtin INTEGER NOT NULL DEFAULT 1,
              updated_at TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS idx_compliance_cat_enabled ON compliance_rules(category, enabled);
            """
        )

    def close(self) -> None:
        self._conn.close()

    # ---------- 日预算 ----------
    def try_consume(self, resource: str, cap: int) -> bool:
        """事务内检查并 +1。cap<=0 视为不限。返回 False 表示已触顶，不计数。"""
        date = beijing_date(self.clock())
        with self._lock:
            cur = self._conn.cursor()
            cur.execute("BEGIN IMMEDIATE")
            try:
                row = cur.execute("SELECT used FROM daily_counters WHERE date=? AND resource=?", (date, resource)).fetchone()
                used = row[0] if row else 0
                if cap > 0 and used >= cap:
                    cur.execute("COMMIT")
                    return False
                cur.execute(
                    "INSERT INTO daily_counters(date, resource, used, cap) VALUES(?,?,1,?) "
                    "ON CONFLICT(date, resource) DO UPDATE SET used=used+1, cap=excluded.cap",
                    (date, resource, cap),
                )
                cur.execute("COMMIT")
                return True
            except Exception:
                cur.execute("ROLLBACK")
                raise

    def used(self, resource: str) -> int:
        row = self._conn.execute(
            "SELECT used FROM daily_counters WHERE date=? AND resource=?", (beijing_date(self.clock()), resource)
        ).fetchone()
        return row[0] if row else 0

    def left(self, resource: str, cap: int) -> int:
        return max(0, cap - self.used(resource)) if cap > 0 else -1

    # ---------- 每 IP 限流（按小时桶） ----------
    def rate_hit(self, ip: str, kind: str, limit: int) -> bool:
        """返回 True 表示放行（并计数），False 表示超限。limit<=0 不限。"""
        if limit <= 0:
            return True
        bucket = int(self.clock() // 3600)
        with self._lock:
            cur = self._conn.cursor()
            cur.execute("BEGIN IMMEDIATE")
            try:
                row = cur.execute(
                    "SELECT count FROM rate_events WHERE ip=? AND kind=? AND bucket=?", (ip, kind, bucket)
                ).fetchone()
                count = row[0] if row else 0
                if count >= limit:
                    cur.execute("COMMIT")
                    return False
                cur.execute(
                    "INSERT INTO rate_events(ip, kind, bucket, count) VALUES(?,?,?,1) "
                    "ON CONFLICT(ip, kind, bucket) DO UPDATE SET count=count+1",
                    (ip, kind, bucket),
                )
                cur.execute("DELETE FROM rate_events WHERE bucket < ?", (bucket - 24,))
                cur.execute("COMMIT")
                return True
            except Exception:
                cur.execute("ROLLBACK")
                raise

    # ---------- 知乎查询缓存（TTL 24h） ----------
    def cache_get(self, kind: str, query: str, ttl_s: float = 86400) -> Optional[dict]:
        row = self._conn.execute(
            "SELECT payload, fetched_at FROM zhihu_query_cache WHERE kind=? AND query=?", (kind, query)
        ).fetchone()
        if not row:
            return None
        payload, fetched_at = row
        if self.clock() - fetched_at > ttl_s:
            return None
        return json.loads(payload)

    def cache_put(self, kind: str, query: str, payload: dict) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO zhihu_query_cache(kind, query, payload, fetched_at) VALUES(?,?,?,?) "
                "ON CONFLICT(kind, query) DO UPDATE SET payload=excluded.payload, fetched_at=excluded.fetched_at",
                (kind, query, json.dumps(payload, ensure_ascii=False), self.clock()),
            )

    # ---------- 运行索引（不存原文，只存长度和哈希） ----------
    def index_run(self, run_id: str, created_at: str, case_id, audience_id, mode, provenance, text_len, text_hash) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO run_index VALUES(?,?,?,?,?,?,?,?)",
                (run_id, created_at, case_id, audience_id, mode, provenance, text_len, text_hash),
            )

    def run_count(self) -> int:
        return self._conn.execute("SELECT COUNT(*) FROM run_index").fetchone()[0]

    # ---------- 海外法律与风俗风险规则库 ----------
    def seed_compliance_rules(self, rules: list[dict]) -> int:
        """写入/更新内置合规与风俗风险规则（保留用户自定义规则）。"""
        now = datetime.fromtimestamp(self.clock(), timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        with self._lock:
            cur = self._conn.cursor()
            cur.execute("BEGIN IMMEDIATE")
            try:
                for r in rules:
                    cur.execute(
                        """
                        INSERT INTO compliance_rules(
                          rule_id, category, subcategory, title, markets, jurisdiction,
                          severity, action, patterns_json, zh_cues_json, reason, suggestion,
                          enabled, builtin, updated_at
                        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)
                        ON CONFLICT(rule_id) DO UPDATE SET
                          category=excluded.category,
                          subcategory=excluded.subcategory,
                          title=excluded.title,
                          markets=excluded.markets,
                          jurisdiction=excluded.jurisdiction,
                          severity=excluded.severity,
                          action=excluded.action,
                          patterns_json=excluded.patterns_json,
                          zh_cues_json=excluded.zh_cues_json,
                          reason=excluded.reason,
                          suggestion=excluded.suggestion,
                          enabled=excluded.enabled,
                          updated_at=excluded.updated_at
                        WHERE compliance_rules.builtin = 1
                        """,
                        (
                            r["ruleId"],
                            r["category"],
                            r.get("subcategory", "general"),
                            r["title"],
                            json.dumps(r.get("markets", ["*"]), ensure_ascii=False),
                            r["jurisdiction"],
                            r.get("severity", "block"),
                            r.get("action", "rewrite" if r.get("severity", "block") == "block" else "review"),
                            json.dumps(r.get("patterns", []), ensure_ascii=False),
                            json.dumps(r.get("zhCues", []), ensure_ascii=False),
                            r["reason"],
                            r.get("suggestion", ""),
                            1 if r.get("enabled", True) else 0,
                            now,
                        ),
                    )
                cur.execute("COMMIT")
            except Exception:
                cur.execute("ROLLBACK")
                raise
        return len(rules)

    @staticmethod
    def _row_to_rule(row: tuple) -> dict:
        return {
            "ruleId": row[0],
            "category": row[1],
            "subcategory": row[2],
            "title": row[3],
            "markets": json.loads(row[4]),
            "jurisdiction": row[5],
            "severity": row[6],
            "action": row[7],
            "patterns": json.loads(row[8]),
            "zhCues": json.loads(row[9]),
            "reason": row[10],
            "suggestion": row[11],
            "enabled": bool(row[12]),
            "builtin": bool(row[13]),
        }

    def list_compliance_rules(
        self,
        *,
        category: Optional[str] = None,
        market: Optional[str] = None,
        enabled_only: bool = True,
    ) -> list[dict]:
        clauses: list[str] = []
        params: list[object] = []
        if enabled_only:
            clauses.append("enabled = 1")
        if category in ("legal", "custom"):
            clauses.append("category = ?")
            params.append(category)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        rows = self._conn.execute(
            f"""
            SELECT rule_id, category, subcategory, title, markets, jurisdiction,
                   severity, action, patterns_json, zh_cues_json, reason, suggestion,
                   enabled, builtin
            FROM compliance_rules
            {where}
            ORDER BY CASE category WHEN 'legal' THEN 0 ELSE 1 END, builtin DESC, rule_id ASC
            """,
            params,
        ).fetchall()
        items = [self._row_to_rule(r) for r in rows]
        if market:
            m = market.strip().lower()
            items = [item for item in items if "*" in item["markets"] or m in item["markets"]]
        return items

    def add_compliance_rule(self, rule: dict) -> dict:
        now = datetime.fromtimestamp(self.clock(), timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        action = rule.get("action") or ("rewrite" if rule.get("severity", "block") == "block" else "review")
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO compliance_rules(
                  rule_id, category, subcategory, title, markets, jurisdiction,
                  severity, action, patterns_json, zh_cues_json, reason, suggestion,
                  enabled, builtin, updated_at
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,0,?)
                """,
                (
                    rule["ruleId"],
                    rule["category"],
                    rule.get("subcategory", "user_custom"),
                    rule["title"],
                    json.dumps(rule.get("markets", ["*"]), ensure_ascii=False),
                    rule["jurisdiction"],
                    rule.get("severity", "block"),
                    action,
                    json.dumps(rule.get("patterns", []), ensure_ascii=False),
                    json.dumps(rule.get("zhCues", []), ensure_ascii=False),
                    rule["reason"],
                    rule.get("suggestion", ""),
                    now,
                ),
            )
        return {
            "ruleId": rule["ruleId"],
            "category": rule["category"],
            "subcategory": rule.get("subcategory", "user_custom"),
            "title": rule["title"],
            "markets": list(rule.get("markets", ["*"])),
            "jurisdiction": rule["jurisdiction"],
            "severity": rule.get("severity", "block"),
            "action": action,
            "patterns": list(rule.get("patterns", [])),
            "zhCues": list(rule.get("zhCues", [])),
            "reason": rule["reason"],
            "suggestion": rule.get("suggestion", ""),
            "enabled": True,
            "builtin": False,
        }

    def delete_compliance_rule(self, rule_id: str) -> bool:
        with self._lock:
            cur = self._conn.execute(
                "DELETE FROM compliance_rules WHERE rule_id = ? AND builtin = 0",
                (rule_id,),
            )
            return cur.rowcount > 0

