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

function isOurHandler(h) {
  if (!h || h.type !== 'command' || typeof h.command !== 'string') return false;
  const words = [...h.command.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g)]
    .map((match) => match[1] ?? match[2] ?? match[3]);
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
    if (rest.length > 0) kept.push(rest.length === group.hooks.length ? group : { ...group, hooks: rest });
  }
  settings.hooks.Stop = kept;
  if (prune) {
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

say(`Claude config dir: ${configDir}${dryRun ? '  (dry run, nothing will be written)' : ''}`);

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
  say('  Add the same Stop hook to CC Switch > common config, or it will be lost on the next switch.');
}
say(dryRun ? 'Dry run finished.' : '✓ Installed. Claude Code picks up the hook without a restart.');
