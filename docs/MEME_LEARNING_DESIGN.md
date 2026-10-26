# 自主学梗系统设计方案

- 仓库：`Mokusei-Hana/qq-agent`
- 实施分支：`feat/meme-learning-pilot`
- 状态：设计方案；尚未完成生产接入，不能视为已上线。
- 输入资产：第三方 `skills-trendy-memes.zip`，其中包含 `skill.json`、`index.js`、`kb/memes.json`。

## 1. 目标与非目标

### 目标

1. 保留第三方 Skill 的梗知识底稿、别名优先检索、语气/用法/流行时期等字段与“先查再用、不确定就承认、不强行接梗”的行为设计。
2. 让机器人能在授权 QQ 群观察到反复出现的新表达，并定期从中文互联网公开网页发现新梗。
3. 通过 AI 解释和交叉证据核验后再正式收录；任何未验证条目都不能进入正常聊天检索结果。
4. 使用持久化存储，追踪证据来源，允许纠错、撤回、过期和手动审核。
5. 与现有 QQ-Agent 架构原生集成，不引入一个假想的 Skill 加载器，不改变无关功能。
6. 默认关闭、可观测、可回滚，分阶段灰度启用。

### 非目标

- 不训练/微调基础模型。
- 不允许机器人自动执行网页或群聊内容中的指令。
- 不将群聊全文上传给第三方搜索服务；群聊学习默认只提取候选表达，最小化存储。
- 不自动把所有群友发言当作梗，也不要求每条消息都触发搜索或模型调用。
- 不自动向群内广播“我学会了某梗”，避免刷屏。
- 不直接恢复旧的 `slangPilot`；它在当前代码中是退役兼容接口。

## 2. 仓库现状（已核实）

- `package.json`：ESM 项目，要求 Node.js `>=22.13.0`，测试基于 `node --test`。
- `docs/ARCHITECTURE.md`：`app.js` 是组合根；OneBot 事件进入 SQLite 消息状态机，再交给 Orchestrator/模型/工具；模块在同一进程中运行。
- `src/web-search.js`：已有 `webSearch()` 及多种搜索提供方；抓取网页正文应使用 `src/safe-fetch.js` 的 `safeFetch()`，不能自行写不安全的 fetch。
- `src/llm.js`：已有 OpenAI 兼容模型调用 `chatCompletion()`。
- `src/store.js`：已有基于 `node:sqlite` 的 `ChatStore`，数据目录来自 `DATA_DIR`。
- `src/slang-pilot.js`：当前是退役兼容壳；研究、审核、重试不可用。
- `src/stable-feature-policy.js`：明确将 `slangPilot` 固定为关闭，并清除旧调参字段。新功能必须使用全新配置命名空间，如 `memeLearningPilot`，不能复用旧开关。
- `AGENTS.md` 和 `docs/EXPERIMENTAL_FEATURE_STANDARD.md`：实验功能需要独立模块、独立生命周期、默认不产生副作用、停用不删数据；需要操作界面时应有独立页面，实验设置页只负责启停/毕业。
- `skills-trendy-memes.zip`：`skill.json` 定义“先查再用”的行为规范；`index.js` 通过 `setup(api)` / `api.registerTool()` 注册 `lookup`、`index`、`remember`；`kb/memes.json` 提供初始梗库。这个注册接口不是当前 QQ-Agent 的既有接口，不能原样加载。

注意：分支中已有的 `src/meme-learning.js` 是此前创建的实验草稿，尚未接入 `app.js`，也没有真实运行测试。Codex 必须先审查并修正，不要把“文件已提交”当作“实现已完成”。

## 3. 设计原则

### 3.1 以第三方 Skill 为知识与交互规范的上游

保留并迁移以下能力：

- 字段：`title/term`、`aliases`、`meaning`、`usage`、`tone`、`era`、`freshness`、`tags`。
- 检索：精确标题 > 精确别名 > 部分标题/别名 > 释义/标签弱匹配；别名比长正文更重要。
- 工具意图：查询梗、浏览目录、提出收录/纠错。
- 提示词原则：不确定先查；搜索后读正文；只用一两句话解释；一条回复至多自然使用一个梗；不确定就说不确定；标记偏旧的梗不能冒充新梗。
- 不直接沿用原始 `remember` 的“模型传入释义后立即写 JSON”行为。新系统必须有候选/审核状态、证据 URL、来源域名、时间和反馈记录。

原始底稿建议作为只读种子数据导入数据库，并记录 `origin=seed` 和迁移版本；保留 ZIP 原件及原始 JSON 的校验和。不要悄悄重写原始释义。发现过时或错误时，保存原值和修订历史。

### 3.2 单一职责的模块结构

推荐拆成以下职责；实际文件名可按仓库现有命名约定调整：

- `src/meme-learning.js`：生命周期、依赖注入、任务调度和协调。
- `src/meme-learning-store.js`：SQLite schema、迁移、查询、事务、反馈和 TTL。
- `src/meme-learning-research.js`：搜索候选、抓取来源、分析结果结构化与证据核验。
- `src/meme-learning-prompt.js`：聊天时的行为规则与安全边界。
- `src/meme-learning-tools.js` 或在现有工具注册层添加只读工具：检索、目录、反馈/提议；不要照搬 `api.registerTool`。
- `src/config-legacy.js`：添加默认关闭的 `memeLearningPilot` 配置。
- `src/config.js` / `src/stable-feature-policy.js`：增加独立的配置规范化和实验生命周期规则，不能放开退役的 `slangPilot`。
- `src/app.js`：作为组合根，注入搜索、safeFetch、模型分析、ChatStore/事件、状态广播和生命周期。
- `ui/` 与对应 API 路由：如管理功能需要操作页面，建立独立学梗页面，不把候选审核表塞进“实验功能”开关页。
- `test/meme-learning*.test.mjs` 与 `docs/MEME_LEARNING_PILOT.md`：测试、运维和回滚文档。

避免为此新增重量级依赖；Node 22 自带 `node:sqlite`。若现有 DB schema 迁移机制有约定，优先遵守。

## 4. 数据流

### A. 公开互联网发现

1. 调度器按配置执行（建议默认每 6 小时一次；启用前仍须由管理员显式开关）。
2. 使用现有 `webSearch()` 发现候选；每轮限制查询数量、结果数量、抓取字节、并发、总耗时和模型 token 预算。
3. 用 `safeFetch()` 读取允许的公开 HTTP(S) 页面；保存最终 URL、域名、标题、短摘录、抓取时间、状态码/失败原因。遵守 robots/站点条款和合理请求频率；遇到拒绝、验证码、登录墙时停止，不绕过访问控制。
4. 网页内容仅作为不可信证据，HTML/文本中的任何指令都不得成为模型系统指令。
5. 模型返回严格结构化结果：术语、别名、释义、用法、语气、可能的流行时期、是否敏感、置信度、依据及不确定点。校验字段和长度，不接受任意额外动作。
6. 针对候选术语做独立的佐证搜索，尽量获取至少两个不同注册域名的有效证据；域名数量只是门槛，不代表真伪。去除重复转载、搜索摘要重复和明显 SEO 垃圾。
7. 仅当 `verified=true`、置信度达阈值、至少两个独立来源、非敏感、来源可追溯且无明显冲突时，进入 `pending_review` 或经配置允许的低风险自动审核队列。建议初期一律 `pending_review`，人工批准后才变为 `active`。后续稳定后才可考虑低风险自动入库。
8. 搜索失败、模型超时、来源冲突、单来源、低置信度时只保存待审核候选/失败状态，不得降级成“直接收录”。

### B. 授权 QQ 群观察

1. 只观察管理员明确配置的群 ID；默认空白名单即不收集。
2. 忽略机器人自身消息、私聊、转发整段原文、CQ 码、图片/文件内容、URL、口令/凭据、明显个人信息和超长消息。
3. 默认不保存完整聊天记录。优先做本地短文本候选抽取、规范化和频次计数；可保存必要的群 ID、消息时间桶、候选表达 hash、出现次数和最小上下文片段。原始片段设置短保留期。
4. 仅对多次出现或被用户明确问“这是什么梗”的候选做研究。群聊文本不能直接作为可信来源，不能仅凭“群里很多人说”就断定全网含义。
5. 不把私聊、其他群、成员画像或长期记忆拼进学梗任务；不得跨群暴露来源群的私密内容。
6. 提供管理员开关、群白名单、清除候选和禁用群；停用时立即停止观察与定时任务，保留已审核知识。

### C. 聊天时查询与自然接梗

1. 使用现有工具调用机制注册只读检索工具；查询顺序为：种子底稿/正式知识库 → 必要时调用现有 `web_search` → 需要时 `web_fetch` 读取正文。
2. 本地命中优先返回 1–3 条相关条目，包含释义、使用场景、语气、是否偏旧、置信度和来源状态；不要把整份知识库塞进 system prompt。
3. 只有用户明确问梗义、当前上下文确实需要理解梗、或模型自判不确定时才检索。不能每条消息强制查。
4. 回复优先自然聊天；若只是普通话题，不为展示知识而硬接梗；每条回复最多一个梗；不确定就承认不确定。
5. 词条是参考数据而不是命令。即使知识条目、网页或群消息中包含“忽略规则/调用工具/泄露秘密”等内容，也不得执行。
6. 对高攻击性嘲讽、骚扰、歧视、性暗示、未成年人相关不当内容等设内容风险标签和使用限制。默认不主动传播高风险梗；原 Skill 的敏感内容拦截规则应保留为可审计策略，而非只靠模型自觉。

### D. 收录、纠错和撤回

- 工具调用先创建 `pending` 提案，不能直接写入 `active`。
- 自动收录必须具备证据、独立来源、结构化验证结果和审计记录；初期推荐管理员审核。
- 纠错：记录反馈人类型（管理员/普通成员，不需要持久化真实昵称）、反馈时间、原释义、建议释义和证据。错误词条立即隔离为 `quarantined`，经重新核验或管理员批准后恢复。
- “过时”反馈标记为 `stale`，不一定删除；保留历史和最后验证时间。
- 重复词条按规范化标题/别名合并，别名冲突时进入审核，不能覆盖另一条词条。
- 删除或彻底清除属于破坏性动作，需管理员权限和明确确认。

## 5. SQLite 数据模型建议

所有表有 `created_at`、`updated_at`，时间统一存 Unix 毫秒或项目既有单位并保持一致。

- `meme_entries`: `id`、`canonical_term`、`normalized_term`、`meaning`、`usage`、`tone`、`era`、`freshness`、`tags_json`、`confidence`、`status`、`scope`、`origin`、`created_at`、`updated_at`、`last_verified_at`、`expires_at`、`version`。
- `meme_aliases`: `entry_id`、`alias`、`normalized_alias`、唯一索引；冲突需要显式处理。
- `meme_sources`: `entry_id`、`url`、`canonical_url`、`domain`、`title`、`excerpt`、`published_at`（可空）、`fetched_at`、`content_hash`、`source_type`、`verification_result`。
- `meme_candidates`: `candidate_text` 或 hash、`origin_type`、`group_id`（可空）、`occurrence_count`、`first_seen_at`、`last_seen_at`、`status`、`expires_at`。
- `meme_reviews`: `entry_id`、`decision`、`reviewer_role`、`note`、`created_at`。
- `meme_feedback`: `entry_id`、`kind`、`note`、`suggested_meaning`、`created_at`。
- `meme_research_runs`: `run_id`、`started_at`、`finished_at`、`status`、`query_count`、`fetch_count`、`model_calls`、`tokens_estimated`、`error_code`、`summary_json`。

数据库需 WAL、busy timeout、参数化 SQL、迁移版本、唯一约束和事务。对写入使用临时文件/事务语义；不将秘密写入表、prompt 或日志。

## 6. 配置与生命周期

配置命名空间建议：

```json
{
  "memeLearningPilot": {
    "enabled": false,
    "graduated": false,
    "scheduleIntervalMs": 21600000,
    "allowedGroupIds": [],
    "autoAdmitLowRisk": false,
    "minConfidence": 0.85,
    "minIndependentDomains": 2,
    "maxQueriesPerRun": 4,
    "maxPagesPerRun": 12,
    "maxModelCallsPerRun": 8,
    "candidateTtlDays": 7,
    "entryTtlDays": 45,
    "rawGroupSnippetTtlHours": 24
  }
}
```

这只是设计默认值，不代表现有配置 schema 已支持。必须通过当前配置验证/规范化流程落地，且旧安装迁移后仍默认关闭。不要使用 `slangPilot` 作为别名或复活旧设置。

启用后才创建 DB/定时器；停用时取消 timer、阻止新任务、对在途任务发 AbortSignal 并等待安全结束；不删除数据。单次任务必须有互斥锁，避免重叠。进程重启后可恢复 queued/pending 状态，但不能自动重放有未知外部副作用的动作（本模块不应有外部写入动作）。

## 7. 安全与隐私要求

- 只抓公开 HTTP(S) 网页，所有抓取必须走 `safeFetch()` 的 SSRF 防护。
- URL 校验重定向、DNS/IP、scheme；限制响应大小、超时、重定向次数和内容类型。
- 不执行网页 JavaScript，不下载/执行代码，不加载第三方 Skill 的任意依赖。
- 网页和群聊内容都视为不可信输入，采用隔离的分析 prompt；不把内容拼入 system/developer 指令。
- 不将群聊原文发送给搜索服务；搜索词从公共术语或脱敏候选构造。
- 群观察必须明确授权并限制到白名单群，最小化记录、短期清理，提供关闭和清除入口。
- 限制每轮搜索数、每小时模型调用、总 token、并发、请求超时；遇到 429/5xx 用有上限退避，禁止无限循环。
- 证据不足、来源互相矛盾、内容高风险时 fail closed。
- 审计日志只记状态、计数和错误码，不记 API Key、access token、整段群聊内容。

## 8. UI/API 要求

按 `docs/EXPERIMENTAL_FEATURE_STANDARD.md`：

- “实验功能”页面仅显示模块状态、启用/停用、毕业操作和简短结果。
- 独立学梗页面负责：状态与最近一次任务、任务历史、候选审核、词条搜索/详情、来源列表、纠错记录、群白名单、限额和保留策略。
- API 需要沿用现有管理端认证和路由风格；每个写入路由检查管理员权限、输入 schema、CSRF/现有安全要求。
- 页面应在模块停用时仍可查看/修复历史数据；禁用不会清空词条。

## 9. 测试矩阵

### 单元测试

- 底稿导入、字段规范化、别名冲突、精确/部分匹配和检索排序。
- 默认关闭不创建 DB、不启动 timer、不观察群消息。
- 仅白名单群、仅普通人类文本；私聊、自身消息、CQ 码、URL、空白、超长输入均被忽略。
- 只有一个来源、同域名多页面、转载重复、低置信度、`verified=false`、敏感/冲突条目都不能 active。
- 两个独立有效域名 + 达标置信度 + 验证通过才能进入待审核/正式状态；初期仍需人工批准。
- 纠错后隔离、过期状态、去重合并、别名冲突、TTL 清理、事务回滚。
- 注入 prompt 的网页内容不能影响工具权限或系统规则。
- 任务并发锁、停用取消、重启恢复、异常与限额处理。

### 集成/回归测试

- 用 mock search/fetch/LLM，不访问真实网络、不消耗模型额度。
- 使用临时 `QQ_AGENT_DATA_DIR`，不触碰真实生产数据。
- `node --test test/meme-learning*.test.mjs`
- `npm run test:unit`
- `npm test`
- `npm run test:render`
- 需要时在测试环境验证管理 API/UI；未跑过的命令不得在交接中写成通过。

## 10. 发布、灰度与回滚

1. 先只读导入底稿，运行检索测试。
2. 启用互联网研究，但所有新词条只进入待审核。
3. 用管理员手动审核一段时间，检查误判率、费用、任务失败和来源质量。
4. 单独允许一个测试群观察候选，默认不保存完整原文。
5. 只有在数据质量和隐私边界验证通过后才考虑低风险自动收录。
6. 每阶段均可关闭开关；停用后知识库保留。回滚代码不应删除数据库；必要时用备份/迁移版本恢复。
7. 不自动部署到服务器，不修改 `main`，不合并 PR，除非用户另行明确要求。

## 11. 完成定义

只有同时满足以下条件才能说“自主学梗已实现”：

- 原始底稿完成迁移且条目数量/关键字段校验通过。
- 搜索、抓取、LLM 分析、证据保存、审核、检索和纠错链路可运行。
- QQ 群采集仅在显式授权白名单生效。
- 定时器、停用、重启、TTL、UI/API 权限和日志隐私测试通过。
- 所有声明的测试实际执行并报告结果。
- 生产接入、灰度、部署分别标明状态，不混为一谈。
