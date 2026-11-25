import { adminOwnerUin, getConfig } from './config.js';
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
export function parseModerationRequest(entry, selfId = '') {
  if (!entry || entry.self || (entry.eventKind && entry.eventKind !== 'message') || !id(entry.senderId)) return null;
  let text = String(entry.text || '').trim();
  if (id(selfId)) {
    text = text.replace(new RegExp(`^@(?:[^()\\r\\n]*\\(${selfId}\\)|${selfId}(?!\\d))\\s*`), '');
  }
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
    description: '禁言或解除禁言当前群的成员。只执行本次独立消息中明确指定的目标和时长，不能从旧消息借用权限或修改目标/时长；授权由程序校验（配置主人或当前群主/管理员）。duration 为秒，0 解除禁言，最大 2592000。只有返回 success=true 才能说成功；unknown 不得重试或声称成功。',
    parameters: {
      type: 'object',
      properties: {
        group_id: { type: 'string', description: '可省略；若填写只能是当前群号' },
        user_id: { type: 'string', description: '目标成员的真实 QQ 号，不是消息 id 或名字' },
        duration: { type: 'integer', minimum: 0, maximum: MAX_DURATION, description: '禁言秒数，0 表示解除禁言' }
      },
      required: ['user_id', 'duration'],
      additionalProperties: false
    },
    async execute(ctx, args) {
      const groupId = id(ctx.chatId);
      const userId = id(args?.user_id);
      if (ctx.kind !== 'group' || !groupId || ctx.chatKey !== `group:${groupId}`) {
        return failure('GROUP_ONLY', '此工具只能在当前群会话使用');
      }
      if (!args || typeof args !== 'object' || Array.isArray(args)
        || Object.keys(args).some((key) => !['group_id', 'user_id', 'duration'].includes(key))
        || !userId || (args.group_id !== undefined && id(args.group_id) !== groupId)
        || !Number.isInteger(args.duration) || args.duration < 0 || args.duration > MAX_DURATION) {
        return failure('INVALID_ARGUMENTS', '须提供有效目标 QQ 号和 0–2592000 的整数秒数；不允许跨群或传入身份参数');
      }
      const request = ctx.moderationRequest;
      const requesterId = id(request?.requesterId);
      const ownerId = adminOwnerUin(getConfig());
      if (!requesterId) return failure('UNAUTHORIZED', '没有唯一可信的本次请求者；请管理员单独发送请求');
      if (request.userId !== userId || request.duration !== args.duration) {
        return failure('REQUEST_MISMATCH', '目标和秒数必须与本次独立管理请求一致，不得借用其他消息的授权');
      }
      if (!id(ctx.selfId) || userId === String(ctx.selfId) || userId === ownerId) {
        return failure('PROTECTED_TARGET', '不能操作机器人自身或配置主人');
      }
      let operationId;
      try {
        assertCanSend(ctx.chatKey, ctx.signal);
        let requesterRole = 'owner';
        if (requesterId !== ownerId) {
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
          && (bot.role !== 'owner' || requesterRole !== 'owner'))) {
          return failure('TARGET_PERMISSION_DENIED', '请求者或机器人权限不足以操作该群主/管理员');
        }
        // Reuse the durable external-write outbox and its operator reconciliation UI.
        // Any unresolved group moderation write blocks further automatic writes.
        const unresolved = ctx.store.listUnknownOperations(ctx.chatKey, 500);
        if (unresolved.length >= 500 || unresolved.some((row) => row.payload?.type === 'group_ban')) {
          return failure('UNKNOWN_PREVIOUS_OPERATION', '此前群管理操作结果未知，须人工核对后再操作；禁止自动重试', 'unknown');
        }
        const key = `${groupId}:${userId}:${args.duration}`;
        const results = ctx.session.groupModerationResults ||= new Map();
        if (results.has(key)) return results.get(key);
        assertCanSend(ctx.chatKey, ctx.signal);
        operationId = ctx.store.beginSend(ctx.chatKey, ctx.session.leaseId, {
          type: 'group_ban', groupId, userId, duration: args.duration, requesterId
        });
        // A pending marker also prevents duplicate calls if the outer run is aborted.
        results.set(key, failure('OPERATION_PENDING', '操作已提交，结果尚未确认；禁止重试', 'unknown'));
        let result;
        try {
          await ctx.onebot.call('set_group_ban', {
            group_id: groupId, user_id: userId, duration: args.duration
          }, 15000, ctx.signal);
          ctx.store.finishSend(operationId, {});
          result = { content: JSON.stringify({ success: true, group_id: groupId,
            user_id: userId, duration: args.duration }) };
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
