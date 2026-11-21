"""Short-lived, browser-scoped user credentials. The cookie contains only a random handle."""

from __future__ import annotations

import asyncio
import secrets
import time
from collections import OrderedDict
from dataclasses import dataclass, field

COOKIE = "zb_zhihu_session"
SESSION_SECONDS = 8 * 60 * 60


@dataclass(frozen=True)
class PersonalSession:
    access_secret: str = field(repr=False)
    expires_at: float
    quota_at_import: dict[str, int]


class ZhihuSessions:
    def __init__(self):
        self._sessions: OrderedDict[str, PersonalSession] = OrderedDict()

    def get(self, token: str | None) -> PersonalSession | None:
        session = self._sessions.get(token) if token else None
        if session and session.expires_at > time.monotonic():
            return session
        self.clear(token)
        return None

    def install(self, secret: str, quotas: dict[str, int], previous: str | None) -> tuple[str, PersonalSession]:
        self.clear(previous)
        now = time.monotonic()
        for token in list(self._sessions):
            if self._sessions[token].expires_at <= now:
                self.clear(token)
        if len(self._sessions) >= 256:
            self._sessions.popitem(last=False)
        token = secrets.token_urlsafe(32)
        session = PersonalSession(secret, now + SESSION_SECONDS, quotas)
        self._sessions[token] = session
        asyncio.get_running_loop().call_later(SESSION_SECONDS, self.clear, token)
        return token, session

    def clear(self, token: str | None) -> None:
        if token:
            self._sessions.pop(token, None)
