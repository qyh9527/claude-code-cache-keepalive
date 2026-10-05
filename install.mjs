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

// 判断一个 hook handler 是不是本工具装的：按脚本文件名识别（exec 形式与 shell 形式都认）
function isOurHandler(h) {
  if (!h || typeof h !== 'object') return false;
  const parts = [h.command, ...(Array.isArray(h.args) ? h.args : [])].filter((x) => typeof x === 'string');
  return parts.some((p) => p.includes(SCRIPT_NAME));
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
  if (fs.existsSync(settingsPath)) {
    const backup = `${settingsPath}.bak-${stamp()}`;
    fs.copyFileSync(settingsPath, backup);
    say(`  backup: ${backup}`);
  }
  fs.mkdirSync(configDir, { recursive: true });
  const tmp = `${settingsPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
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
