# 知乎能力实测（G0）

实测时间：2026-11-27 00:39:04（北京时间）。凭证：个人 Access Secret（报告中不记录凭证）。

调用方式：`server/scripts/zhihu_capability_check.py`，只做读取类调用，**没有调用 `knowledge_upload`，也没有任何发布操作**。

## 1. 额度

| 接口 | 总额度 | 实测前剩余 | 实测后剩余 |
| :--- | ---: | ---: | ---: |
| 知乎搜索（`zhihu_search`） | 5000 | 5000 | 5000 |
| 全网搜索（`global_search`） | 5000 | 5000 | 5000 |
| 问题发现（`question_discovery`） | 100 | 100 | 100 |
| 直答（`zhida_openai`） | 100 | 100 | 100 |
| 知识库（`knowledge`） | 500 | 500 | 500 |
| 创作能力（`creator`） | 500 | 500 | 500 |

## 2. `global_search` 英文查询（英文对照侧主路径能否成立）

| 查询 | 返回条数 | 英文正文条数 | 来源域名 |
| :--- | ---: | ---: | :--- |
| `smart ring kickstarter battery life` | 6 | 6 | www.notebookcheck.net×2, www.techadvisor.com×2, www.prnewswire.co.uk×1, www.cnet.com×1 |
| `smart ring waterproof 5 ATM review` | 6 | 3 | goods.taobao.com×3, www.accio.com×3 |
| `smart ring open source firmware developer` | 6 | 6 | gitlab.com×1, www.x-mol.com×1, arxiv.org×1, pypi.org×1 |
| `custom PCB smart ring components` | 6 | 6 | www.kingfordpcb.com×2, www.hackster.io×1, dev.to×1, www.kingfordpcb.cn×1 |
| `kickstarter hardware campaign claims FTC` | 6 | 1 | www.zhihu.com×2, www.imapbox.com×1, www.sendfromchina.com×1, world.huanqiu.com×1 |

合计：30 条，其中英文正文 22 条；域名分布前五：www.accio.com×4, goods.taobao.com×3, www.notebookcheck.net×2, www.techadvisor.com×2, www.kingfordpcb.com×2。

## 3. `zhihu_search` 中文语境

| 查询 | 返回条数 | 第一条标题 |
| :--- | ---: | :--- |
| 堆料 主板 用料 | 6 | iGame X870E ULTRA主板评测:潮酷外观硬核规格 2000元以内终极 |
| 极限压榨功耗 续航宣传 | 6 | 续航灭霸进场!华为下凡“抢饭碗”,教友商做性价比? - 知乎 |
| 底层协议调试 固件开源 | 6 | 为什么你应该学 OpenOCD,而不是只靠 J-Link Commander - |
| Kickstarter 硬件众筹 经验 | 6 | Kickstarter/Indiegogo海外众筹案例分享Vol.25 - 知乎 |

## 4. 问题发现与回答摘录

- `question_recommendations`：5 个问题
- `question_answers`：读取了 2 个问题，摘录条数分别为 5, 5

## 5. 知乎直答（`zhihu_direct` 模型可用性）

- 可用：返回 385 字，模型 zhida-fast-1p5

## 6. 知识库

- `knowledge_bases`：1 个知识库
- `knowledge_upload` 的可见范围：**没有实测**。实测需要真实上传一份内容，属于写操作，需要你单独确认。在确认之前，回流功能不开放上传。

## 结论与对实现的约束
1. **英文对照侧主路径成立，但必须过滤。** `global_search` 的英文查询有 22/30 条是英文正文，来自 notebookcheck、techadvisor、cnet、hackster 等科技站点；同时混进了电商站（taobao、accio）和中文站（zhihu、huanqiu、.cn）。实现上只保留英文正文，并按域名排除电商、中文站和知乎本站；过滤后某个概念没有剩下任何结果时，按“用户提供 → AI 推断（显式标注）”的顺序降级。
2. **知乎侧语境可用。** `zhihu_search` 4 个查询都有结果，`question_answers` 能读到回答摘录。但搜索结果与概念的相关性参差不齐（比如“堆料”搜出来的是显卡主板评测），所以由模型从摘录中挑选能解释该概念的内容，并保留原始标题和链接，绝不编造。
3. **个人凭证额度充足**：搜索各 5000 次，问题发现与直答各 100 次。实测前后的剩余额度没有变化，说明额度接口的统计可能有延迟，以官方后台为准。系统仍按 24 小时缓存加本地预算计数控制消耗。
4. **知乎直答（`zhida-fast-1p5`）可作为真实模型**（`LLM_PROVIDER=zhihu_direct`）。日额度 100 次，所以每个项目的流水线必须控制调用次数：提取 1 次、洞察 1 次、生成 1 次，检查以规则为主。
5. `knowledge_upload` 仍需你确认后才能实测。
