import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parse } from 'node-html-parser';

const read = file => fs.readFileSync(new URL('../ui/' + file, import.meta.url), 'utf8');
test('dedicated page renders settings, candidates, statistics, audit and rollback without HTML injection', async () => {
  const html = parse(read('personality-learning.html'));
  const nodes = new Map();
  function element(tag, id = '') {
    return { tagName: tag, id, value: '', checked: false, children: [], textContent: '', hidden: false,
      append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; } };
  }
  for (const node of html.querySelectorAll('[id]')) nodes.set(node.id, element(node.tagName, node.id));
  const status = { enabled: true, graduated: false, active: true, mode: 'observe', injectEnabled: false, autoApply: false,
    groups: ['123'], version: 1, modelCalls: 0, minEvidence: 20, minConfidence: .85, minWindowDays: 7, minSources: 3, retentionDays: 30 };
  const data = { observations: [{ group_id: '123', total: 30, first: 1, last: 2 }], fillers: [{ group_id: '123', filler: '确实', count: 25 }],
    habits: [{ id: 'test', description: '<img src=x onerror=alert(1)>', status: 'active', scope_type: 'group', scope_id: '123', usage_context: '*', evidence_count: 30, source_count: 4, confidence: .9 }],
    versions: [{ id: 1, change_summary: '激活偏好', content: [{ id: 'test' }], previous_version: 0 }, { id: 0, change_summary: '初始', content: [], previous_version: null }], feedback: [] };
  const calls = [];
  const context = vm.createContext({ document: { getElementById: id => nodes.get(id), createElement: tag => element(tag) },
    fetch: async (url, options) => { calls.push([url, options]); return { ok: true, json: async () => url.endsWith('/data') ? data : status }; },
    confirm: () => true, console, Date, Set, Error, Number, JSON });
  vm.runInContext(read('personality-learning-page.js'), context);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(nodes.get('status').textContent, /观察模式，不改变回复/);
  assert.ok(nodes.get('habits').children[0].children[0].textContent.includes('<img'));
  assert.equal(nodes.get('habits').children[0].children[0].innerHTML, undefined);
  assert.ok(nodes.get('versions').children[1].children.some(node => node.textContent === '回滚到此动态版本'));
  nodes.get('groups').value = '123'; nodes.get('mode').value = 'observe';
  await nodes.get('settings').onsubmit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  const patch = JSON.parse(calls.find(([url, options]) => url.endsWith('/settings') && options.method === 'POST')[1].body);
  assert.equal(patch.groups[0], '123'); assert.equal('api' in patch, false); assert.equal('persona' in patch, false);
});
test('experiment controls contain only lifecycle and standalone page link; navigation requires graduation', () => {
  const code = read('personality-learning-controls.js');
  assert.match(code, /if \(!s.graduated/); assert.match(code, /personality-learning.html/);
  assert.doesNotMatch(code, /habit|feedback|rollback|candidate/);
  assert.match(read('index.html'), /personality-learning-controls.js/);
});
