import { adminOwnerUin, getConfig, updateConfig } from './config.js';
import { assertCanSend } from './access.js';

const MAX_DURATION = 30 * 24 * 60 * 60;
const id = (value) => typeof value === 'string' && /^[1-9]\d{4,14}$/.test(value)
  ? value : (typeof value === 'number' && Number.isSafeInteger(value) && value >= 10000
    && value < 1e15 ? String(value) : '');
const failure = (code, message, outcome = 'failed') => ({
  isError: true, errorCode: code, outcome, content: `错误：${message}`
});

// A narrow command grammar binds the action as well as the sender. Quoted,
// forwarded, ambiguous or conversational text must not confer ambient authority.
function commandText(entry, selfId) {
  if (!entry || entry.self || (entry.eventKind && entry.eventKind !== 'message') || !id(entry.senderId)) return '';
  let text = String(entry.text || '').trim();
  if (id(selfId)) {
    text = text.replace(new RegExp(`^@(?:[^()\\r\\n]*\\(${selfId}\\)|${selfId}(?!\\d))\\s*`), '');
  }
  return text;
}

export function autonomousBanEnabled(groupId, cfg = getConfig()) {
  return Boolean(id(adminOwnerUin(cfg))) && cfg.groupModeration?.pausedGroups?.[groupId] !== true;
}

export function applyOwnerModerationControl(entry, chatKey, selfId = '') {
  if (!/^group:[1-9]\d{4,14}$/.test(chatKey) || id(entry?.senderId) !== adminOwnerUin(getConfig())) return false;
  const command = /^(暂停|停止|恢复|开启)自主禁言[。！!\s]*$/.exec(commandText(entry, selfId));
  if (!command) return false;
  const groupId = chatKey.slice(6);
  updateConfig({ groupModeration: { pausedGroups: {
    ...(getConfig().groupModeration?.pausedGroups || {}),
    [groupId]: ['暂停', '停止'].includes(command[1])
  } } });
  return true;
}

export function parseModerationRequest(entry, selfId = '') {
  let text = commandText(entry, selfId);
  if (!text) return null;
  const notice = /^(?:发布|发送)群公告[：:]\s*([\s\S]{1,2000})$/.exec(text);
  if (notice?.[1].trim()) return { requesterId: id(entry.senderId), noticeContent: notice[1].trim() };
  text = text.replace(/^(?:这只是测试|这是测试|测试一下)[，,：:\s]*/, '')
    .replace(/[，,。\s]*(?:这只是测试|这是测试|测试一下)[。！!\s]*$/, '')
    .replace(/^(?:请帮我|帮我|麻烦|请)\s*/, '').replace(/[。！!\s]+$/, '');
  const target = '(?:@[^()\\r\\n]+\\(([1-9]\\d{4,14})\\)|@?([1-9]\\d{4,14}))';
  let match = text.match(new RegExp(`^(?:把\\s*)?${target}\\s*(?:禁言)\\s*(\\d+)\\s*(秒钟?|分钟?|小时|天)$`))
    || text.match(new RegExp(`^禁言\\s*${target}\\s*(\\d+)\\s*(秒钟?|分钟?|小时|天)$`));
  if (match) {
    const scale = /^(秒)/.test(match[4]) ? 1 : /^分/.test(match[4]) ? 60 : match[4] === '小时' ? 3600 : 86400;
    const duration = Number(match[3]) * scale;
    if (!Number.isSafeInteger(duration) || duration < 0 || duration > MAX_DURATION) return null;
    return { requesterId: id(entry.senderId), userId: match[1] || match[2], duration };
  }
  match = text.match(new RegExp(`^(?:解除禁言|解禁)\\s*${target}$`))
    || text.match(new RegExp(`^(?:把\\s*)?${target}\\s*(?:解除禁言|解禁)$`))
    || text.match(new RegExp(`^解除\\s*${target}\\s*的?禁言$`));
  return match ? { requesterId: id(entry.senderId), userId: match[1] || match[2], duration: 0 } : null;
}

export function moderationRequest(entries, { proactive = false, manual = false, selfId = '' } = {}) {
  if (proactive || manual || !Array.isArray(entries) || entries.length !== 1) return null;
  return parseModerationRequest(entries[0], selfId);
}

export function moderationRequesterId(entries, { proactive = false, manual = false } = {}) {
  return moderationRequest(entries, { proactive, manual })?.requesterId || '';
}

async function member(ctx, groupId, userId) {
  const info = await ctx.onebot.call('get_group_member_info', {
    group_id: groupId, user_id: userId, no_cache: true
  }, 15000, ctx.signal);
  if (id(info?.user_id) !== userId || id(info?.group_id) !== groupId
    || !['member', 'admin', 'owner'].includes(info?.role)) {
    throw new Error('Invalid group member response');
  }
  return info;
}

export function groupBanTool() {
  return {
    name: 'set_group_ban',
    description: '当前群禁言。可自行决定短暂禁言（含日常斗嘴），自主禁言默认60秒且最多60秒，不得操作主人、群主或管理员；暂停时不可自主禁言。明确管理员指令仍须匹配原目标及秒数；0为解除禁言，仅按授权指令执行。只有success=true才可说成功，unknown禁止重试。',
    parameters: {
      type: 'object',
      properties: {
        group_id: { type: 'string', description: '可省略；若填写只能是当前群号' },
        user_id: { type: 'string', description: '目标成员的真实 QQ 号，不是消息 id 或名字' },
        duration: { type: 'integer', minimum: 0, maximum: MAX_DURATION, default: 60, description: '禁言秒数，默认60；自主最多60；0仅按授权指令解除禁言' }
      },
      required: ['user_id'],
      additionalProperties: false
    },
    async execute(ctx, args) {
      const duration = args?.duration === undefined ? 60 : args.duration;
      const groupId = id(ctx.chatId);
      const userId = id(args?.user_id);
      if (ctx.kind !== 'group' || !groupId || ctx.chatKey !== `group:${groupId}`) {
        return failure('GROUP_ONLY', '此工具只能在当前群会话使用');
      }
      if (!args || typeof args !== 'object' || Array.isArray(args)
        || Object.keys(args).some((key) => !['group_id', 'user_id', 'duration'].includes(key))
        || !userId || (args.group_id !== undefined && id(args.group_id) !== groupId)
        || !Number.isInteger(duration) || duration < 0 || duration > MAX_DURATION) {
        return failure('INVALID_ARGUMENTS', '须提供有效目标 QQ 号和 0–2592000 的整数秒数；不允许跨群或传入身份参数');
      }
      const request = ctx.moderationRequest?.noticeContent === undefined ? ctx.moderationRequest : null;
      const autonomous = !request;
      const requesterId = id(request?.requesterId);
      const ownerId = adminOwnerUin(getConfig());
      if (autonomous && (!ctx.autonomousModerationAllowed || !autonomousBanEnabled(groupId))) {
        return failure('UNAUTHORIZED', '自主禁言已暂停或本次运行未获授权');
      }
      if (autonomous && (duration < 1 || duration > 60)) {
        return failure('INVALID_ARGUMENTS', '自主禁言仅允许1到60秒；解除禁言需真实管理员明确指令');
      }
      if (!autonomous && !requesterId) return failure('UNAUTHORIZED', '没有唯一可信的本次请求者；请管理员单独发送请求');
      if (!autonomous && (request.userId !== userId || request.duration !== duration)) {
        return failure('REQUEST_MISMATCH', '目标和秒数必须与本次独立管理请求一致，不得借用其他消息的授权');
      }
      if (!id(ctx.selfId) || userId === String(ctx.selfId) || userId === ownerId) {
        return failure('PROTECTED_TARGET', '不能操作机器人自身或配置主人');
      }
      let operationId;
      try {
        assertCanSend(ctx.chatKey, ctx.signal);
        let requesterRole = 'owner';
        if (!autonomous && requesterId !== ownerId) {
          const requester = await member(ctx, groupId, requesterId);
          if (!['admin', 'owner'].includes(requester.role)) {
            return failure('UNAUTHORIZED', '请求者不是配置主人或当前群管理员/群主');
          }
          requesterRole = requester.role;
        }
        const bot = await member(ctx, groupId, id(ctx.selfId));
        if (!['admin', 'owner'].includes(bot.role)) {
          return failure('BOT_PERMISSION_DENIED', '机器人没有当前群的管理权限');
        }
        const target = await member(ctx, groupId, userId);
        if (target.role === 'owner' || (target.role === 'admin'
          && (autonomous || bot.role !== 'owner' || requesterRole !== 'owner'))) {
          return failure('TARGET_PERMISSION_DENIED', '请求者或机器人权限不足以操作该群主/管理员');
        }
        // Reuse the durable external-write outbox and its operator reconciliation UI.
        // Any unresolved group moderation write blocks further automatic writes.
        const unresolved = ctx.store.listUnknownOperations(ctx.chatKey, 500);
        if (unresolved.length >= 500 || unresolved.some((row) => row.payload?.type === 'group_ban')) {
          return failure('UNKNOWN_PREVIOUS_OPERATION', '此前群管理操作结果未知，须人工核对后再操作；禁止自动重试', 'unknown');
        }
        const key = `${groupId}:${userId}:${duration}`;
        const results = ctx.session.groupModerationResults ||= new Map();
        if (results.has(key)) return results.get(key);
        assertCanSend(ctx.chatKey, ctx.signal);
        if (autonomous && !autonomousBanEnabled(groupId)) return failure('UNAUTHORIZED', '主人已暂停自主禁言');
        operationId = ctx.store.beginSend(ctx.chatKey, ctx.session.leaseId, {
          type: 'group_ban', groupId, userId, duration, requesterId, autonomous
        });
        // A pending marker also prevents duplicate calls if the outer run is aborted.
        results.set(key, failure('OPERATION_PENDING', '操作已提交，结果尚未确认；禁止重试', 'unknown'));
        let result;
        try {
          await ctx.onebot.call('set_group_ban', {
            group_id: groupId, user_id: userId, duration
          }, 15000, ctx.signal);
          ctx.store.finishSend(operationId, {});
          result = { content: JSON.stringify({ success: true, group_id: groupId,
            user_id: userId, duration }) };
        } catch (error) {
          const outcome = error?.outcome === 'failed' ? 'failed' : 'unknown';
          // Persist only structured error metadata, never provider wording/messages.
          const detail = JSON.stringify({ outcome, retcode: error?.retcode ?? null,
            httpStatus: error?.httpStatus ?? null });
          ctx.store.finishSend(operationId, { error: detail, outcome });
          result = failure('ONEBOT_ACTION_FAILED', outcome === 'unknown'
            ? 'NapCat 操作结果未知，不能宣称成功；请人工核对，禁止自动重试'
            : `NapCat 拒绝操作（retcode=${error?.retcode ?? 'unknown'}）；请检查机器人权限及目标状态`, outcome);
        }
        results.set(key, result);
        return result;
      } catch {
        return failure('MODERATION_CHECK_FAILED', operationId
          ? '操作记录未能确认，请人工核对；禁止重试'
          : '权限/成员查询或运行状态检查失败，未执行禁言', operationId ? 'unknown' : 'failed');
      }
    }
  };
}

export function groupNoticeTool() {
  return {
    name: 'send_group_notice',
    description: '发布当前群的纯文字公告。仅按本次独立授权请求的原文发布；必须验证请求者及机器人群角色，但角色不保证公告权限，NapCat仍可能拒绝。只有success=true可说成功，结果unknown须人工核对，禁止重试。',
    parameters: { type: 'object', properties: { content: { type: 'string', minLength: 1, maxLength: 2000 } },
      required: ['content'], additionalProperties: false },
    async execute(ctx, args) {
      const groupId = id(ctx.chatId);
      const request = ctx.moderationRequest;
      if (ctx.kind !== 'group' || !groupId || ctx.chatKey !== `group:${groupId}`) return failure('GROUP_ONLY', '只能发布当前群公告');
      if (typeof args?.content !== 'string' || !args.content.trim() || args.content.length > 2000
        || Object.keys(args).some((key) => key !== 'content')) return failure('INVALID_ARGUMENTS', '公告须为1到2000字的原文');
      if (!id(request?.requesterId) || request.noticeContent !== args.content) return failure('UNAUTHORIZED', '没有匹配本次真实发送者的明确公告请求');
      let operationId;
      try {
        assertCanSend(ctx.chatKey, ctx.signal);
        if (request.requesterId !== adminOwnerUin(getConfig())) {
          const requester = await member(ctx, groupId, request.requesterId);
          if (!['admin', 'owner'].includes(requester.role)) return failure('UNAUTHORIZED', '发布请求者没有管理权限');
        }
        const bot = await member(ctx, groupId, id(ctx.selfId));
        if (!['admin', 'owner'].includes(bot.role)) return failure('BOT_PERMISSION_DENIED', '机器人没有群管理权限，不能发布公告');
        const unresolved = ctx.store.listUnknownOperations(ctx.chatKey, 500);
        if (unresolved.length >= 500 || unresolved.some((row) => row.payload?.type === 'group_notice')) {
          return failure('UNKNOWN_PREVIOUS_OPERATION', '此前公告发布结果未知，须人工核对，禁止重试', 'unknown');
        }
        const results = ctx.session.groupNoticeResults ||= new Map();
        if (results.has(args.content)) return results.get(args.content);
        assertCanSend(ctx.chatKey, ctx.signal);
        operationId = ctx.store.beginSend(ctx.chatKey, ctx.session.leaseId, {
          type: 'group_notice', groupId, content: args.content, requesterId: request.requesterId
        });
        results.set(args.content, failure('OPERATION_PENDING', '公告已提交但结果未确认，禁止重试', 'unknown'));
        let result;
        try {
          await ctx.onebot.call('_send_group_notice', { group_id: groupId, content: args.content }, 15000, ctx.signal);
          ctx.store.finishSend(operationId, {});
          result = { content: JSON.stringify({ success: true, group_id: groupId }) };
        } catch (error) {
          const outcome = error?.outcome === 'failed' ? 'failed' : 'unknown';
          ctx.store.finishSend(operationId, { error: JSON.stringify({ outcome, retcode: error?.retcode ?? null }), outcome });
          result = failure('ONEBOT_ACTION_FAILED', outcome === 'unknown'
            ? '公告发布结果未知，请人工核对，禁止重试'
            : `NapCat拒绝发布公告（retcode=${error?.retcode ?? 'unknown'}），请检查实际公告权限`, outcome);
        }
        results.set(args.content, result);
        return result;
      } catch {
        return failure('NOTICE_CHECK_FAILED', operationId ? '公告记录未确认，请人工核对，禁止重试' : '权限或运行状态检查失败，未发布公告', operationId ? 'unknown' : 'failed');
      }
    }
  };
}
