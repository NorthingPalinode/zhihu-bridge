# 知乎跨文化认知转译舱（Zhihu Bridge）· 本地可运行版

这是一个出海编辑的三栏工作台，从左到右依次是「原文与知乎证据 → 认知桥与选稿 → 验证、交付与回流」。默认入口连接后端，支持自定义原文和三套预置输入：

- **案例 A：广深仙侠短剧字幕**。切换受众，从通俗表达到保留术语选择译稿，查看译法依据，再通过模拟复述定位可能的误解。
- **案例 B：智能穿戴硬件众筹**。沿用原型的硬件文案，用实时知乎检索提供语境，生成英文短文案，并检查无数据支持的续航、功耗或开源承诺。
- **案例 C：岭南草本茶出海文案**。展示回南天的语境证据，以及功效声称从被拦截到形成终稿的过程。

前端入口是 `web/index.html`，并通过 `web/src/connected.ts` 连接后端。后端工作流遵循《Zhihu Bridge V6 实施方案（Claude 修订版）》。

> 产品入口根据配置读取知乎实时检索、检索缓存或已收录的真实来源。证据卡展示标题、作者（接口返回时）、采集时间和原文链接。未配置模型时，工作台提供证据查看。
> 原型数据从 `/?demo=1` 访问。连接开发占位后端时使用 `/?dev=1`。模型生成的读者复述属于模拟结果，编辑粘贴的评论会单独标注来源。

---

## 1. 环境要求

| 项目 | 要求 | 本环境实测版本 |
| --- | --- | --- |
| Python | 3.10 及以上（建议 3.12 或 3.13） | 3.13.5（Linux） |
| Node.js / npm | **只有重新构建前端时才需要**。仓库已附带构建好的 `web/dist/` | Node 24.22.2 / npm 11.19.1 |
| 浏览器 | 任一现代桌面浏览器，主视口 1440×900 | 无头 Chromium 156 用于自动化冒烟 |

不需要管理员权限：启动脚本只在本目录内创建虚拟环境，不调用 sudo，也不修改系统。

## 2. 一键启动（推荐）

先进入本目录（`app/`），然后：

| 系统 | 命令 |
| --- | --- |
| Windows（cmd 或双击） | `start.bat` |
| Windows PowerShell | `.\start.ps1`（如被执行策略拦截：`powershell -ExecutionPolicy Bypass -File .\start.ps1`，只对本次进程生效） |
| Linux / macOS | `./start.sh`（或 `python3 start.py`） |

启动后用浏览器打开 **http://127.0.0.1:8787/** 使用工作台。按 `Ctrl+C` 停止。

三个脚本都只是调用同一个 `start.py`，它依次做这些事：

1. **虚拟环境**：Linux/macOS 用 `app/.venv`，Windows 用 `app/.venv-win`。分开存放，是为了避免把在 Linux 上建好的 `.venv` 拷到 Windows 后无法使用。目录不存在时会用当前 Python 自动创建。
2. **依赖**：执行 `pip install -r server/requirements.txt -c server/requirements.lock.txt`，版本被锁文件约束。依赖文件没有变化时跳过。测试依赖写在 `server/requirements-dev.txt`，加 `--with-dev` 才安装。
3. **前端**：如果 `web/dist/index.html` 不存在，或者指定了 `--rebuild-web`，会先导出离线包，再执行 `npm ci` 和 `npm run build`。
4. **启动后端**，并由后端托管 `web/dist`：
   ```text
   <venv 的 python> -m uvicorn bridge.api.app:get_app --factory --app-dir server --host 127.0.0.1 --port 8787
   ```
   - app factory 是 `server/bridge/api/app.py` 中的 `get_app()`，必须加 `--factory`。
   - 工作目录是 `app/`。`--app-dir server` 让 uvicorn 能找到 `bridge` 包，脚本同时把 `server/` 写入 `PYTHONPATH`。
   - **只绑定 127.0.0.1**。本阶段不部署，也不监听 0.0.0.0。

常用参数：

```text
python start.py --port 9000        # 换端口
python start.py --offline          # 不启动后端，只用静态服务器打开离线包：http://127.0.0.1:8788/?offline=1
python start.py --smoke            # 启动 → 自动请求关键接口 → 关闭（验收用，使用独立计数库 var/smoke-*.sqlite3）
python start.py --rebuild-web      # 重新导出离线包并构建前端（需要 npm）
python start.py --with-dev         # 额外安装 pytest 等测试依赖
```

已有完整 `web/dist` 时，`--offline` 直接使用 Python 标准库启动静态服务。首次断网打开也可以使用已构建的包。

## 3. 分步手动启动（不用脚本时）

**Linux / macOS**（已在本环境实际执行验证）：

```bash
cd app
python3 -m venv .venv
.venv/bin/python -m pip install -r server/requirements.txt -c server/requirements.lock.txt
.venv/bin/python -m uvicorn bridge.api.app:get_app --factory --app-dir server --host 127.0.0.1 --port 8787
```

**Windows PowerShell**（与上面等价的命令。**本环境是 Linux，没有 PowerShell，这组命令未实际执行**）：

```powershell
cd app
py -3 -m venv .venv-win
.\.venv-win\Scripts\python.exe -m pip install -r server\requirements.txt -c server\requirements.lock.txt
.\.venv-win\Scripts\python.exe -m uvicorn bridge.api.app:get_app --factory --app-dir server --host 127.0.0.1 --port 8787
```

**前端开发模式**（热更新，可选）：先按上面的方式启动后端，再另开一个终端：

```bash
cd app/web
npm ci
npm run dev        # http://127.0.0.1:5173/ ，/api 自动代理到 127.0.0.1:8787
```

> 如果系统设置了 HTTP 代理，用命令行访问 127.0.0.1 时可能被代理拦截，可以加 `curl --noproxy '*'`，或把 `NO_PROXY` 设为 `127.0.0.1`。

## 4. 演示路径

产品入口可点选预置输入或粘贴原文。证据卡可翻面查看适用范围、采集时间及原文。

配置模型后可走 V6 §5.1 的转译流程：

1. **载入仙侠案例**：点「仙侠台词」，再点「开始转译」，受众为“北美 · 短剧新观众”，推荐档是通俗版。
2. **切换到“仙侠核心读者”，点“雷劫”看依据**：在顶栏切换受众。生成期间「复制终稿」锁定，完成后推荐「保留术语」。证据卡的「能支撑」描述这条资料可以解释的用法或语境，「不能支撑」说明它无法证明的事实。例如天气讨论可解释回南天的潮湿语境，不能证明商品功效。
3. **运行模拟读者测试，把误解带回知乎**：右栏运行测试（模型模拟读者 · n=3，直译 vs 选中档）。点误解原句旁的「带回知乎」查看相关讨论，编辑并复制提问草稿。

案例 C：在顶栏切换到「草本茶 · 岭南品牌」→ 点「回南天」查看语境证据 → 点守门编号 R1 至 R4，同屏查看「原候选 → 命中规则 → 处理理由 → 终稿」→「复制终稿」，复制到的是 `Herbal tea for humid days`，不含功效词。

其他可展示的功能：
- **档位切换**：仙侠和硬件的实时运行生成通俗版、少量术语、读感平衡、术语优先、保留术语五档。切换时读取本次已生成的译文，不发模型请求。草本茶沿用以可核验场景为主的单一终稿。
- **测试时效**：换档后，旧测试结果会标“针对上一版本”。
- **URL 复现**：URL 只保存案例、受众和档位，刷新即可复现，用户原文不写进 URL。

「回流知乎」可以接收一次复述里的误解或用户粘贴的真实评论。先检查相关讨论，在已有问题里补答或编辑新问题草稿，再进入知乎手动提交。补答或提问时可附原始语境、海外读者的困惑和具体想听到的经验。公开内容被后续检索命中时，可作为新一轮转译的证据候选。

首页「知乎 Access Secret」显示项目共享检索和问题发现额度。共享额度用完时，可导入个人密钥，改用个人知乎账户的额度。导入前会向知乎开放平台验证；密钥仅存在服务端会话，最长有效 8 小时，可随时「切回共享额度」。模型调用仍使用项目配置的供应商和预算。

## 5. 怎样识别“开发占位 / 非真实运行”

| 位置 | 显示 | 含义 |
| --- | --- | --- |
| 顶栏「生成」标签 | **开发占位 · 非真实运行**（紫色） | 当前结果来自 fake 适配器。另外三种取值是「实时生成 / 缓存回放 / 已降级」，只在真实接入或真实冻结后才会出现 |
| 顶栏「生成」标签 | 开发占位 · 非真实运行 · 离线包 | 后端不可用，正在读取打包的开发占位数据 |
| 证据卡 | 知乎精选（候选 · 待审核） | 证据来自 Day 0 实测样本，尚未经过人工审核（V6 §4.4） |
| 译稿区 | 「开发占位 · 非真实运行」 | 英文来自 V6 的验收参考译稿 |
| 模拟读者区 | 「开发占位 · 非评测结果」 | 复述是手写的占位样例，判定由规则给出 |
| 回流卡 | 来源「模拟读者误解（非真实用户）」 | 误解来自模拟读者，不是真实用户 |
| `/?dev=1` 首页 | 页脚「开发占位 · 非真实运行」 | 当前为开发占位模式 |

## 6. 降级与故障演练（只影响 fake 适配器）

启动前设置环境变量 `FAKE_FAILURE`，可以本地复现 V6 §5.5 的各种失败态：

| 取值 | 效果 |
| --- | --- |
| `generate` | 生成失败。界面显示「已降级」并保留原文和证据。因为没有真实回放，只提供「重试」，复制锁定 |
| `retell_partial` | 模拟读者显示“已完成 4/6”，按实际有效样本计算，不补造结果 |
| `zhihu` | 回流的已有讨论显示“查询失败”，草稿照常生成 |
| `rewrite` | 守门改写失败，该档保持草稿，不能复制 |

例如：Linux 上运行 `FAKE_FAILURE=generate ./start.sh`；PowerShell 中先执行 `$env:FAKE_FAILURE="generate"`，再运行 `.\start.ps1`。

## 7. 配置

`.env.example` 列出全部配置键和安全默认值，里面**没有任何密钥**。本项目**不会自动读取 `.env` 文件**，请在启动前把需要的值设成环境变量。不要把真实密钥写进任何仓库文件。

| 分组 | 键 |
| --- | --- |
| 模型 | `LLM_PROVIDER`（disabled / siliconflow / zhihu_direct / openai_compatible / fake）、`SILICONFLOW_API_KEY`、`LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MAIN_MODEL`、`LLM_LIGHT_MODEL`、`LLM_DAILY_CAP` |
| 知乎 | `ZHIHU_LIVE_ENABLED`、`ZHIHU_ACCESS_SECRET`、接口路径 |
| 预算与限流 | 知乎每日公网上限 6/6，每 IP 每小时 6/6/6，全局并发 ≤3。计数保存在 `var/bridge.sqlite3`，重启后仍在 |

## 8. 配置真实 API

在 Windows PowerShell 中为本次启动配置知乎检索：

~~~powershell
$env:ZHIHU_LIVE_ENABLED = 'true'
$env:ZHIHU_ACCESS_SECRET = [System.Net.NetworkCredential]::new('', (Read-Host '知乎 Access Secret' -AsSecureString)).Password
.\start.ps1
~~~

要让知乎检索继续提供证据、硅基流动负责生成，在同一 PowerShell 会话中设置知乎环境变量，再执行：

~~~powershell
$env:LLM_PROVIDER = 'siliconflow'
$env:SILICONFLOW_API_KEY = [System.Net.NetworkCredential]::new('', (Read-Host '硅基流动 API Key' -AsSecureString)).Password
.\start.ps1
~~~

该预设使用国内站 `https://api.siliconflow.cn/v1` 和 `deepseek-ai/DeepSeek-V4.1-Flash`，并请求 JSON 输出。知乎检索与问题发现沿用 `ZHIHU_ACCESS_SECRET`。

如果 Access Secret 有直答额度，启动前设置 `LLM_PROVIDER=zhihu_direct` 即可同时启用生成和模拟读者。知乎直答默认用 `zhida-fast-1p5`，沿用同一份 Access Secret。也可改用兼容 `/chat/completions` 的模型服务：

~~~powershell
$env:LLM_PROVIDER = 'openai_compatible'
$env:LLM_BASE_URL = Read-Host '模型 API 根地址（例如以 /v1 结尾）'
$env:LLM_MAIN_MODEL = Read-Host '模型名'
$env:LLM_API_KEY = [System.Net.NetworkCredential]::new('', (Read-Host '模型 API Key' -AsSecureString)).Password
~~~

生成和评测会分别调用模型。模型额度通过 `LLM_DAILY_CAP` 控制。联调可使用预置原文，运行通过后可用 `server/scripts/freeze_replay.py case_a a_new` 保存回放。

## 9. 测试与验收

**Linux / macOS 一键验收**（本环境实际跑过，结果见 `../phase3_test_results.md`）：

```bash
./verify.sh          # 后端 pytest、fixtures/契约/凭证检查、前端 vitest、前端构建、启动冒烟（在线 + 离线包）
./verify.sh --e2e    # 再加上无头浏览器冒烟（使用系统已有的 Chromium，不下载浏览器）
```

验收使用临时回环端口、独立的占位验收包和本次启动的服务进程。日志与浏览器截图存放在 `var/`。

日志写在 `var/verify-<时间>.log`。截图在 `docs/acceptance/screens/`。

**分项命令**（Windows 下把 `.venv/bin/python` 换成 `.\.venv-win\Scripts\python.exe`，路径分隔符换成 `\`）：

```bash
python start.py --with-dev --smoke               # 安装测试依赖（server/requirements-dev.txt）并做一次冒烟
cd server && ../.venv/bin/python -m pytest -q     # 后端测试
../.venv/bin/python scripts/check_fixtures.py     # fixtures 校验
../.venv/bin/python scripts/export_schema.py --check
../.venv/bin/python scripts/scan_secrets.py       # 凭证扫描
cd ../web && npm ci && npx vitest run && npm run build
cd .. && python start.py --smoke                  # 启动冒烟（自动关闭）
```

## 10. 目录

```text
app/
├─ start.py / start.bat / start.ps1 / start.sh   启动器（只绑定 127.0.0.1）
├─ verify.sh                                     Linux/macOS 一键验收
├─ .env.example                                  配置键（无密钥）
├─ contracts/          由 Pydantic 契约导出的 JSON Schema
├─ fixtures/           cases/ evidence/ personas/ guard/ zhihu_cache/（Day 0 实测）
│                      dev_stubs/（开发占位）与 replays/（只放真实运行，当前为空）物理分开
├─ server/bridge/      config · contracts · core（守门/预算/限流/缓存/回放/日志）· adapters（fake/OpenAI 兼容/知乎）· pipeline · api
├─ server/tests/       后端测试
├─ server/scripts/     export_schema / check_fixtures / export_offline_bundle / freeze_replay / scan_secrets
├─ web/                Vite；index.html（原型）· src/connected.ts（后端连接）· src/lib（状态/SSE/离线适配器）· e2e/（浏览器验收）
├─ docs/acceptance/screens/   自动化冒烟截图
└─ deploy/             反代配置示例说明（本阶段不部署）
```

## 11. 已知限制

- 缺少模型配置时，产品入口展示原文和可用证据。已返回的候选资料仍需编辑审核。
- 作者名称来自知乎返回字段。产品入口没有团队成员目录或答主授权管理。
- 自定义输入在 fake 模式下不会生成英文稿（会如实提示），只能演示校验、证据不足和降级流程。
- 知乎问题发现不可用时，只有与收录查询词匹配的输入可以读取实采缓存。
- Windows 的 `start.bat` / `start.ps1` 只做了静态检查（纯 ASCII、CRLF、只调用 `start.py`），没有在 Windows 上实际运行。`start.py` 的逻辑已在 Linux 上完整执行验证。
