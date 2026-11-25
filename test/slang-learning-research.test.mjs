import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModelJson } from '../src/slang-learning-research.js';

test('parseModelJson handles fenced JSON with surrounding whitespace and prose', () => {
  const raw = '\n以下是提取结果：\n```json\n[{"content":"破防","sourceId":"m1"}]\n```\n';
  assert.deepEqual(parseModelJson(raw, { expect: 'array' }), [{ content: '破防', sourceId: 'm1' }]);
});

test('parseModelJson unwraps object-wrapped arrays for extractSlang', () => {
  const raw = '```json\n{"candidates":[{"content":"绝绝子","sourceId":"m2"}]}\n```';
  assert.deepEqual(parseModelJson(raw, { expect: 'array' }), [{ content: '绝绝子', sourceId: 'm2' }]);
  assert.deepEqual(parseModelJson('{}', { expect: 'array' }), []);
  assert.deepEqual(parseModelJson('无', { expect: 'array' }), []);
});

test('parseModelJson parses research object wrapped in prose and rejects malformed content', () => {
  const raw = '判断结果如下：{"confirmed":true,"meaning":"表示情绪波动","evidence":[]} 以上。';
  assert.deepEqual(parseModelJson(raw, { expect: 'object' }), { confirmed: true, meaning: '表示情绪波动', evidence: [] });
  assert.throws(() => parseModelJson('无法解析的乱码文本', { expect: 'object' }), SyntaxError);
  assert.throws(() => parseModelJson('{"foo":"bar"}', { expect: 'array' }), SyntaxError);
});
