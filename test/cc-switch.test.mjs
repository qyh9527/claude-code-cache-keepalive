// All fixtures are temporary; never open real Claude / CC Switch data.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import vm from 'node:vm';
import { after, test } from 'node:test';

const installer = fileURLToPath(new URL('../install.mjs', import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keepalive-cc-switch-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const secret = 'FAKE_SECRET_NEVER_PRINT_THIS';
let serial = 0;
function fixture(value = '{}') {
  const dir = path.join(root, String(serial++));
  const cc = path.join(dir, '.cc-switch');
  const config = path.join(dir, '.claude');
  fs.mkdirSync(cc, { recursive: true });
  fs.mkdirSync(config);
  fs.writeFileSync(path.join(config, 'settings.json'), '{broken Claude settings');
  const dbPath = path.join(cc, 'cc-switch.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT); CREATE TABLE providers(secret TEXT); CREATE TABLE request_logs(secret TEXT)');
  db.prepare('INSERT INTO providers VALUES (?)').run(secret);
  db.prepare('INSERT INTO request_logs VALUES (?)').run(secret);
  db.prepare('INSERT INTO settings VALUES (?, ?)').run('other_marker', secret);
  if (value !== undefined) db.prepare('INSERT INTO settings VALUES (?, ?)').run('common_config_claude', value);
  db.close();
  return { dir, cc, config, dbPath };
}
function run(f, ...flags) {
  const r = spawnSync(process.execPath, [installer, '--config-dir', f.config, '--cc-switch', '--cc-switch-dir', f.cc, ...flags], {
    encoding: 'utf8', env: { ...process.env, HOME: f.dir, USERPROFILE: f.dir, CLAUDE_CONFIG_DIR: f.config }, timeout: 10000,
  });
  assert.equal(r.error, undefined);
  assert.ok(!(r.stdout + r.stderr).includes(secret), 'output must not disclose fixture secrets');
  return { code: r.status, out: r.stdout + r.stderr };
}
function row(f) {
  const db = new DatabaseSync(f.dbPath, { readOnly: true });
  try { return db.prepare("SELECT value FROM settings WHERE key='common_config_claude'").get()?.value; }
  finally { db.close(); }
}
const script = (f) => path.join(f.config, 'hooks', 'cache-keepalive.mjs');
const backups = (f) => fs.readdirSync(f.cc).filter((n) => n.includes('.bak-'));
const handlers = (s) => (s.hooks?.Stop ?? []).flatMap((g) => g.hooks).filter((h) => h.command === 'node' && h.args?.[0] === scriptPath);
let scriptPath;

test('explicit mode preserves template, replaces owned handlers, switches models, and uninstalls', () => {
  const original = { env: { API_KEY: secret }, marker: true, hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: 'notify' }] }],
    Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'node notify.js' }, { type: 'command', command: 'node /old/cache-keepalive.mjs' }] }],
  } };
  const f = fixture(JSON.stringify(original));
  scriptPath = script(f);
  assert.equal(run(f).code, 0);
  const installed = JSON.parse(row(f));
  assert.deepEqual(installed.env, original.env);
  assert.deepEqual(installed.hooks.SessionStart, original.hooks.SessionStart);
  assert.equal(installed.hooks.Stop[0].hooks[0].command, 'node notify.js');
  assert.equal(installed.hooks.Stop.flatMap((g) => g.hooks).filter((h) => h.command === 'node /old/cache-keepalive.mjs').length, 0);
  assert.equal(handlers(installed).length, 1);
  assert.equal(handlers(installed)[0].asyncRewake, true);
  assert.equal(handlers(installed)[0].timeout, 360);
  assert.equal(backups(f).length, 1);
  assert.equal(fs.readFileSync(path.join(f.cc, backups(f)[0]), 'utf8'), JSON.stringify(original));
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(f.cc, backups(f)[0])).mode & 0o777, 0o600);
  const before = row(f);
  const dbBefore = fs.readFileSync(f.dbPath);
  assert.equal(run(f).code, 0);
  assert.equal(row(f), before);
  assert.deepEqual(fs.readFileSync(f.dbPath), dbBefore);
  assert.equal(backups(f).length, 1);
  assert.equal(run(f, '--any-model').code, 0);
  assert.ok(handlers(JSON.parse(row(f)))[0].args.includes('--any-model'));
  assert.equal(run(f).code, 0);
  assert.ok(!handlers(JSON.parse(row(f)))[0].args.includes('--any-model'));
  const n = backups(f).length;
  assert.equal(run(f, '--uninstall').code, 0);
  const removed = JSON.parse(row(f));
  assert.equal(handlers(removed).length, 0);
  assert.equal(removed.hooks.Stop[0].hooks[0].command, 'node notify.js');
  assert.deepEqual(removed.env, original.env);
  assert.equal(backups(f).length, n + 1);
  assert.ok(fs.existsSync(script(f)));
  assert.equal(fs.readFileSync(path.join(f.config, 'settings.json'), 'utf8'), '{broken Claude settings');
  const db = new DatabaseSync(f.dbPath);
  assert.equal(db.prepare('SELECT secret FROM providers').get().secret, secret);
  assert.equal(db.prepare('SELECT secret FROM request_logs').get().secret, secret);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='other_marker'").get().value, secret);
  db.close();
});

test('missing and empty templates install without changing other settings', () => {
  for (const value of [undefined, '']) {
    const f = fixture(value);
    // fixture's default parameter supplies {}; explicitly delete for missing row.
    if (value === undefined) { const db = new DatabaseSync(f.dbPath); db.exec("DELETE FROM settings WHERE key='common_config_claude'"); db.close(); }
    assert.equal(run(f).code, 0);
    assert.equal(JSON.parse(row(f)).hooks.Stop.length, 1);
    assert.ok(fs.existsSync(script(f)));
  }
});

test('readonly dry-run leaves database, settings, script and backups untouched', () => {
  const f = fixture('{"env":{"KEY":"' + secret + '"}}');
  const before = fs.readFileSync(f.dbPath);
  const mode = fs.statSync(f.dbPath).mode;
  fs.chmodSync(f.dbPath, 0o444);
  try { assert.equal(run(f, '--dry-run').code, 0); }
  finally { fs.chmodSync(f.dbPath, mode); }
  assert.deepEqual(fs.readFileSync(f.dbPath), before);
  assert.equal(backups(f).length, 0);
  assert.ok(!fs.existsSync(path.dirname(script(f))));
});

test('invalid JSON and structures fail safely without writes or secret output', () => {
  const values = ['{"' + secret + '":', 'null', '[]', '{"hooks":null}', '{"hooks":[]}', '{"hooks":{"Stop":{}}}', '{"hooks":{"Stop":[null]}}', '{"hooks":{"Stop":[{"hooks":{}}]}}', '{"hooks":{"SessionStart":null}}'];
  for (const value of values) {
    const f = fixture(value);
    const before = fs.readFileSync(f.dbPath);
    assert.equal(run(f).code, 1, value);
    assert.deepEqual(fs.readFileSync(f.dbPath), before);
    assert.ok(!fs.existsSync(script(f)));
    assert.equal(backups(f).length, 0);
  }
});

test('missing database is not created; argument misuse is rejected', () => {
  const f = fixture();
  fs.unlinkSync(f.dbPath);
  assert.equal(run(f).code, 1);
  assert.ok(!fs.existsSync(f.dbPath));
  assert.ok(!fs.existsSync(script(f)));
  for (const flags of [['--cc-switch-dir'], ['--cc-switch-dir', f.cc], ['--cc-switch', '--cc-switch-dir', '--dry-run']]) {
    const r = spawnSync(process.execPath, [installer, '--config-dir', f.config, ...flags], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.ok(!fs.existsSync(script(f)));
  }
});

test('lock conflict and SQL update failure roll back safely', () => {
  for (const locked of [true, false]) {
    const f = fixture();
    const db = new DatabaseSync(f.dbPath);
    if (locked) db.exec('BEGIN IMMEDIATE');
    else db.exec("CREATE TRIGGER reject_template BEFORE INSERT ON settings BEGIN SELECT RAISE(ABORT, '" + secret + "'); END");
    const before = row(f);
    const r = run(f);
    assert.equal(r.code, 1);
    assert.ok(!/Installed|Uninstalled/.test(r.out));
    assert.equal(row(f), before);
    assert.ok(!fs.existsSync(script(f)), 'failed SQL must not copy script');
    if (locked) { assert.equal(backups(f).length, 0); db.exec('ROLLBACK'); }
    db.close();
    // A fresh write proves the installer released its transaction/connection.
    const probe = new DatabaseSync(f.dbPath);
    probe.exec('BEGIN IMMEDIATE; ROLLBACK');
    probe.close();
  }
});

test('default install never opens CC Switch database; explicit mode ignores Claude settings', () => {
  const f = fixture();
  fs.writeFileSync(f.dbPath, 'not a SQLite database ' + secret);
  fs.writeFileSync(path.join(f.config, 'settings.json'), '{}');
  const r = spawnSync(process.execPath, [installer, '--config-dir', f.config], {
    encoding: 'utf8', env: { ...process.env, HOME: f.dir, USERPROFILE: f.dir },
  });
  assert.equal(r.status, 0);
  assert.ok(!(r.stdout + r.stderr).includes(secret));
  assert.equal(fs.readFileSync(f.dbPath, 'utf8'), 'not a SQLite database ' + secret);
});

test('dry-run uninstall and corrupt databases leave all targets untouched', () => {
  const f = fixture();
  assert.equal(run(f).code, 0);
  const before = fs.readFileSync(f.dbPath);
  const scriptBefore = fs.readFileSync(script(f));
  const n = backups(f).length;
  assert.equal(run(f, '--uninstall', '--dry-run').code, 0);
  assert.deepEqual(fs.readFileSync(f.dbPath), before);
  assert.deepEqual(fs.readFileSync(script(f)), scriptBefore);
  assert.equal(backups(f).length, n);
  const corrupt = fixture();
  fs.writeFileSync(corrupt.dbPath, 'not a database ' + secret);
  assert.equal(run(corrupt).code, 1);
  assert.equal(fs.readFileSync(corrupt.dbPath, 'utf8'), 'not a database ' + secret);
  assert.equal(backups(corrupt).length, 0);
  assert.ok(!fs.existsSync(script(corrupt)));
});

test('template uninstall preserves shared scripts even without template installation', () => {
  const f = fixture();
  fs.mkdirSync(path.dirname(script(f)), { recursive: true });
  fs.writeFileSync(script(f), 'ordinary installation shared script');
  const before = fs.readFileSync(script(f));
  assert.equal(run(f, '--uninstall').code, 0);
  assert.deepEqual(fs.readFileSync(script(f)), before);
  assert.equal(row(f), '{}');
});

test('empty Stop groups and containers survive install and unrelated uninstall', () => {
  for (const original of [{ hooks: {} }, { hooks: { Stop: [] } }, { hooks: { Stop: [{ matcher: 'keep-empty', hooks: [] }] } }]) {
    const f = fixture(JSON.stringify(original));
    assert.equal(run(f, '--uninstall').code, 0);
    assert.deepEqual(JSON.parse(row(f)), original);
    assert.equal(backups(f).length, 0);
    assert.equal(run(f).code, 0);
    assert.equal(run(f, '--uninstall').code, 0);
    if (original.hooks.Stop?.length) assert.deepEqual(JSON.parse(row(f)), original);
  }
});

test('failed SQL uninstall keeps installed template and script consistent', () => {
  const f = fixture();
  assert.equal(run(f).code, 0);
  const before = row(f);
  const scriptBefore = fs.readFileSync(script(f));
  const db = new DatabaseSync(f.dbPath);
  db.exec("CREATE TRIGGER reject_template BEFORE INSERT ON settings BEGIN SELECT RAISE(ABORT, '" + secret + "'); END");
  db.close();
  assert.equal(run(f, '--uninstall').code, 1);
  assert.equal(row(f), before);
  assert.deepEqual(fs.readFileSync(script(f)), scriptBefore);
});

async function faultRun(f, injectedFs, importFailure = false) {
  const source = fs.readFileSync(installer, 'utf8');
  const helpers = source.slice(source.indexOf('const portableBasename ='), source.indexOf('function readSettings()'));
  const remove = source.slice(source.indexOf('function removeOurHandlers('), source.indexOf('function checkNode()'));
  const mode = source.slice(source.indexOf('function validateTemplate('), source.indexOf('say(`Claude config dir:'))
    .replace("await import('node:sqlite')", "await sqliteImport()");
  const output = [];
  const context = { fs: injectedFs, path, DatabaseSync, process: { pid: process.pid },
    sqliteImport: async () => { if (importFailure) throw new Error(secret); return { DatabaseSync }; },
    SCRIPT_NAME: 'cache-keepalive.mjs', HOOK_TIMEOUT: 360, ccSwitchDir: f.cc,
    targetScript: script(f), sourceScript: fileURLToPath(new URL('../cache-keepalive.mjs', import.meta.url)),
    dryRun: false, uninstall: false, anyModel: false, checkNode() {}, stamp: () => 'fault-fixture',
    say: (s) => output.push(s), fail: (s) => { throw new Error(s); } };
  const invoke = vm.runInNewContext(helpers + remove + mode + '\ninstallCcSwitch', context, { timeout: 1000 });
  await assert.rejects(invoke, importFailure
    ? /node:sqlite is unavailable.*22\.13.*23\.4.*24.*--experimental-sqlite/
    : /operation failed/);
  assert.ok(!output.join('\n').includes(secret));
}

test('template backup failure rolls back before script changes', async () => {
  const f = fixture();
  const before = row(f);
  const injected = Object.create(fs);
  injected.writeFileSync = (name, ...args) => {
    if (String(name).includes('common_config_claude.bak-')) throw new Error(secret);
    return fs.writeFileSync(name, ...args);
  };
  await faultRun(f, injected);
  assert.equal(row(f), before);
  assert.ok(!fs.existsSync(script(f)));
  const db = new DatabaseSync(f.dbPath);
  db.exec('BEGIN IMMEDIATE; ROLLBACK');
  db.close();
});

test('post-commit script failure reports partial completion and rerun recovers', () => {
  const f = fixture();
  const hooks = path.dirname(script(f));
  fs.writeFileSync(hooks, 'blocking file');
  const r = run(f);
  assert.equal(r.code, 1);
  assert.match(r.out, /Template transaction committed/);
  assert.ok(!/Installed in CC Switch/.test(r.out));
  assert.equal(JSON.parse(row(f)).hooks.Stop.length, 1);
  fs.unlinkSync(hooks);
  assert.equal(run(f).code, 0);
  assert.deepEqual(fs.readFileSync(script(f)), fs.readFileSync(new URL('../cache-keepalive.mjs', import.meta.url)));
});

test('failed atomic script write preserves old bytes and cleans temporary files', async () => {
  for (const failure of ['write', 'rename']) {
    const f = fixture();
    fs.mkdirSync(path.dirname(script(f)));
    const old = Buffer.from('old installed script must remain complete');
    fs.writeFileSync(script(f), old);
    const injected = Object.create(fs);
    injected.copyFileSync = (from, to, ...args) => {
      if (to === script(f)) { fs.writeFileSync(to, 'partial'); throw new Error(secret); }
      return fs.copyFileSync(from, to, ...args);
    };
    let temporaryFd;
    injected.openSync = (name, ...args) => {
      const fd = fs.openSync(name, ...args);
      if (String(name).endsWith('.tmp')) temporaryFd = fd;
      return fd;
    };
    injected.writeFileSync = (name, data, ...args) => {
      if (name === temporaryFd && failure === 'write') { fs.writeFileSync(name, 'partial', ...args); throw new Error(secret); }
      return fs.writeFileSync(name, data, ...args);
    };
    injected.renameSync = (from, to) => {
      if (to === script(f) && failure === 'rename') throw new Error(secret);
      return fs.renameSync(from, to);
    };
    await faultRun(f, injected);
    assert.deepEqual(fs.readFileSync(script(f)), old);
    assert.ok(!fs.readdirSync(path.dirname(script(f))).some((name) => name.endsWith('.tmp')));
    assert.equal(JSON.parse(row(f)).hooks.Stop.length, 1);
    assert.deepEqual(fs.readFileSync(path.join(path.dirname(script(f)), 'cache-keepalive.mjs.bak-fault-fixture')), old);
  }
});

test('sqlite import rejection prints safe compatibility hint without writes', async () => {
  const f = fixture();
  const before = fs.readFileSync(f.dbPath);
  await faultRun(f, fs, true);
  assert.deepEqual(fs.readFileSync(f.dbPath), before);
  assert.equal(backups(f).length, 0);
  assert.ok(!fs.existsSync(script(f)));
});

test('installer SQL reads only the targeted template row', () => {
  const source = fs.readFileSync(installer, 'utf8');
  const selects = source.match(/\bSELECT\s+[^'"`\n;]*/gi) ?? [];
  assert.ok(selects.length > 0);
  for (const sql of selects) assert.match(sql, /^SELECT value FROM settings WHERE key\s*=\s*\?/i);
  assert.ok(!/FROM\s+(?:providers|request_logs)|path\.join\(ccSwitchDir,\s*['"]settings\.json/.test(source));
});
