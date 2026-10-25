# 事故交接：一次权限异常导致 config.json 被静默清空

> 交接背景：部署 sticker 修复时，配置被覆盖成出厂默认值，服务中断约 9 分钟。
> 本文只描述**代码缺陷与修复要点**，供接手者独立判断。运维侧已恢复，不需要重做。

---

## 一、结论先说

这不是"操作失误"，而是 `loadConfig()` 的**错误处理把"读不到"伪装成了"没配过"**，
再由自动持久化把这份空配置写回磁盘，形成**静默的数据销毁**。

任何能让配置读取失败一次的情况都会触发同一条链：
一次误 `chown`、磁盘满、手滑改坏 JSON、编辑器留下半截文件、NFS 挂载抖动。

---

## 二、事故链（按时间顺序，已由日志证实）

### 1. 写出的文件属主错了

部署脚本以 root 运行，`config-legacy.js:853-856` 的写盘逻辑：

```js
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
const tmp = `${CONFIG_FILE}.tmp`;
fs.writeFileSync(tmp, JSON.stringify(currentConfig, null, 2), { mode: 0o600 });
fs.renameSync(tmp, CONFIG_FILE);
```

以 root 执行 → 得到 `root:root 600` 的 `config.json`。
服务进程以 admin 身份运行 → **无权读取**。

### 2. 读失败被吞掉，替换成出厂默认值

`src/config-legacy.js:441-449`：

```js
export function loadConfig() {
  try {
    let text = fs.readFileSync(CONFIG_FILE, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = migrateConfig(JSON.parse(text));
    return deepMerge(DEFAULT_CONFIG, parsed);
  } catch {
    return structuredClone(DEFAULT_CONFIG);   // ← 任何错误都走这里
  }
}
```

`catch` 不区分错误类型。`EACCES`（没权限）、`EISDIR`、`JSON.parse` 语法错误、
磁盘 I/O 错误，**全部返回出厂默认配置**——而 `DEFAULT_CONFIG` 里恰好是：

| 字段 | 默认值 | 位置 |
|---|---|---|
| `api.apiKey` | `''` | `config-legacy.js:27` |
| `api.model` | `''` | `config-legacy.js:28` |
| `onebot.accessToken` | `''` | `config-legacy.js:117` |
| `server.token` | `''` | `config-legacy.js:363` |
| `admin.ownerUin` | `''` | 由 `applyStableFeaturePolicy()` 补齐（`stable-feature-policy.js`，`DEFAULT_CONFIG` 里本无 `admin` 段） |

即：**空凭据、空模型、空管理员**。

### 3. 自动持久化把空配置写回磁盘

`src/config.js:131-139`：

```js
export function getConfig() {
  const config = legacy.getConfig();
  if (runtimeOverrideActive) {
    return withGlobalBlocklistRuntimeView(config);
  }
  return withGlobalBlocklistRuntimeView(
    stabilize(config, { persist: true })     // ← persist: true
  );
}
```

`stabilize()` 在 `config.js:58-60` 发现策略指纹变化就调用 `scheduleSecureConfigSave()`，
延迟 400ms 后把**当前内存里的这份空配置**写盘。

此时进程是 admin、目录可写 → **写入成功，真实配置被永久覆盖**。

### 4. 旁证日志

```
Oct 25 14:54:16 node[205388]: [config] 修正配置文件权限失败: Error: EPERM: operation not permitted,
  chmod '/mnt/data/qq-agent/data/config.json'
    at hardenConfigPermissions (file:///mnt/data/qq-agent/app/src/config.js:28:8)
    at scheduleSecureConfigSave (file:///mnt/data/qq-agent/app/src/config.js:41:3)
    at stabilize (file:///mnt/data/qq-agent/app/src/config.js:59:5)
    at getConfig (file:///mnt/data/qq-agent/app/src/config.js:137:5)
```

`EPERM on chmod` 证明文件当时已不属于 admin；随后 19 秒文件被重写为 `admin:admin 600`
的空配置（mtime `14:54:19`）。

### 5. 后果

- OneBot 全部请求 **HTTP 403**（token 与 NapCat 不匹配），每 3 秒重试一次
- 模型显示"（未设置）"
- `runtime.mode` 从 `active` 掉回 `observe`
- `admin.ownerUin` 清空 → 管理员权限失效
- `allow.groups` / `allow.private` 清空 → 群 575164125 失联

---

## 三、修复要点（建议顺序）

### P0：`loadConfig` 区分错误类型

只有 `ENOENT`（**首次启动、确实没有配置文件**）可以退回 `DEFAULT_CONFIG`。
其余情况必须抛错，或进入**只读降级模式**——但绝不能返回默认值。

```js
export function loadConfig() {
  try {
    let text = fs.readFileSync(CONFIG_FILE, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return deepMerge(DEFAULT_CONFIG, migrateConfig(JSON.parse(text)));
  } catch (error) {
    if (error?.code === 'ENOENT') return structuredClone(DEFAULT_CONFIG);
    throw new ConfigReadError(CONFIG_FILE, error);   // 不许静默吞
  }
}
```

注意：直接抛错会让服务**起不来**。若产品上需要"带病启动"，
应改为降级模式（见下条）而不是回退默认值。

### P0：降级模式必须禁止写盘

引入一个进程级标记（如 `configWriteBlocked`）。
一旦读取不健康，`scheduleConfigSave()` 与所有 `persist` 路径**整体短路**，
宁可本次运行改不了配置，也不能覆盖磁盘上的真实配置。

`config-legacy.js:896-909` 的 `scheduleConfigSave()` 是最后的写盘出口，
在这里做总闸门最稳：

```js
export function scheduleConfigSave() {
  if (configWriteBlocked) {
    console.error('[config] 配置处于降级只读模式，已跳过写盘');
    return;
  }
  ...
}
```

### P1：`chmod` 失败不能只打日志

`src/config.js:26-34`：

```js
function hardenConfigPermissions() {
  try {
    fs.chmodSync(legacy.CONFIG_FILE, 0o600);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.error('[config] 修正配置文件权限失败:', error);   // ← 只打日志就继续了
    }
  }
}
```

`EPERM` / `EACCES` 说明**属主不对**，这正是本次事故的第一现场。
应升级为致命错误或触发降级模式，而不是继续跑。

### P1：写盘前守卫，拒绝"用空覆盖非空"

在 `config-legacy.js:853` 附近，真正 `renameSync` 之前加一道检查：

- 新配置的 `onebot.accessToken` 与 `api.model` 同时为空，
- 且磁盘上现有文件里这两项**非空**，
- → 拒绝写入，保留旧文件，记错误日志。

这条是最后一道防线：即使前面的判断都失效，也不会把好配置冲掉。

### P2：补充测试

`test/config.test.mjs` 目前只覆盖正常路径（见文件开头 `mkdtempSync` + 正常 JSON 写入）。
至少补两类：

1. **`EACCES` 场景**：配置存在但不可读 → 断言不返回 `DEFAULT_CONFIG`，且**磁盘文件未被改动**
2. **坏 JSON 场景**：写入 `{invalid` → 断言不静默返回默认值，不覆盖原文件

---

## 四、给接手者的关键约束

- `config-legacy.js` 是**数据格式兼容层**，`config.js` 是生产适配层。
  写盘出口在 legacy（`853-856`、`896-909`），策略/持久化触发在 `config.js`（`50-62`、`131-139`）。
- `getConfig()` 带 `persist: true` 是**读路径会写盘**，改动时注意副作用。
- `test/config.test.mjs` 用 `QQ_AGENT_DATA_DIR` 重定向数据目录，测试不会碰真实配置。
- 不要用"读失败就返回默认值"的方式实现容错——本事故证明它等价于数据销毁。

---

## 五、当前生产状态（已验证，无需重做）

| 项 | 状态 |
|---|---|
| 服务 | `active (running)`，PID 206411 |
| 错误 | 新进程 **0 个 403、0 个错误** |
| 模型 | `clinepass/cline-pass/deepseek-v4.1-flash-1017` 正常加载 |
| OneBot token | 已恢复，sha1 `c5aa5c3b92`（与 NapCat 配置一致） |
| 控制台 token | 已恢复，sha1 `1e7b27e324` |
| 管理员 / 允许群 | `2681173403` / `['575164125']` |
| 属主权限 | 全部 `admin:admin 600`，data 目录无 root 残留 |
| 表情发送 | 实测 `retcode=0` |

损坏的配置备份：`/mnt/data/qq-agent/backups/config-broken-20261025-145749.json`
