import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const index = read('ui/index.html');
const people = read('ui/global-memory.js');
const session = read('ui/session-memory-view.js');

test('memory navigation exposes independent session and person pages', () => {
  assert.match(index, /data-tab="memory"[^>]*>会话记忆<\/button>/);
  assert.match(index, /data-tab="people-memory"[^>]*>人物记忆<\/button>/);
  assert.match(index, /id="view-memory"/);
  assert.match(index, /id="view-people-memory"/);
  assert.match(index, /id="global-memory-items"/);
  assert.match(index, /src="\/session-memory-view\.js"/);
  assert.match(index, /src="\/global-memory\.js"/);
});

test('global person memory renders only inside the dedicated people page', () => {
  assert.match(people, /getElementById\('view-people-memory'\)/);
  assert.match(people, /data-tab="people-memory"/);
  assert.doesNotMatch(people, /data-tab="memory"/);
  assert.doesNotMatch(people, /view-memory\[data-global-memory/);
  assert.match(people, /sourceChatKeys/);
  assert.match(people, /来源会话只用于证据追溯/);
});

test('session memory page keeps the consolidation entry and hides person-memory detail controls', () => {
  assert.match(session, /#view-memory #mem-add-imp-btn/);
  assert.doesNotMatch(session, /#view-memory #mem-consolidate-btn/);
  assert.doesNotMatch(session, /#view-memory #mem-consolidate-status/);
  assert.match(session, /#view-memory #mem-load-members-btn/);
  assert.match(session, /\.collapsible:not\(\.memory-handoff\)/);
  assert.match(session, /本页可以整理当前群的长期人物印象/);
  assert.match(session, /人物印象明细请在“人物记忆”页查看/);
  assert.match(session, /会话级 handoff \/ 工作状态/);
});

test('people memory page guides the first consolidation and separates empty/loading/error states', () => {
  assert.match(people, /还没有人物长期记忆。请前往会话记忆页，选择群聊并执行一次“整理本群记忆”。/);
  assert.match(people, /id="gm-goto-session"/);
  assert.match(people, /这个人目前没有长期印象/);
  assert.match(people, /正在整理人物记忆/);
  assert.match(people, /waitForConsolidationOutcome/);
  assert.match(people, /partial_failed/);
  assert.match(people, /gm-status-warning/);
  assert.match(people, /整理失败/);
  assert.match(people, /loadState === 'error'/);
  assert.match(people, /人物记忆加载失败/);
  assert.match(people, /人物记忆详情读取失败/);
});
