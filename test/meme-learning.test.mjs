import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { MemeLearningManager } from '../src/meme-learning.js';

const dirs = [];
function fixture(config = {}, deps = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-memes-'));
  dirs.push(dir);
  return new MemeLearningManager({
    enabled: true,
    dataDir: dir,
    allowedGroupIds: ['12345'],
    searchQueries: ['热梗'],
    minDomains: 2,
    minConfidence: 0.8,
    ...config
  }, deps);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

test('disabled module has no database or timer side effects', async () => {
  const manager = new MemeLearningManager({ enabled: false, dataDir: path.join(os.tmpdir(), 'should-not-exist-meme-test') });
  assert.equal((await manager.start()).databaseOpened, false);
  assert.equal(manager.observeMessage({ groupId: '12345', text: '梗词' }), false);
  await manager.stop();
  assert.equal(manager.status().databaseOpened, false);
});

test('observes only opted-in group messages and ignores private/self messages', async () => {
  const manager = fixture();
  assert.equal(manager.observeMessage({ groupId: '12345', text: '这也太典了' }), true);
  assert.equal(manager.observeMessage({ groupId: '99999', text: '这也太典了' }), false);
  assert.equal(manager.observeMessage({ groupId: '12345', text: '我自己的消息', isSelf: true }), false);
  assert.equal(manager.observeMessage({ groupId: '12345', text: '私聊消息', isPrivate: true }), false);
  await manager.stop();
});

test('requires corroborating domains and explicit model verification before activation', async () => {
  const manager = fixture({
    searchQueries: ['热梗'],
    minConfidence: 0.8,
    minDomains: 2
  }, {
    searchWeb: async (query) => ({
      results: query.includes('“')
        ? [
            { title: '解释 A', url: 'https://a.example/meme', snippet: '这是一个足够长的梗义说明，用于测试来源交叉验证。' },
            { title: '解释 B', url: 'https://b.example/meme', snippet: '这是另一个来源对同一梗的说明，用于交叉验证测试。' }
          ]
        : [{ title: '热梗讨论', url: 'https://origin.example/post', snippet: '这是一个足够长的梗义说明，用于测试来源交叉验证。' }]
    }),
    analyze: async () => ({
      term: '测试梗',
      meaning: '用于测试的梗义',
      usage: '仅作测试',
      tone: '轻松',
      confidence: 0.95,
      verified: true,
      sensitive: false
    })
  });
  await manager.runOnce();
  assert.equal(manager.lookup('测试梗').length, 1);
  assert.equal(manager.lookup('测试梗')[0].sources.length, 3);
  await manager.stop();
});

test('does not activate an unverified or single-source meme', async () => {
  const manager = fixture({}, {
    searchWeb: async () => ({
      results: [{ title: '单一来源', url: 'https://one.example/post', snippet: '这是一个足够长的说明文本，用于验证单一来源不能自动入库。' }]
    }),
    analyze: async () => ({
      term: '不确定梗', meaning: '尚未验证', confidence: 0.99, verified: false
    })
  });
  await manager.runOnce();
  assert.deepEqual(manager.lookup('不确定梗'), []);
  await manager.stop();
});

test('feedback can quarantine incorrect and outdated entries', async () => {
  const manager = fixture({}, {
    searchWeb: async (query) => ({
      results: query.includes('“')
        ? [
            { title: '解释 A', url: 'https://a.example/meme', snippet: '这是一个足够长的梗义说明，用于测试来源交叉验证。' },
            { title: '解释 B', url: 'https://b.example/meme', snippet: '这是另一个来源对同一梗的说明，用于交叉验证测试。' }
          ]
        : [{ title: '热梗讨论', url: 'https://origin.example/post', snippet: '这是一个足够长的梗义说明，用于测试来源交叉验证。' }]
    }),
    analyze: async () => ({
      term: '反馈梗', meaning: '初始含义', confidence: 0.95, verified: true
    })
  });
  await manager.runOnce();
  assert.equal(manager.lookup('反馈梗').length, 1);
  manager.feedback({ term: '反馈梗', kind: 'incorrect', note: '含义不准确' });
  assert.equal(manager.lookup('反馈梗').length, 0);
  await manager.stop();
});
