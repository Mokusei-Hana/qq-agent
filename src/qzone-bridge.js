// QQ 空间桥接客户端：对接 onebot-qzone（https://github.com/Gu-Heping/onebot-qzone）。
//
// SnowLuma 曾提供 get_qzone_msg_list / get_qzone_feeds / send_qzone_msg /
// like_qzone / comment_qzone 等扩展 API，NapCat 没有这些接口。
// 这里把 qq-agent 需要的动作翻译成 onebot-qzone 的标准动作，并统一字段名，
// 让每日动态和动态互动不必关心底层协议端。
import { getConfig } from './config.js';

const DEFAULT_BASE_URL = 'http://127.0.0.1:5700';
const DEFAULT_TIMEOUT_MS = 30000;

function numberOr(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function qzoneBridgeSettings(raw = getConfig().qzoneBridge || {}) {
  const baseUrl = String(raw.baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  return {
    enabled: raw.enabled === true && Boolean(baseUrl),
    baseUrl,
    accessToken: String(raw.accessToken || ''),
    timeoutMs: Math.min(120000, Math.max(5000, numberOr(raw.timeoutMs, DEFAULT_TIMEOUT_MS)))
  };
}

export class QzoneBridgeError extends Error {
  constructor(message, { action = '', retcode = null, httpStatus = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'QzoneBridgeError';
    this.action = action;
    this.retcode = retcode;
    this.httpStatus = httpStatus;
  }
}

function picUrl(entry) {
  if (typeof entry === 'string') return entry;
  return String(entry?.url2 || entry?.url3 || entry?.url1 || entry?.url || '');
}

function pictureUrls(item) {
  const list = Array.isArray(item?.pics) ? item.pics : (Array.isArray(item?.pic) ? item.pic : []);
  return list.map(picUrl).filter((url) => /^https?:\/\//i.test(url));
}

// 黄钻/会员广告等第三方动态也会出现在自己的说说列表里（appid=333），只保留说说本体。
function isTimelinePost(item) {
  const appid = item?.appid;
  return appid == null || appid === '' || Number(appid) === 311;
}

function mapMoment(item) {
  return {
    tid: String(item?.tid || ''),
    uin: String(item?.uin || ''),
    nickname: String(item?.nickname || ''),
    content: String(item?.content || ''),
    time: numberOr(item?.created_time ?? item?.createdTime ?? item?.time),
    comment_num: numberOr(item?.cmtnum ?? item?.comment_num),
    images: pictureUrls(item),
    isLiked: item?.isLiked === true
  };
}

function mapFeedPost(item) {
  return {
    tid: String(item?.tid || ''),
    uin: String(item?.uin || ''),
    nickname: String(item?.nickname || ''),
    time: numberOr(item?.createdTime ?? item?.created_time ?? item?.time),
    appid: numberOr(item?.appid, 311),
    content: String(item?.content || ''),
    images: pictureUrls(item),
    comments: [],
    isLiked: item?.isLiked === true,
    likeCount: numberOr(item?.likenum ?? item?.likeCount)
  };
}

function mapComment(raw, parentTid = '') {
  const commentId = String(raw?.commentId ?? raw?.commentid ?? raw?.comment_id ?? '');
  if (!commentId) return null;
  return {
    commentId,
    tid: commentId,
    parentTid: String(parentTid || ''),
    uin: String(raw?.uin || ''),
    nickname: String(raw?.nickname || raw?.name || ''),
    content: String(raw?.content || ''),
    targetUin: String(raw?.replyToUin || ''),
    targetName: String(raw?.replyToNickname || ''),
    time: numberOr(raw?.createdTime ?? raw?.created_time)
  };
}

export function mapBridgeComments(list = []) {
  const comments = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const root = mapComment(raw);
    if (!root) continue;
    comments.push(root);
    for (const reply of Array.isArray(raw?.replies) ? raw.replies : []) {
      const child = mapComment(reply, root.commentId);
      if (child) comments.push(child);
    }
  }
  return comments;
}

export class QzoneBridgeClient {
  constructor({ fetchImpl = fetch, config = getConfig } = {}) {
    this.fetch = fetchImpl;
    this.config = config;
  }

  get settings() {
    return qzoneBridgeSettings(this.config().qzoneBridge || {});
  }

  get enabled() {
    return this.settings.enabled;
  }

  async #call(action, params = {}, { timeoutMs, signal } = {}) {
    const settings = this.settings;
    const timeout = Math.min(120000, Math.max(1000, numberOr(timeoutMs, settings.timeoutMs)));
    const res = await this.fetch(`${settings.baseUrl}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(settings.accessToken ? { authorization: `Bearer ${settings.accessToken}` } : {})
      },
      body: JSON.stringify(params),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeout)])
        : AbortSignal.timeout(timeout)
    });
    if (!res.ok) {
      throw new QzoneBridgeError(`QzoneBridge ${action} HTTP ${res.status}`, {
        action,
        httpStatus: res.status
      });
    }
    let body;
    try {
      body = await res.json();
    } catch (cause) {
      throw new QzoneBridgeError(`QzoneBridge ${action} 返回了无法解析的响应`, {
        action,
        httpStatus: res.status,
        cause
      });
    }
    if (body?.status !== 'ok' && body?.retcode !== 0) {
      throw new QzoneBridgeError(
        `QzoneBridge ${action} 失败: retcode=${body?.retcode ?? body?.status ?? '?'} ${body?.message || body?.wording || ''}`.trim(),
        { action, retcode: body?.retcode ?? body?.status ?? null, httpStatus: res.status }
      );
    }
    return body?.data;
  }

  /** 自己的说说列表，字段与 SnowLuma get_qzone_msg_list 对齐。 */
  async getMoments({ num = 30, pos = 0, signal } = {}) {
    const data = await this.#call('get_emotion_list', {
      pos,
      num,
      max_pages: 3,
      include_image_data: false
    }, { timeoutMs: 30000, signal });
    const list = Array.isArray(data?.msglist) ? data.msglist : [];
    return { msglist: list.filter(isTimelinePost).map(mapMoment) };
  }

  /** 好友动态列表，直接返回 qq-agent 内部使用的动态结构。 */
  async getFeedPosts({ count = 30, signal } = {}) {
    const data = await this.#call('get_friend_feeds', {
      count,
      num: count,
      fast_mode: 1,
      include_image_data: false
    }, { timeoutMs: 45000, signal });
    const list = Array.isArray(data?.msglist) ? data.msglist : [];
    return list.map(mapFeedPost).filter((post) => post.tid && post.uin);
  }

  /** 发布说说。图片使用 base64:// 或公网 URL，桥接会自行上传。 */
  async publishMoment(content, { images = [], ugcRight, signal } = {}) {
    const message = [{ type: 'text', data: { text: String(content || '') } }];
    for (const image of Array.isArray(images) ? images : []) {
      const file = String(image || '').trim();
      if (!file) continue;
      message.push({ type: 'image', data: { file } });
    }
    const params = { message };
    if (Number.isFinite(Number(ugcRight)) && Number(ugcRight) > 0) {
      params.who_can_see = Number(ugcRight);
    }
    const data = await this.#call('send_msg', params, { timeoutMs: 90000, signal });
    return {
      tid: String(data?.tid || data?.message_id || ''),
      pic_ids: Array.isArray(data?.pic_ids) ? data.pic_ids : [],
      ...data
    };
  }

  /** 读取某条说说的评论树。 */
  async getComments({ uin, tid, num = 30, pos = 0, signal } = {}) {
    const data = await this.#call('get_comment_list', {
      tid,
      user_id: uin,
      num,
      pos,
      fast_mode: 1
    }, { timeoutMs: 45000, signal });
    const list = Array.isArray(data?.comments) ? data.comments
      : (Array.isArray(data?.commentlist) ? data.commentlist : []);
    const comments = mapBridgeComments(list);
    return {
      comments,
      commentCount: numberOr(data?.comment_num ?? data?.cmtnum, comments.length)
    };
  }

  async likePost({ uin, tid, abstime, signal } = {}) {
    return this.#call('send_like', {
      tid,
      user_id: uin,
      abstime: numberOr(abstime)
    }, { timeoutMs: 30000, signal });
  }

  async commentPost({ uin, tid, content, signal } = {}) {
    const data = await this.#call('send_comment', {
      target_tid: tid,
      target_uin: uin,
      content
    }, { timeoutMs: 45000, signal });
    return { commentId: String(data?.comment_id || '') };
  }

  async replyComment({ uin, tid, comment, rootComment, content, signal } = {}) {
    const root = rootComment || comment || {};
    const params = {
      target_tid: tid,
      target_uin: uin,
      content
    };
    const replyId = String(root.tid || root.commentId || '');
    if (replyId) params.reply_comment_id = replyId;
    if (root.uin) params.reply_uin = String(root.uin);
    const data = await this.#call('send_comment', params, { timeoutMs: 45000, signal });
    return { commentId: String(data?.comment_id || '') };
  }
}
