// 原工具实现完整保存在 tools-core.js。
// 本文件只提供“实验工具调度器”的薄包装：关闭时直接委托原实现，保持现有行为。
import { getConfig } from './config.js';
import {
  recordMultimodalToolResult
} from './experimental-multimodal-context-core.js';
import {
  annotateExperimentalToolSchemas,
  experimentalBatchKey,
  experimentalToolSchedulerConfig,
  ExperimentalToolBatch
} from './experimental-tool-scheduler.js';
import {
  buildToolDefs as coreBuildToolDefs,
  executeTool as coreExecuteTool,
  toOpenAiTools as coreToOpenAiTools
} from './tools-core.js';

export * from './tools-core.js';

// 显式导出覆盖 export * 中同名项；关闭实验时仍原样调用旧实现。
export const buildToolDefs = coreBuildToolDefs;

export function selectToolDefs(defs, { kind, visionEnabled, searchEnabled,
  identityAvailable, friendProposalAvailable }) {
  const excluded = [];
  const selected = defs.filter((d) => {
    let reason = '';
    if (!visionEnabled && ['get_message_images', 'get_sticker_image'].includes(d.name)) reason = 'vision_disabled';
    else if (!searchEnabled && ['web_search', 'web_fetch'].includes(d.name)) reason = 'search_disabled';
    else if (d.feature === 'identityPilot' && !identityAvailable) reason = 'identity_unavailable';
    else if (d.feature === 'friendProposal' && !friendProposalAvailable) reason = 'friend_proposal_unavailable';
    else if (d.name === 'set_group_ban' && kind !== 'group') reason = 'group_only';
    if (reason) excluded.push({ name: d.name, reason });
    return !reason;
  });
  if (process.env.QQ_AGENT_TOOL_DEBUG === '1') {
    console.info('[tools] selection', JSON.stringify({ names: selected.map((d) => d.name), excluded }));
  }
  return selected;
}

export function toOpenAiTools(defs) {
  const tools = coreToOpenAiTools(defs);
  return annotateExperimentalToolSchemas(tools, getConfig());
}

const batchBySession = new WeakMap();

function latestAssistantToolCalls(session) {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message?.role === 'assistant'
      && Array.isArray(message.tool_calls)
      && message.tool_calls.length
    ) return message.tool_calls;
  }
  return [];
}

function schedulerMetrics(session, batch, settings) {
  if (!session || !batch) return;
  session.experimentalToolScheduler = {
    enabled: true,
    maxParallelReads: settings.maxParallelReads,
    ...batch.metrics()
  };
}

function runtimeBatch(defs, ctx, settings) {
  const session = ctx?.session;
  if (!session || typeof session !== 'object') return null;
  const calls = latestAssistantToolCalls(session);
  if (!calls.length) return null;
  const key = experimentalBatchKey(calls, session.rounds);
  const old = batchBySession.get(session);
  if (old?.key === key) return old.batch;

  const batch = new ExperimentalToolBatch(calls, {
    maxParallelReads: settings.maxParallelReads,
    execute: (call) => coreExecuteTool(
      defs,
      ctx,
      call?.function?.name ?? '',
      call?.function?.arguments ?? '{}'
    ),
    onParallelWave: ({ size, names }) => {
      session.experimentalToolScheduler = {
        enabled: true,
        maxParallelReads: settings.maxParallelReads,
        parallelWaveActive: true,
        lastParallelSize: size,
        lastParallelTools: names
      };
    }
  });
  batchBySession.set(session, { key, batch });
  schedulerMetrics(session, batch, settings);
  return batch;
}

function safeToolArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw ?? '{}')); } catch { return {}; }
}

function observeMultimodalResult(ctx, name, argsJson, result, cfg) {
  if (cfg?.multimodalContextPilot?.enabled !== true) return result;
  return recordMultimodalToolResult(
    ctx?.session,
    name,
    safeToolArgs(argsJson),
    result,
    cfg
  );
}

/**
 * 实验关闭：直接进入旧 executeTool，连批次解析都不做。
 * 实验开启：宿主依旧逐个 await 本函数；仅连续只读工具会被后台并行预启动。
 */
export async function executeTool(defs, ctx, name, argsJson) {
  const cfg = getConfig();
  const settings = experimentalToolSchedulerConfig(cfg);
  if (!settings.enabled) {
    const result = await coreExecuteTool(defs, ctx, name, argsJson);
    return observeMultimodalResult(ctx, name, argsJson, result, cfg);
  }

  const batch = runtimeBatch(defs, ctx, settings);
  if (!batch) {
    const result = await coreExecuteTool(defs, ctx, name, argsJson);
    return observeMultimodalResult(ctx, name, argsJson, result, cfg);
  }

  const scheduled = await batch.next(name, argsJson);
  if (!scheduled.handled) {
    // Session 审计结构与宿主调用顺序出现任何不一致时，宁可退回旧串行路径。
    const result = await coreExecuteTool(defs, ctx, name, argsJson);
    return observeMultimodalResult(ctx, name, argsJson, result, cfg);
  }
  schedulerMetrics(ctx?.session, batch, settings);
  return observeMultimodalResult(ctx, name, argsJson, scheduled.result, cfg);
}
