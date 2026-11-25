import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

function scenario(t, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-config-safety-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import path from 'node:path';
    const file = path.join(process.env.QQ_AGENT_DATA_DIR, 'config.json');
    const original = JSON.stringify({ api: { model: 'model' }, onebot: { accessToken: 'token' } });
    fs.writeFileSync(file, original, { mode: 0o600 });
    const legacy = await import(${JSON.stringify(new URL('../src/config-legacy.js', import.meta.url).href)});
    const config = await import(${JSON.stringify(new URL('../src/config.js', import.meta.url).href)});
    ${body}
  `], { env: { ...process.env, QQ_AGENT_DATA_DIR: dir }, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || String(result.error));
}

test('only a missing file uses defaults and permits first save', (t) => scenario(t, `
  fs.unlinkSync(file);
  assert.equal(legacy.getConfig().api.model, '');
  config.updateConfig({ api: { model: 'first-model' } });
  assert.equal(JSON.parse(fs.readFileSync(file)).api.model, 'first-model');
`));

for (const invalid of ['{invalid', '', 'null', '[]', '42']) {
  test('invalid stored configuration blocks reads and all writes: ' + JSON.stringify(invalid), (t) => scenario(t, `
    fs.writeFileSync(file, ${JSON.stringify(invalid)});
    assert.throws(() => config.getConfig(), /Cannot safely access/);
    // Even restoring disk readability or injecting runtime state cannot unlock
    // persistence in a process that has already experienced a failed read.
    fs.writeFileSync(file, original);
    config.setRuntimeConfig(structuredClone(config.DEFAULT_CONFIG));
    assert.throws(() => legacy.scheduleConfigSave(), /Cannot safely access/);
    assert.throws(() => config.scheduleConfigSave(), /Cannot safely access/);
    assert.throws(() => legacy.updateConfig({ ui: { refreshMs: 2000 } }), /Cannot safely access/);
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  `));
}

test('EACCES never returns defaults or overwrites the existing file', (t) => scenario(t, `
  const read = fs.readFileSync;
  fs.readFileSync = function(target, ...args) {
    if (target === file) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    return read.call(this, target, ...args);
  };
  assert.throws(() => config.getConfig(), error => error.cause.code === 'EACCES');
  fs.readFileSync = read;
  legacy.setRuntimeConfig(structuredClone(legacy.DEFAULT_CONFIG));
  assert.throws(() => legacy.scheduleConfigSave(), /Cannot safely access/);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
`));

test('chmod failure blocks persistence before a timer is queued', (t) => scenario(t, `
  config.getConfig();
  const chmod = fs.chmodSync;
  fs.chmodSync = () => { throw Object.assign(new Error('not owner'), { code: 'EPERM' }); };
  assert.throws(() => config.scheduleConfigSave(), error => error.cause.code === 'EPERM');
  fs.chmodSync = chmod;
  assert.throws(() => legacy.updateConfig({}), /Cannot safely access/);
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(fs.readFileSync(file, 'utf8'), original);
`));

test('both save paths refuse empty credentials over a configured file', (t) => scenario(t, `
  assert.throws(() => config.updateConfig({ api: { model: '' }, onebot: { accessToken: '' } }), /Refusing to overwrite/);
  assert.equal(config.getConfig().api.model, 'model');
  legacy.setRuntimeConfig(structuredClone(legacy.DEFAULT_CONFIG));
  assert.throws(() => legacy.scheduleConfigSave(), /Refusing to overwrite/);
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(JSON.parse(fs.readFileSync(file)).api.model, 'model');
  assert.equal(JSON.parse(fs.readFileSync(file)).onebot.accessToken, 'token');
`));

test('a different file owner blocks even a privileged writer', { skip: typeof process.getuid !== 'function' }, (t) => scenario(t, `
  legacy.getConfig();
  const stat = fs.statSync;
  fs.statSync = function(target, ...args) {
    const result = stat.call(this, target, ...args);
    if (target === file) result.uid = process.getuid() + 1;
    return result;
  };
  assert.throws(() => legacy.scheduleConfigSave(), error => /owner differs/.test(error.cause.message));
  fs.statSync = stat;
  assert.equal(fs.readFileSync(file, 'utf8'), original);
`));

test('queued save rechecks disk health and preserves later corruption', (t) => scenario(t, `
  legacy.getConfig();
  legacy.scheduleConfigSave();
  fs.writeFileSync(file, '{invalid');
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(fs.readFileSync(file, 'utf8'), '{invalid');
  assert.throws(() => legacy.updateConfig({}), /Cannot safely access/);
`));

test('normal synchronous and delayed saves retain credentials and secure modes', (t) => scenario(t, `
  config.updateConfig({ ui: { refreshMs: 8000 } });
  config.getConfig().ui.refreshMs = 9000;
  config.scheduleConfigSave();
  await new Promise(resolve => setTimeout(resolve, 600));
  const saved = JSON.parse(fs.readFileSync(file));
  assert.equal(saved.ui.refreshMs, 9000);
  assert.equal(saved.api.model, 'model');
  assert.equal(saved.onebot.accessToken, 'token');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['config.json']);
`));

test('real Unix permission denial preserves the unreadable file', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, (t) => scenario(t, `
  fs.chmodSync(file, 0o000);
  try {
    assert.throws(() => config.getConfig(), error => error.cause.code === 'EACCES');
    assert.throws(() => legacy.scheduleConfigSave(), /Cannot safely access/);
  } finally {
    fs.chmodSync(file, 0o600);
  }
  assert.equal(fs.readFileSync(file, 'utf8'), original);
`));
