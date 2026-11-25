import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-sticker-manager-'));
process.env.QQ_AGENT_DATA_DIR = root;
fs.writeFileSync(path.join(root, 'stickers.json'), JSON.stringify([{
  id: 'collected_1701183958',
  resId: 'collected_1701183958',
  url: 'https://multimedia.nt.qq.com.cn/download?fileid=old&rkey=expired',
  source: 'ai',
  desc: 'test sticker'
}]));

const { StickerManager } = await import('../src/sticker-manager.js');
const { getConfig, setRuntimeConfig } = await import('../src/config.js');
const { buildToolDefs } = await import('../src/tools.js');
const { buildStickerContext, findSticker } = await import('../src/stickers.js');

test('refreshes a collected QQ image URL from its source message before sending', async (t) => {
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const manager = new StickerManager({
    async call(action) {
      assert.equal(action, 'fetch_custom_face_detail');
      return [];
    },
    async getMsg(messageId) {
      calls.push(messageId);
      return {
        message: [{
          type: 'image',
          data: {
            url: 'https://multimedia.nt.qq.com.cn/download?fileid=fresh&rkey=current'
          }
        }]
      };
    }
  });

  const cached = manager.peek('collected_1701183958');
  assert.equal(cached.id, 'collected_1701183958');
  assert.deepEqual(calls, [], '只读观测本地快照不应触发 OneBot');

  const sticker = await manager.findForSend('collected_1701183958');

  assert.deepEqual(calls, [1701183958]);
  assert.match(sticker.url, /rkey=current$/);
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'stickers.json'), 'utf8'));
  assert.match(saved[0].url, /rkey=current$/);
});

test('manual uploaded stickers can be viewed and sent by agent tools', async (t) => {
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manager = new StickerManager({ call: async () => [] });
  const sticker = manager.addManual({
    imageBuffer: await sharp({
      create: { width: 32, height: 32, channels: 3, background: '#ffcc00' }
    }).png().toBuffer(),
    desc: '本地测试'
  });
  const sent = [];
  const context = {
    chatKey: 'group:1',
    stickers: manager,
    sender: {
      sendSticker: async (_chatKey, value) => {
        sent.push(value);
        return { message_id: 7 };
      }
    },
    session: { leaseId: 'lease', triggerText: '测试', sent: [] },
    emit: () => {}
  };
  const tools = buildToolDefs();
  const send = tools.find((tool) => tool.name === 'send_sticker');
  const view = tools.find((tool) => tool.name === 'get_sticker_image');
  const sendResult = await send.execute(context, { stickerId: sticker.id });
  assert.equal(sendResult.isError, undefined);
  assert.match(sent[0].url, /^base64:\/\//);
  const viewResult = await view.execute(context, { stickerId: sticker.id });
  assert.equal(viewResult.isError, undefined);
  assert.equal(viewResult.content[1].type, 'image_url');
  assert.match(viewResult.content[1].image_url.url, /^data:image\/jpeg;base64,/);

  const webp = manager.addManual({
    imageBuffer: await sharp({
      create: { width: 32, height: 32, channels: 3, background: '#00aaff' }
    }).webp().toBuffer(),
    desc: 'WebP 测试'
  });
  const webpSendResult = await send.execute(context, { stickerId: webp.id });
  assert.equal(webpSendResult.isError, undefined);
  assert.match(sent[1].url, /^base64:\/\//);
  const webpViewResult = await view.execute(context, { stickerId: webp.id });
  assert.equal(webpViewResult.isError, undefined);
  assert.match(webpViewResult.content[1].image_url.url, /^data:image\/jpeg;base64,/);
});

test('refuses to overwrite a corrupted sticker metadata file', (t) => {
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(root, { recursive: true });
  const metadataFile = path.join(root, 'stickers.json');
  const corrupted = '{"id":';
  fs.writeFileSync(metadataFile, corrupted);
  const manager = new StickerManager({ call: async () => [] });

  assert.throws(() => manager.addManual({
    imageBuffer: Buffer.from('89504e470d0a1a0a00000000', 'hex'),
    desc: '不应写入'
  }), /表情库读取失败，已停止写入/);
  assert.equal(fs.readFileSync(metadataFile, 'utf8'), corrupted);
  assert.equal(fs.existsSync(path.join(root, 'sticker-assets')), false);
});

test('reports pending cleanup when a deleted sticker image cannot be removed', (t) => {
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(root, { recursive: true });
  const manager = new StickerManager({ call: async () => [] });
  const sticker = manager.addManual({
    imageBuffer: Buffer.from('89504e470d0a1a0a00000000', 'hex'),
    desc: '待删除'
  });
  const imageFile = path.join(root, manager.entries.find((entry) =>
    entry.id === sticker.id).localFile);
  const originalRmSync = fs.rmSync;
  t.mock.method(fs, 'rmSync', (target, options) => {
    if (path.resolve(target) === path.resolve(imageFile)) {
      throw new Error('simulated cleanup failure');
    }
    return originalRmSync(target, options);
  });

  const result = manager.remove(sticker.id);
  t.mock.restoreAll();

  assert.equal(result.removed, true);
  assert.equal(result.cleanupPending, true);
  assert.match(result.warning, /simulated cleanup failure/);
  assert.equal(manager.peek(sticker.id), null);
  assert.equal(fs.existsSync(imageFile), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'stickers.json'), 'utf8')), []);
});

test('prompt exposes sticker IDs and exact unique labels remain compatible', () => {
  const entries = [
    { id: 'sticker-1', desc: '无语团子', localNote: '', url: 'https://example.com/1.png' },
    { id: 'sticker-2', desc: '开心团子', localNote: '庆祝', url: 'https://example.com/2.png' }
  ];
  const prompt = buildStickerContext(entries, 10);
  assert.match(prompt, /无语团子.*stickerId：sticker-1/);
  assert.equal(findSticker(entries, '无语团子')?.id, 'sticker-1');
  assert.equal(findSticker(entries, '庆祝')?.id, 'sticker-2');
  assert.equal(findSticker([
    ...entries,
    { id: 'sticker-3', desc: '无语团子', url: 'https://example.com/3.png' }
  ], '无语团子'), null);
});

// ---- 图片地址过期（rkey）回归测试 ----
// 线上事故 inc_16f5ce42d00d4164：收藏时存下的 QQ 图片 URL 带短期 rkey，
// 过期后 NapCat 下载返回 HTTP 400，最终报 "下载文件失败: Bad Request"。

async function withImageServer(t, buffer, status = 200) {
  const http = await import('node:http');
  const server = http.createServer((_req, res) => {
    res.writeHead(status, { 'content-type': 'image/png' });
    res.end(buffer);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/img.png`;
}

// 走 127.0.0.1 需要 allowPrivateImageHosts；显式打开并在用例结束后复原，
// 避免污染其他用例（也用 setRuntimeConfig 之后的真实配置做克隆）。
function useCollectableConfig(t) {
  const previous = getConfig();
  const cfg = structuredClone(previous);
  cfg.security = { ...(cfg.security || {}), allowPrivateImageHosts: true };
  cfg.sticker = { ...(cfg.sticker || {}), enabled: true, collectEnabled: true, maxCollectPerHour: 100 };
  setRuntimeConfig(cfg);
  t.after(() => setRuntimeConfig(previous));
}

const PNG_32 = await sharp({
  create: { width: 32, height: 32, channels: 3, background: '#ffcc00' }
}).png().toBuffer();

test('collect pins the image locally so a later rkey expiry cannot break sending', async (t) => {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'stickers.json'), '[]');
  useCollectableConfig(t);
  const url = await withImageServer(t, PNG_32);
  const manager = new StickerManager({ call: async () => [], getMsg: async () => { throw new Error('消息不存在'); } });

  const entry = await manager.collect(1001, { url, note: '收藏测试' });
  assert.ok(entry.localFile, '收藏时就应落盘');
  assert.equal(fs.existsSync(path.join(root, entry.localFile)), true);

  // 远端地址失效（服务端已经 404）也不影响发送：直接走本地 base64。
  const resolved = await manager.findForSend(entry.id);
  assert.match(resolved.url, /^base64:\/\//);
  assert.equal(resolved.imageUnavailableAt, 0);
});

test('findForSend localizes a stale collected URL when the source message is gone', async (t) => {
  fs.mkdirSync(root, { recursive: true });
  const url = await withImageServer(t, PNG_32);
  fs.writeFileSync(path.join(root, 'stickers.json'), JSON.stringify([{
    id: 'collected_2002',
    resId: 'collected_2002',
    url,
    source: 'ai',
    desc: '旧地址'
  }]));
  useCollectableConfig(t);
  const manager = new StickerManager({
    call: async () => [],
    // 原消息已过期：get_msg 抛错，正是线上真实情形。
    getMsg: async () => { throw new Error('消息不存在'); }
  });

  const resolved = await manager.findForSend('collected_2002');
  assert.ok(resolved, '应通过本地化兜底成功');
  assert.match(resolved.url, /^base64:\/\//);
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'stickers.json'), 'utf8'));
  assert.ok(saved[0].localFile, '本地化成功后应写回 localFile');
});

test('findForSend marks an unrecoverable sticker unavailable instead of sending a dead URL', async (t) => {
  fs.mkdirSync(root, { recursive: true });
  // 服务端直接 400：等价于 rkey 过期后 NapCat 看到的情形。
  const url = await withImageServer(t, Buffer.from('expired'), 400);
  fs.writeFileSync(path.join(root, 'stickers.json'), JSON.stringify([{
    id: 'collected_3003',
    resId: 'collected_3003',
    url,
    source: 'ai',
    desc: '已过期'
  }]));
  useCollectableConfig(t);
  const manager = new StickerManager({
    call: async () => [],
    getMsg: async () => { throw new Error('消息不存在'); }
  });

  const resolved = await manager.findForSend('collected_3003');
  assert.equal(resolved, null, '拿不到图片时必须返回 null，而不是把坏 URL 交给 OneBot');

  const saved = JSON.parse(fs.readFileSync(path.join(root, 'stickers.json'), 'utf8'));
  assert.ok(saved[0].imageUnavailableAt > 0, '应记录失效时间');
  assert.match(saved[0].imageUnavailableReason, /HTTP 400/);

  // 失效的表情不再出现在列表和提示词里，避免模型反复挑中。
  const synced = await manager.list('', 48, false);
  assert.equal(synced.matched, 0);
  assert.doesNotMatch(buildStickerContext(manager.entries, 10), /collected_3003/);
});

