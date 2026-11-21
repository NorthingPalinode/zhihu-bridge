import os
import sys
from pathlib import Path

import pytest

SERVER = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER))

# 测试环境：强制 fake、关闭知乎实时、清空任何凭据环境变量，保证测试不可能触达外部 API。
for k in ("LLM_API_KEY", "SILICONFLOW_API_KEY", "ZHIHU_ACCESS_SECRET", "LLM_BASE_URL"):
    os.environ.pop(k, None)
os.environ["LLM_PROVIDER"] = "fake"
os.environ["ZHIHU_LIVE_ENABLED"] = "false"
os.environ["FAKE_STEP_DELAY_MS"] = "0"
os.environ["FAKE_FAILURE"] = "none"

from bridge.config import Settings  # noqa: E402
from bridge.pipeline.deps import build_deps  # noqa: E402


@pytest.fixture
def make_settings(tmp_path, monkeypatch):
    def _make(**env):
        monkeypatch.setenv("DB_PATH", str(tmp_path / "bridge.sqlite3"))
        monkeypatch.setenv("WEB_DIST", str(tmp_path / "no-dist"))
        for k, v in env.items():
            monkeypatch.setenv(k, str(v))
        return Settings()
    return _make


@pytest.fixture
def deps(make_settings):
    return build_deps(make_settings())


@pytest.fixture
def case_a_text(deps):
    return deps.fx.cases["case_a"].text


@pytest.fixture
def case_c_text(deps):
    return deps.fx.cases["case_c"].text
