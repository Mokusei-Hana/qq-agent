# 人格自我迭代：审计、接口与运维

## 基线与复用审计（2026-10-31）

开发基线来自实际生产 `/mnt/data/qq-agent/app`，而非本机旧分支。
服务器当时没有 `.git`；代码快照已推送为
`backup/server-before-personality-20261031`，提交
`ac601697a374f94c3d6faf794ecd55d73069fc17`。
开发位于独立本机副本的 `feature/personality-self-evolution`。

| 能力 | 已有实现 | 本次处理 |
| --- | --- | --- |
| 黑话采集、研究与审核 | `slang-learning.js` / `slang-learning-research.js` / `slang-learning-store.js`，独立 SQLite、授权群、异步 worker、模型预算 | 完整保留，不建立第二套词库，不恢复已下线的 `slang-pilot.js` |
| 黑话检索 | `SlangLearning.query/context`，人工确认的 `slang.json`，已集成 orchestrator | 原样复用回复上下文，与表达偏好分别提供 |
| 确认发送结果 | `sender.js` 的 `onSent`，提供原生 messageId | 回调中提取轻量特征后排队；不重试发送，不观察未知投递结果 |
| 群授权 | `access.js` 的 `chatAllowed` | 人格授权群必须同时满足现有访问控制 |
| 已有消息上下文 | `ChatStore.recent` 和本轮 triggerEntries | 只临时读取最近互动特征，不复制原文到人格库 |
| SQLite 约定 | `node:sqlite` DatabaseSync，独立模块数据库、WAL、事务、毫秒时间戳 | 使用独立 `personality-learning.sqlite`，版本 1 的加表迁移，不碰已有数据库 |
| 后台调度 | 无通用任务注册器；orchestrator 有 5 秒恢复循环 | 复用循环调用 maintenance；内部 30 分钟统计、每日清理、每周优化，不增加进程或 timer |
| 模型封装 | `llm.js` / 黑话研究独立模型调用 | 本版本无需额外模型调用；复杂语义评价由人工反馈负责 |
| 控制台授权 | app 的 authorize、同源校验、全局管理员配置 | API 使用相同认证；管理写操作还要求已配置管理员 |
| 生命周期缓存 | promptPrefixHash | 动态模式的场景、版本或预算改变时重建生命周期前缀，避免旧偏好在回滚后继续留在 transcript 中 |

## 模块边界

`src/personality-learning.js` 独立拥有设置校验、观察、分析、质量特征、
候选、审批、版本、回滚和保留策略。它不导入配置模块，不读取或修改
核心人设、安全权限、工具说明、黑话数据库或词条文件。

独立设置文件为 `data/personality-learning.json`，避免启用人格学习时
重写既有 `config.json`。已有设置无效时拒绝覆盖，不返回默认值写盘。
新安装默认停用；从未启用不会创建数据库。停用会取消未落盘队列、
关闭数据库并停止维护；已存在的数据仍可通过只读连接查看。

观察仅来自已确认发送的文字回复和明确的成功不回复会话；相同群与
messageId 去重。表情、拍一拍、无 messageId 或发送结果未知不采集。
保存固定口头禅标签、长度、场景、开场/结构/n-gram 哈希、互动对象的群内哈希，
不保存聊天原文、姓名、模型输入或用户提供的规则文本。

确定性评价提供填充、重复、低落场景玩笑等可观察信号。相关性、事实正确性、
核心人格符合度不能由这些信号可靠判断，管理页明确标示并提供人工评价。
回复和点赞作为独立弱信号保存，不计为激活证据。

候选使用四类固定低风险策略：减少空洞填充、减少重复、低落时认真回应、
避免强行接话。不会生成新口头禅、复制群友表达或从聊天原文生成可执行指令。
手工纠正可禁用错误规则；本版本不接受任意文本作为生效人格规则。

## 设置与安全阈值

- `enabled`：独立运行开关；`graduated`：独立导航固化标志，二者分离。
- `groups`：明确授权的群 ID 数组，仍受机器人访问列表约束。
- `mode`：`observe`（默认）/ `dynamic`。
- `injectEnabled`、`autoApply`：独立开关，默认 false；观察模式禁止两者。
- 默认最低证据 20、置信度 0.85、真实观察跨度 7 天、3 个不同互动对象。
- 默认观察 TTL 30 天、偏好过期 60 天、最多 10,000 条观察和反馈。
- 每次分析最多 1,000 条；队列最多 200 条，溢出丢弃观察，不阻塞聊天。
- SQLite 忙等待上限 50ms；后台分析同步工作有记录上限，不增加同步模型调用。
- 注入默认最多 240 tokens，使用 UTF-8 字节数作为保守上界，只放完整策略。

观察产生 candidate；达到所有证据阈值后方可人工激活，自动激活还要求
dynamic + injectEnabled + autoApply。被禁用习惯不会自动恢复。
群级规则只用于本群；推广全局只能由控制台显式确认。反馈不能绕过策略检查。

## 接口

所有路由位于 `/api/personality-learning/`，沿用控制台身份验证。

| 方法/动作 | 参数/结果 |
| --- | --- |
| GET `status` | 设置、运行状态、当前版本、队列长度、错误及评估范围 |
| GET `data` | 有界的习惯、版本快照、反馈、观察分组统计与固定口头禅频次 |
| POST `settings` | 仅功能设置；切换模式、自动应用或固化需要 `confirm:true` |
| POST `analyze` | `confirm:true`；生成统计候选，不自动越权激活 |
| POST `habit` | `id,status(active/disabled),expectedVersion,confirm:true` |
| POST `global` | `id,expectedVersion,confirm:true`；推广已验证生效习惯 |
| POST `feedback` | `groupId,responseId,type,score(-1/0/1),confirm:true`；无规则输入 |
| POST `rollback` | `version,expectedVersion,confirm:true`；创建新的审计版本恢复动态层 |
| POST `cleanup` | `confirm:true`；仅清理到期观察/反馈并使旧习惯过期 |

独立管理页面：`/personality-learning.html`。实验设置页仅有启停、固化和页面链接。
固化前无顶层导航；固化后仍可单独停用并查看历史。

版本切换采用 BEGIN IMMEDIATE 事务和 expectedVersion 乐观检查。
每个版本保存完整生效习惯快照、证据统计、来源数量、时间范围、操作者和前版本。
回滚只切换动态层，不回滚或删除新消息、黑话知识或群友记忆。

## 验证结果与限制

- 本机 Node v24.20.0；全部测试使用临时 QQ_AGENT_DATA_DIR，安装器测试也使用隔离 HOME。
- 新人格专项/API/页面及已有 orchestrator：52 项通过，无失败或跳过。
- 覆盖重复口头禅、同义词替换约束、六类场景、群隔离、人工全局推广、污染、
  数据库锁、任务幂等、重启、关闭、版本事务及回滚、认证、同源、设置不改全局配置、
  页面输出转义与功能最小 patch。
- 完整 Windows 套件：419 项，372 通过、45 失败、2 跳过；主要涉及 Linux 权限、
  shell/systemd、SIGTERM、Windows 文件占用及 updater 路径。未将其报告为通过。
- 本机 WSL 因 HCS_E_HYPERV_NOT_INSTALLED 无法启动。用户明确授权不再阻塞于完整
  Linux 复测，要求做好回滚直接部署。本次未用生产环境替代测试。
- 队列压力测试 10,000 次调用约 4ms，其中 200 条接纳、其余按上限丢弃；
  SQLite（含 WAL）约 152KB。这是溢出保护的微基准，不能等同于正常流量端到端延迟。
  上线后的数据库增长和实际延迟仍需观察。
- 统计/策略和 prompt 约束已验证；真实模型输出是否减少填充、是否保持事实准确性
  尚无生产对照证据。初期仅观察，不声明表达质量已改善。

## 部署与关闭

部署必须使用已推送功能分支的准确 commit 和显式代码白名单，不运行安装器、
初始化器或 configure-linux.mjs。部署前制作受限代码/配置/SQLite 快照并记录
config.json 的 SHA-256、UID/GID、mode；重启后逐项检查保持不变。

第一阶段仅为已有明确授权采集的群开启 `enabled:true,mode:observe`，
`injectEnabled:false,autoApply:false,graduated:false`。不改 Bot 的 active/observe 模式，
不改其他设置。新数据库仅在启用时做本模块加表迁移。

至少积累默认 7 天跨度、20 条证据和 3 个不同对象，人工检查统计与候选后，
再在独立页面确认 dynamic 和 injectEnabled。低风险自动应用在更后阶段单独开放；
不能把刚部署后的健康检查当成长期学习质量验证。

关闭：在独立页面取消启用；保留所有数据。动态层回滚：在版本区选择旧版本，
确认后下一轮使用旧动态层；系统 prompt 和工具权限保持不变。

代码回滚使用部署生成的 `rollback.py`；它只恢复白名单中的原代码或删除本次明确
新增且仍与部署哈希一致的文件，不覆盖 data。回滚脚本发现代码已被别人改动则停止。
运行后重启 admin 的 qq-agent-linux.service，核对健康和配置指纹。
不得自动恢复旧配置或数据库；既有数据恢复必须另外确认。
