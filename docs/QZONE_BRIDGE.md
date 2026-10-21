# QQ 空间桥接（onebot-qzone）

qq-agent 的空间功能原本依赖 SnowLuma 的扩展动作：

```text
get_qzone_msg_list   自己的说说 + 评论计数
get_qzone_feeds      好友动态
send_qzone_msg       发布说说
like_qzone           点赞
comment_qzone        评论 / 二级回复
```

NapCat 只实现标准 OneBot v11，这些动作会返回
`retcode=200 不支持的Api ...`。启用 `qzoneBridge` 后，空间相关请求改由独立的
[onebot-qzone](https://github.com/Gu-Heping/onebot-qzone) 桥接处理，聊天收发仍走
NapCat，两者互不影响。

## 配置

`config.json`：

```json
"qzoneBridge": {
  "enabled": true,
  "baseUrl": "http://127.0.0.1:5700",
  "accessToken": "桥接的 ONEBOT_ACCESS_TOKEN",
  "timeoutMs": 30000
}
```

关闭时（默认）继续调用 OneBot 端的 SnowLuma 动作。运行中改开关不需要重启，
下一次空间任务就会按新值选择通道。

## 动作对应关系

| qq-agent 需要 | onebot-qzone 动作 |
| --- | --- |
| 自己的说说列表 | `get_emotion_list`（过滤 appid=333 的黄钻广告） |
| 好友动态 | `get_friend_feeds` |
| 发布说说 | `send_msg`（文本 + `base64://` 图片段 + `who_can_see`） |
| 点赞 | `send_like` |
| 评论 | `send_comment` |
| 二级回复 | `send_comment` + `reply_comment_id` / `reply_uin` |
| 评论树 | `get_comment_list` |

桥接返回的是归一化字段（`tid` / `createdTime` / `cmtnum` / `pics`），
`src/qzone-bridge.js` 会转换成 qq-agent 内部结构（`time` / `comment_num` /
`images` / `comments`），所以上层逻辑不用区分协议端。

## 登录与 Cookie

桥接是独立进程，需要自己的 QQ 空间 Cookie。推荐直接从 NapCat 取：NapCat 的
`get_cookies` 对 `user.qzone.qq.com` 返回同一账号的 `uin` / `skey` / `p_skey`，
把它交给桥接的 `login_cookie` 或 `update_cookie` 即可，无需扫码。

`update_cookie` 会把新 Cookie 写回桥接的 `.env`（文件权限 600）。建议用 systemd
timer 定时同步，避免 NapCat 轮换 `p_skey` 后桥接失效。

## 已知差异

- 好友动态不带内嵌评论区，评论树统一由 `get_comment_list` 读取；较旧的说说可能
  无法取到评论详情（桥接返回 `availability=not_embedded`），此时只更新评论计数。
- `target_uins`（部分可见名单）桥接不支持，`visibility=16/128` 时只传可见范围值。
- 桥接的 `tid` 可能是复合键（如 `333_054c3c2e_...`），必须原样回传给桥接，
  不要再拼进 `topicId` 等 PC 接口参数。
