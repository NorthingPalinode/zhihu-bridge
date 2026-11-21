# fixtures/replays/

只存放**真实运行**后冻结的结果（`provenance: "real_run"`），由 `server/scripts/freeze_replay.py` 在配置了真实模型凭据后生成（V6 §6.9）。

当前状态：**空**。本阶段未接入任何真实模型或知乎开放平台，因此没有可冻结的真实运行结果。
开发占位数据在 `fixtures/dev_stubs/`，与本目录物理分开；服务端加载回放时会拒绝 `provenance != "real_run"` 的文件。
