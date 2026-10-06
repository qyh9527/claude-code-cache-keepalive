#!/usr/bin/env node
// 安装 / 卸载 cache-keepalive Stop hook。只用 Node 内置模块，可重复运行。
//
//   node install.mjs               安装或升级
//   node install.mjs --dry-run     只显示将要做的改动
//   node install.mjs --uninstall   移除 hook 配置和脚本（保留日志）
//   node install.mjs --any-model   安装不限 Claude 系列的版本（上游是任何模型都保活）
//   node install.mjs --config-dir <dir>   指定 Claude 配置目录（默认 $CLAUDE_CONFIG_DIR 或 ~/.claude）

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_NAME = 'cache-keepalive.mjs';
const HOOK_TIMEOUT = 360;
const MIN_NODE = [22, 13];

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const uninstall = args.includes('--uninstall');
const anyModel = args.includes('--any-model');
const ccSwitch = args.includes('--cc-switch');
const ccDirFlag = args.indexOf('--cc-switch-dir');
if (ccDirFlag >= 0 && (!ccSwitch || !args[ccDirFlag + 1] || args[ccDirFlag + 1].startsWith('--'))) {
  console.error('--cc-switch-dir requires --cc-switch and a directory value.');
  process.exit(1);
}
const ccSwitchDir = path.resolve(ccDirFlag >= 0 ? args[ccDirFlag + 1] : path.join(os.homedir(), '.cc-switch'));
const dirFlag = args.indexOf('--config-dir');
const configDir = path.resolve(
  dirFlag >= 0 && args[dirFlag + 1]
    ? args[dirFlag + 1]
    : process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
);
const settingsPath = path.join(configDir, 'settings.json');
const targetScript = path.join(configDir, 'hooks', SCRIPT_NAME);
const sourceScript = path.join(path.dirname(fileURLToPath(import.meta.url)), SCRIPT_NAME);

const say = (msg) => console.log(msg);
function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

// 只识别 node 实际执行的脚本；相似文件名及传给其他脚本的数据参数都不属于本工具。
const portableBasename = (p) => p.replaceAll('\\', '/').split('/').at(-1);
// Node CLI 的带值选项必须连同参数一起跳过，参数即使恰好是本脚本名也不能表示归属。
const NODE_VALUE_OPTIONS = new Set([
  '-r', '--require', '-C', '--conditions', '--import', '--loader', '--experimental-loader',
  '--env-file', '--env-file-if-exists', '--experimental-config-file', '--experimental-default-type',
  '--allow-fs-read', '--allow-fs-write', '--build-snapshot-config', '--experimental-sea-config',
  '--cpu-prof-dir', '--cpu-prof-interval', '--cpu-prof-name', '--diagnostic-dir', '--disable-proto',
  '--disable-warning', '--dns-result-order', '--heap-prof-dir', '--heap-prof-interval', '--heap-prof-name',
  '--heapsnapshot-near-heap-limit', '--heapsnapshot-signal', '--icu-data-dir', '--input-type',
  '--debug-port', '--inspect-port', '--inspect-publish-uid', '--localstorage-file', '--max-http-header-size',
  '--max-old-space-size', '--max-old-space-size-percentage', '--max-semi-space-size', '--stack-size',
  '--network-family-autoselection-attempt-timeout', '--openssl-config', '--redirect-warnings',
  '--report-directory', '--report-dir', '--report-filename', '--report-signal', '--secure-heap',
  '--secure-heap-min', '--snapshot-blob', '--test-concurrency', '--test-coverage-branches',
  '--test-coverage-exclude', '--test-coverage-functions', '--test-coverage-include', '--test-coverage-lines',
  '--test-global-setup', '--experimental-test-isolation', '--test-isolation', '--test-name-pattern',
  '--test-random-seed', '--test-reporter', '--test-reporter-destination', '--test-rerun-failures',
  '--test-shard', '--test-skip-pattern', '--test-timeout', '--experimental-test-tag-filter', '--title',
  '--tls-cipher-list', '--tls-keylog', '--trace-event-categories', '--trace-event-file-pattern',
  '--trace-require-module', '--unhandled-rejections', '--use-largepages', '--v8-pool-size',
  '--watch-kill-signal', '--watch-path',
]);
const NODE_NON_SCRIPT_OPTIONS = new Set([
  '-e', '--eval', '-p', '--print', '-c', '--check', '-h', '--help', '-v', '--version',
  '--run', '--v8-options', '--completion-bash',
]);

function isOurNodeScript(argv) {
  const matches = (arg) => typeof arg === 'string' && portableBasename(arg) === SCRIPT_NAME;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (typeof arg !== 'string') return false;
    if (arg === '--') return matches(argv[i + 1]);
    if (arg === '-') return false; // 标准输入，不执行路径参数
    if (!arg.startsWith('-')) return matches(arg);
    const option = arg.split('=', 1)[0].replaceAll('_', '-');
    if (NODE_NON_SCRIPT_OPTIONS.has(option) || /^-[epc]/.test(arg)) return false;
    if (arg.startsWith('--') && arg.includes('=')) continue;
    if (/^-[rC].+/.test(arg)) continue; // -rmodule / -Ccondition
    if (NODE_VALUE_OPTIONS.has(option)) {
      if (typeof argv[++i] !== 'string') return false;
      continue;
    }
    if (!arg.startsWith('--') && arg !== '-i') return false;
  }
  return false;
}

// 把相邻的普通片段和引号片段合成一个参数，例如 --require="带空格的路径"。
// 不执行命令或展开变量；保留 Windows 路径中的普通反斜杠。
function commandWords(command) {
  const words = [];
  let word = '';
  let quote = null;
  let started = false;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    const next = command[i + 1];
    if (char === '\\' && quote !== "'" && next !== undefined &&
        (next === '"' || next === '\\' || (quote === null && /[ \t\r\n']/.test(next)))) {
      word += next;
      started = true;
      i += 1;
    } else if (quote !== null) {
      if (char === quote) quote = null;
      else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/[ \t\r\n]/.test(char)) {
      if (started) words.push(word);
      word = '';
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (quote !== null) return null;
  if (started) words.push(word);
  return words;
}

function isOurHandler(h) {
  if (!h || h.type !== 'command' || typeof h.command !== 'string') return false;
  const words = commandWords(h.command);
  if (words === null) return false;
  const executable = words.shift();
  if (!executable || !/^node(?:\.exe)?$/i.test(portableBasename(executable))) return false;
  return isOurNodeScript([...words, ...(Array.isArray(h.args) ? h.args : [])]);
}

function readSettings() {
  if (!fs.existsSync(settingsPath)) return {};
  const text = fs.readFileSync(settingsPath, 'utf8');
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('top level is not an object');
    return v;
  } catch (e) {
    fail(`${settingsPath} is not valid JSON (${e.message}). Fix it first; nothing was changed.`);
  }
}

function writeSettings(obj) {
  const mode = fs.existsSync(settingsPath) ? fs.statSync(settingsPath).mode & 0o777 : 0o600;
  if (fs.existsSync(settingsPath)) {
    const backup = `${settingsPath}.bak-${stamp()}`;
    fs.copyFileSync(settingsPath, backup);
    say(`  backup: ${backup}`);
  }
  fs.mkdirSync(configDir, { recursive: true });
  const tmp = `${settingsPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode, flag: 'wx' });
  fs.chmodSync(tmp, mode); // 保留原权限，包括被当前 umask 收紧的位；新配置默认仅所有者可读写
  fs.renameSync(tmp, settingsPath);
}

// 从 settings 里移除本工具的 handler，清掉因此变空的分组；prune=true 时再删掉空的 Stop / hooks。
// 安装时不 prune，避免 hooks 键被删了又追加到末尾、导致每次运行都改写文件。返回移除的个数
function removeOurHandlers(settings, { prune = false } = {}) {
  const stop = settings.hooks?.Stop;
  if (!Array.isArray(stop)) return 0;
  let removed = 0;
  const kept = [];
  for (const group of stop) {
    if (!group || !Array.isArray(group.hooks)) {
      kept.push(group);
      continue;
    }
    const rest = group.hooks.filter((h) => !isOurHandler(h));
    removed += group.hooks.length - rest.length;
    if (rest.length === group.hooks.length) kept.push(group);
    else if (rest.length > 0) kept.push({ ...group, hooks: rest });
  }
  settings.hooks.Stop = kept;
  if (prune && removed > 0) {
    if (kept.length === 0) delete settings.hooks.Stop;
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  }
  return removed;
}

function checkNode() {
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj < MIN_NODE[0] || (maj === MIN_NODE[0] && min < MIN_NODE[1])) {
    fail(`Node ${MIN_NODE.join('.')}+ is required for node:sqlite (found ${process.versions.node}).`);
  }
}

function validateTemplate(settings) {
  const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!object(settings)) throw new Error('Invalid template');
  if (Object.hasOwn(settings, 'hooks')) {
    if (!object(settings.hooks)) throw new Error('Invalid hooks');
    for (const groups of Object.values(settings.hooks)) {
      if (!Array.isArray(groups)) throw new Error('Invalid event');
      for (const group of groups) {
        if (!object(group) || !Array.isArray(group.hooks) || !group.hooks.every(object)) {
          throw new Error('Invalid group');
        }
      }
    }
  }
}

async function installCcSwitch() {
  checkNode();
  say('! Exit CC Switch before running this command.');
  say('  Restart it afterwards and switch providers / apply configuration to activate the template.');
  say('  Template uninstall removes only its handlers and preserves the shared script.');
  say('  Normal --uninstall deletes the script without checking template references; remove template handlers first if deleting it entirely.');
  const databasePath = path.join(ccSwitchDir, 'cc-switch.db');
  if (!fs.existsSync(databasePath)) fail('CC Switch database does not exist; nothing was changed.');
  let db;
  let transaction = false;
  let committed = false;
  let stage = 'open';
  let failure;
  try {
    stage = 'runtime';
    const { DatabaseSync } = await import('node:sqlite');
    stage = 'open';
    db = new DatabaseSync(databasePath, { readOnly: dryRun });
    db.exec('PRAGMA busy_timeout = 3000');
    if (!dryRun) {
      db.exec('BEGIN IMMEDIATE');
      transaction = true;
    }
    stage = 'validate';
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('common_config_claude');
    const original = row?.value;
    if (original !== undefined && typeof original !== 'string') throw new Error('Invalid value');
    const settings = original === undefined || original.trim() === '' ? {} : JSON.parse(original);
    validateTemplate(settings);
    const before = JSON.stringify(settings);
    const removed = removeOurHandlers(settings, { prune: uninstall });
    if (!uninstall) {
      settings.hooks ??= {};
      settings.hooks.Stop ??= [];
      settings.hooks.Stop.push({
        hooks: [{ type: 'command', command: 'node', args: [targetScript, ...(anyModel ? ['--any-model'] : [])], asyncRewake: true, timeout: HOOK_TIMEOUT }],
      });
    }
    const changed = JSON.stringify(settings) !== before;
    // Preflight only after the locked template has passed validation. Copy after commit:
    // SQL failures never replace the script, but later filesystem failures cannot undo the DB.
    stage = 'script';
    const src = uninstall ? null : fs.readFileSync(sourceScript);
    const existing = uninstall ? null : fs.existsSync(targetScript) ? fs.readFileSync(targetScript) : null;
    say(`• common_config_claude: ${changed ? (uninstall ? `remove ${removed} hook handler(s)` : 'configure Stop hook') : 'already configured'}`);
    say(`• script: ${uninstall ? 'preserved (shared script)' : (existing?.equals(src) ? 'up to date' : 'install / upgrade')}`);
    if (!dryRun) {
      if (changed) {
        stage = 'backup';
        if (row) {
          const backup = path.join(ccSwitchDir, `common_config_claude.bak-${stamp()}-${process.pid}`);
          fs.writeFileSync(backup, original, { mode: 0o600, flag: 'wx' });
          say('  Original template row backed up locally (not the database).');
        }
        stage = 'update';
        db.prepare('INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)')
          .run('common_config_claude', JSON.stringify(settings, null, 2) + '\n');
      }
      db.exec('COMMIT');
      transaction = false;
      committed = true;
      stage = 'script';
      if (!uninstall && !existing?.equals(src)) {
        fs.mkdirSync(path.dirname(targetScript), { recursive: true });
        if (existing) fs.copyFileSync(targetScript, `${targetScript}.bak-${stamp()}`);
        const tmp = `${targetScript}.${process.pid}.${stamp()}.tmp`;
        let created = false;
        try {
          const fd = fs.openSync(tmp, 'wx', 0o600);
          created = true;
          try { fs.writeFileSync(fd, src); }
          finally { fs.closeSync(fd); }
          fs.renameSync(tmp, targetScript);
          created = false;
        } finally {
          if (created) fs.rmSync(tmp);
        }
      }
    }
  } catch {
    // Never disclose SQLite or JSON errors: either can contain user secrets.
    failure = committed
      ? 'Template transaction committed, but the script operation failed. Resolve filesystem permissions and rerun; no success is claimed.'
      : stage === 'runtime'
        ? 'node:sqlite is unavailable. Use Node 22.x >=22.13, Node 23.x >=23.4, Node 24+, or enable --experimental-sqlite. Nothing was changed.'
      : stage === 'validate'
        ? 'CC Switch template or settings schema is invalid or unsupported; no template or script changes were made.'
        : 'CC Switch operation failed (database unavailable, locked, unsupported, or filesystem failure). No template changes were committed; a local row backup may remain.';
    if (transaction) {
      try { db.exec('ROLLBACK'); transaction = false; }
      catch { failure = 'CC Switch operation failed; rollback could not be confirmed. Check the local template before retrying.'; }
    }
  } finally {
    if (db) {
      try { db.close(); }
      catch { failure = 'CC Switch database close failed. Check the local template and script before retrying.'; }
    }
  }
  if (failure) fail(failure);
  say(dryRun ? 'Dry run finished.' : uninstall ? 'Uninstalled from CC Switch template. Logs and state were left in place.' : 'Installed in CC Switch template. Apply it in CC Switch to activate.');
}

say(`Claude config dir: ${configDir}${dryRun ? '  (dry run, nothing will be written)' : ''}`);

// Explicit opt-in only, before any settings.json read (including uninstall).
if (ccSwitch) {
  await installCcSwitch();
  process.exit(0);
}

if (uninstall) {
  const settings = readSettings();
  const removed = removeOurHandlers(settings, { prune: true });
  say(`• settings.json: remove ${removed} hook handler(s)`);
  say(`• script: ${fs.existsSync(targetScript) ? `delete ${targetScript}` : 'not installed'}`);
  if (!dryRun) {
    if (removed > 0) writeSettings(settings);
    fs.rmSync(targetScript, { force: true });
  }
  say(`Logs and state in ${path.join(os.tmpdir(), 'cache-keepalive')} were left in place.`);
  say(dryRun ? 'Dry run finished.' : '✓ Uninstalled.');
  process.exit(0);
}

checkNode();
if (!fs.existsSync(sourceScript)) fail(`${SCRIPT_NAME} not found next to install.mjs.`);
// 先读并校验 settings.json：它坏了就什么都不写，连脚本也不复制
const settings = readSettings();

// 1. 脚本：已有且内容不同就先备份再覆盖
const src = fs.readFileSync(sourceScript);
const existing = fs.existsSync(targetScript) ? fs.readFileSync(targetScript) : null;
if (existing && existing.equals(src)) {
  say(`• script: ${targetScript} is up to date`);
} else {
  say(`• script: ${existing ? 'upgrade' : 'install'} ${targetScript}`);
  if (!dryRun) {
    fs.mkdirSync(path.dirname(targetScript), { recursive: true });
    if (existing) fs.copyFileSync(targetScript, `${targetScript}.bak-${stamp()}`);
    fs.copyFileSync(sourceScript, targetScript);
  }
}

// 2. settings.json：去掉旧条目，追加一份标准条目；其他键和 hook 原样保留
const before = JSON.stringify(settings);
removeOurHandlers(settings);
settings.hooks ??= {};
settings.hooks.Stop ??= [];
settings.hooks.Stop.push({
  hooks: [{ type: 'command', command: 'node', args: [targetScript, ...(anyModel ? ['--any-model'] : [])], asyncRewake: true, timeout: HOOK_TIMEOUT }],
});
if (JSON.stringify(settings) === before) {
  say('• settings.json: Stop hook already configured');
} else {
  say(`• settings.json: ${before.includes(SCRIPT_NAME) ? 'update' : 'add'} Stop hook in ${settingsPath}`);
  if (!dryRun) writeSettings(settings);
}

if (fs.existsSync(path.join(os.homedir(), '.cc-switch'))) {
  say('');
  say('! CC Switch detected. CC Switch 3.x rewrites settings.json when you switch providers.');
  say('  Choose node install.mjs --cc-switch to install into its common config template, or add the hook there manually.');
}
say(dryRun ? 'Dry run finished.' : '✓ Installed. Claude Code picks up the hook without a restart.');
