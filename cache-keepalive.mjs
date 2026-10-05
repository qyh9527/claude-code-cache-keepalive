// cache-keepalive.mjs — Claude Code Stop hook（asyncRewake）。
//
// 目的：主会话在等后台任务时，prompt cache 的 5 分钟 TTL 会过期。本 hook 在后台睡到
// 「锚点 + 270s」，若期间没有任何活动（transcript 没出现新条目、CC Switch 没有新的主会话
// 请求），就写一句唤醒语到 stderr 并 exit 2，让空闲的主会话发一轮极短请求，把缓存续上。
//
// 约定：exit 2 + stderr 一句话 = 唤醒；exit 0 = 静默退出；任何异常一律 exit 0。
// 环境变量（测试用）：
//   CACHE_KEEPALIVE_DIR（状态与日志目录）/ CACHE_KEEPALIVE_DB（cc-switch 库路径）
//   CACHE_KEEPALIVE_SETTLE_S / CACHE_KEEPALIVE_FIRE_AFTER_S
// 子代理模型可用 CLAUDE_CODE_SUBAGENT_MODEL 排除，避免它的请求被当成主会话请求。
// 按次指定的子代理模型（Agent 调用里的 model 参数）靠 transcript 里主会话最后一条 assistant 的
// message.model 过滤库里的 model 列；已知限制：子代理与主会话同模型时无法区分。
//
// 命令行参数：
//   --any-model  不限 Claude 系列：主会话请求不再要求模型名像 Claude，上游是任何模型都保活。
//                适合其他也有短 TTL prompt cache 的上游；默认只对 Claude 生效。
//
// 只用 Node 内置模块。node:sqlite 会发出 ExperimentalWarning，而 exit 2 时 stderr
// 会原样交给模型，所以先摘掉 warning 监听再动态 import。

process.removeAllListeners('warning');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const STATE_DIR = process.env.CACHE_KEEPALIVE_DIR || path.join(os.tmpdir(), 'cache-keepalive');
const LOG_FILE = path.join(STATE_DIR, 'log.jsonl');
const LOG_ROTATED = path.join(STATE_DIR, 'log.1.jsonl');
const DB_PATH = process.env.CACHE_KEEPALIVE_DB || path.join(os.homedir(), '.cc-switch', 'cc-switch.db');

function numEnv(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}
const SETTLE_MS = numEnv('CACHE_KEEPALIVE_SETTLE_S', 8) * 1000;
const FIRE_AFTER_MS = numEnv('CACHE_KEEPALIVE_FIRE_AFTER_S', 270) * 1000;

const SAME_PERIOD_MS = 180000;      // 距上次唤醒 <3min 且 stop_hook_active=true 才视作同一空闲期续跑
const CAP_MS = 60 * 60 * 1000;      // 单个空闲期最长 60 分钟
const MAX_WAKES = 8;                // 单个空闲期最多 8 次唤醒（对齐 Claude Code 连续 8 次 stop hook 续跑上限）
const GUARD_MS = 330 * 1000;        // hook 配置 timeout 360s，留 30s 余量
const ANCHOR_FALLBACK_MS = 30000;   // 查不到库时的兜底锚点：Stop 前 30 秒
const STALE_MS = 300000;            // 锚点比现在旧超过 5 分钟就不再唤醒（缓存早过期了）
const SHELL_MAX_AGE_MS = 20 * 60 * 1000; // shell 任务存活超过 20 分钟视为常驻，不再保活
const TRANSCRIPT_TAIL_BYTES = 256 * 1024; // transcript 活动检测只看最后 256KB
const TRANSCRIPT_LAG_MS = 2000;     // 时间戳要晚于 hookStart+2s 才算活动
const LOG_MAX_BYTES = 1024 * 1024;  // 日志超过 1MB 就轮转

const TASK_TYPES = new Set(['subagent', 'shell', 'workflow']);
const ACTIVE_STATUSES = new Set(['running', 'pending']);

// shell 任务命中了这些模式 = 常驻进程（dev server / watch / tail -f 之类），不保活。
const PERSISTENT_PATTERNS = [
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve|watch|preview)\b/i,
  /\b(vite|nodemon|http-server|live-server|uvicorn|jupyter)\b/i,
  /\b(next|nuxt|astro|tauri)\s+dev\b/i,
  /\bng\s+serve\b/i,
  /\bwebpack(-dev-server|\s+serve)\b/i,
  /\bcargo\s+(watch|tauri\s+dev)\b/i,
  /\bflask\s+run\b/i,
  /\bpython\d*\s+-m\s+http\.server\b/i,
  /\bollama\s+serve\b/i,
  /--watch\b/i,
  /\btsc\b.*\s-w\b/i,
  /\btail\s+-f\b/i,
  /\bGet-Content\b.*\s-Wait\b/i,
];
// docker compose up 是常驻的，但带 -d/--detach 会立刻返回，分两步判断（不用环视）。
const DOCKER_UP_RE = /\bdocker(\s+compose|-compose)\s+up\b/i;
const DOCKER_DETACH_RE = /(^|\s)-d(\s|$)|--detach\b/i;

const SUBAGENT_MODEL = typeof process.env.CLAUDE_CODE_SUBAGENT_MODEL === 'string'
  ? process.env.CLAUDE_CODE_SUBAGENT_MODEL.trim()
  : '';
const ANY_MODEL = process.argv.slice(2).includes('--any-model');

const wakeMessage = (n) =>
  `[cache-keepalive] 后台任务仍在运行，这是自动缓存保活唤醒（第 ${n} 次）。` +
  `请只回复“保活”两个字，不要调用任何工具，不要输出任何其他内容。\n`;

const nowIso = () => new Date().toISOString();
const secs = (ms) => Math.round(ms / 10) / 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const safeSessionName = (s) => s.replace(/[^A-Za-z0-9._-]/g, '_');

// —— 日志：只写数值与枚举，绝不写 last_assistant_message / description / command ——
function log(rec) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    try {
      if (fs.statSync(LOG_FILE).size > LOG_MAX_BYTES) fs.renameSync(LOG_FILE, LOG_ROTATED);
    } catch {
      /* 没有旧日志或轮转失败：忽略 */
    }
    fs.appendFileSync(LOG_FILE, JSON.stringify(rec) + '\n');
  } catch {
    /* 日志失败不能影响主流程 */
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      try { process.stdin.destroy(); } catch { /* ignore */ }
      resolve(data);
    };
    try {
      if (process.stdin.isTTY) return done();
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (c) => { data += c; });
      process.stdin.on('end', done);
      process.stdin.on('error', done);
      process.stdin.on('close', done);
    } catch {
      done();
    }
  });
}

// —— 状态文件 / 任务文件：都是「写临时文件再 rename」 ——
function readJsonFile(p, fallback) {
  try {
    const v = JSON.parse(fs.readFileSync(p, 'utf8'));
    return v && typeof v === 'object' ? v : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonFile(p, obj) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${p}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, p); // Windows 上 rename 覆盖已存在文件
}

function deleteFile(p) {
  try { fs.rmSync(p, { force: true }); } catch { /* ignore */ }
}

// —— CC Switch 请求起点：每次查询开一个只读连接，查完立刻 close ——
// 过滤主会话请求：request_model 含 claude/opus/sonnet/fable（兼容 CC/claude-… 这类带前缀的名字）
// 且不是 haiku 旁路；若知道子代理模型名，再排掉它。--any-model 时不要求模型名像 Claude。
// okOnly=true 只取 status_code=200 的成功请求：502 等失败请求没到上游，不会刷新缓存，
// 不能当锚点。判断「会话是否恢复活动」时则用 okOnly=false，任何状态的请求都算活动。
let sqliteModule = null;
// 返回 { start, model } 或 null；model 是上游真实模型名（CC Switch 切到非 Claude 供应商时会变）
// mainModel（可选）：主会话模型，非空时只取上游模型 model 列与它相等的行，排除按次指定模型的子代理请求。
async function queryLatestRow(sessionId, { okOnly = false, mainModel = null } = {}) {
  let db = null;
  try {
    if (sqliteModule === null) sqliteModule = await import('node:sqlite');
    db = new sqliteModule.DatabaseSync(DB_PATH, { readOnly: true });
    let sql =
      'select created_at, latency_ms, model from proxy_request_logs ' +
      'where session_id = ? ' +
      (ANY_MODEL
        ? ''
        : "and (request_model like '%claude%' or request_model like '%opus%' " +
          "or request_model like '%sonnet%' or request_model like '%fable%') ") +
      "and coalesce(request_model, '') not like '%haiku%' ";
    const params = [sessionId];
    if (SUBAGENT_MODEL) {
      sql += 'and request_model <> ? ';
      params.push(SUBAGENT_MODEL);
    }
    if (mainModel) {
      sql += 'and model = ? ';
      params.push(mainModel);
    }
    if (okOnly) sql += 'and status_code = 200 ';
    sql += 'order by (created_at*1000 - coalesce(latency_ms,0)) desc limit 1';
    const row = db.prepare(sql).get(...params);
    if (!row || typeof row.created_at !== 'number') return null;
    const latency = Number(row.latency_ms ?? 0);
    return {
      start: row.created_at * 1000 - (Number.isFinite(latency) ? latency : 0),
      model: row.model != null ? String(row.model) : null,
    };
  } catch {
    return null; // 库不存在 / 表不存在 / 锁冲突 → 交给 fallback
  } finally {
    if (db !== null) {
      try { db.close(); } catch { /* ignore */ }
    }
  }
}

// 上游不是 Claude（例如切到 DeepSeek）就没有 5 分钟缓存问题，保活是白花钱。
const CLAUDE_MODEL_RE = /claude|opus|sonnet|fable/i;
const looksClaudeModel = (m) => typeof m === 'string' && CLAUDE_MODEL_RE.test(m);
const upstreamAllowed = (m) => ANY_MODEL || looksClaudeModel(m);

// —— transcript 活动检测 ——
// 只看 mtime/size 变化不够，Stop 自己也会写 assistant + system/stop_hook_summary（时间戳
// ≈ Stop 时刻），那不是「会话恢复」。所以尾巴里必须有一行时间戳晚于 hookStart+2s 的条目。
function snapshotFile(p) {
  try {
    const st = fs.statSync(p);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

function parseTsMs(t) {
  if (typeof t === 'number' && Number.isFinite(t)) return t < 1e12 ? t * 1000 : t;
  if (typeof t === 'string') {
    const v = Date.parse(t);
    if (Number.isFinite(v)) return v;
  }
  return null;
}

// 读 transcript 最后 TRANSCRIPT_TAIL_BYTES，返回按行切好的数组；读不了返回 null
function readTranscriptTail(p, size) {
  let text;
  let start = 0;
  try {
    const fd = fs.openSync(p, 'r');
    try {
      start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
      const len = Math.max(0, size - start);
      const buf = Buffer.alloc(len);
      const n = len > 0 ? fs.readSync(fd, buf, 0, len, start) : 0;
      text = buf.subarray(0, n).toString('utf8');
    } finally {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  } catch {
    return null;
  }
  const lines = text.split('\n');
  if (start > 0) lines.shift(); // 从中间开始读时，第一行可能被截断
  return lines;
}

function parseJsonLine(line) {
  const s = line.trim();
  if (!s) return null;
  try {
    const o = JSON.parse(s);
    return o && typeof o === 'object' ? o : null;
  } catch {
    return null;
  }
}

// 只有主会话自己的 user / assistant 条目才代表「会话开了新一轮」。queue-operation（后台任务通知
// 入队又立刻移除）、attachment、system、pr-link 等都不是；子代理（isSidechain）的条目也不是。
const isMainTurnEntry = (o) => (o.type === 'user' || o.type === 'assistant') && o.isSidechain !== true;

// 主会话模型：transcript 尾部最后一条主会话 assistant 的 message.model；取不到返回 null。
// 跳过 Claude Code 自己合成的 "<synthetic>" 占位模型。
function readMainModel(p) {
  const cur = snapshotFile(p);
  if (cur === null) return null;
  const lines = readTranscriptTail(p, cur.size);
  if (lines === null) return null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const o = parseJsonLine(lines[i]);
    if (!o || o.type !== 'assistant' || o.isSidechain === true) continue;
    const m = o.message && typeof o.message === 'object' ? o.message.model : null;
    if (typeof m === 'string' && m.trim() && !m.startsWith('<')) return m.trim();
  }
  return null;
}

// 返回 'idle' | 'active' | 'unreadable'
function checkTranscript(p, snap, hookStart) {
  const cur = snapshotFile(p);
  if (cur === null) return 'unreadable';
  if (cur.mtimeMs === snap.mtimeMs && cur.size === snap.size) return 'idle';
  const lines = readTranscriptTail(p, cur.size);
  if (lines === null) return 'unreadable';
  const threshold = hookStart + TRANSCRIPT_LAG_MS;
  for (const line of lines) {
    const o = parseJsonLine(line);
    if (!o || !isMainTurnEntry(o)) continue;
    const ms = parseTsMs(o.timestamp);
    if (ms !== null && ms > threshold) return 'active';
  }
  return 'idle';
}

function isPersistentCommand(text) {
  for (const re of PERSISTENT_PATTERNS) if (re.test(text)) return true;
  if (DOCKER_UP_RE.test(text) && !DOCKER_DETACH_RE.test(text)) return true;
  return false;
}

// —— 活跃任务筛选（含 shell 常驻判定与 20 分钟存活上限）——
// tasksFilePath 记录 shell 任务首次出现时间，只保留本次 background_tasks 里出现过的 id。
function selectActiveTasks(tasks, tasksFilePath, hookStart) {
  const ignored = [];
  const prevSeen = readJsonFile(tasksFilePath, {});
  const nextSeen = {};
  const active = [];

  for (const t of tasks) {
    if (!t || typeof t !== 'object') continue;
    const type = t.type != null ? String(t.type).toLowerCase() : '';
    const status = typeof t.status === 'string' ? t.status.toLowerCase() : '';
    if (!TASK_TYPES.has(type) || !ACTIVE_STATUSES.has(status)) continue;

    if (type === 'shell') {
      let raw = '';
      if (typeof t.command === 'string' && t.command) {
        raw = t.command;
      } else if (typeof t.description === 'string') {
        raw = t.description;
      }
      if (isPersistentCommand(raw)) {
        ignored.push({ type, reason: 'persistent-pattern' });
        continue;
      }
      if (t.id != null) {
        const id = String(t.id);
        const firstSeen =
          typeof prevSeen[id] === 'number' && Number.isFinite(prevSeen[id]) ? prevSeen[id] : hookStart;
        nextSeen[id] = firstSeen;
        if (hookStart - firstSeen > SHELL_MAX_AGE_MS) {
          ignored.push({ type, reason: 'too-old' });
          continue;
        }
      }
    }
    active.push(t);
  }

  try { writeJsonFile(tasksFilePath, nextSeen); } catch { /* ignore */ }
  return { active, ignored };
}

let SESSION = null;
let LOGGED_ERROR = false;

// 兜底：任何未捕获异常也要留下日志，并且绝不能以 exit 2 去唤醒会话
function emergencyLog(reason) {
  if (LOGGED_ERROR) return;
  LOGGED_ERROR = true;
  try {
    log({ ts: nowIso(), session: SESSION, decision: 'error', reason: String(reason).slice(0, 200) });
  } catch {
    /* 连日志都写不了就算了 */
  }
}
process.on('uncaughtException', (err) => {
  emergencyLog((err && err.message) || err);
  process.exit(0);
});
process.on('unhandledRejection', (reason) => {
  emergencyLog((reason && reason.message) || reason);
  process.exit(0);
});

async function main() {
  const hookStart = Date.now();
  const owner = crypto.randomBytes(12).toString('hex');

  const raw = await readStdin();
  let input = null;
  try { input = JSON.parse(raw); } catch { /* → bad-input */ }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    log({ ts: nowIso(), session: null, decision: 'skip', reason: 'bad-input' });
    return 0;
  }

  const session =
    typeof input.session_id === 'string' && input.session_id.trim() ? input.session_id.trim() : null;
  SESSION = session;
  const stopHookActive = typeof input.stop_hook_active === 'boolean' ? input.stop_hook_active : null;
  const tasks = Array.isArray(input.background_tasks) ? input.background_tasks : [];
  const taskSummary = tasks.map((t) => ({
    type: t && t.type != null ? String(t.type) : null,
    status: t && t.status != null ? String(t.status) : null,
  }));

  if (!session) {
    log({ ts: nowIso(), session: null, decision: 'skip', reason: 'bad-input', stopHookActive, tasks: taskSummary });
    return 0;
  }

  const baseName = safeSessionName(session);
  const statePath = path.join(STATE_DIR, `${baseName}.json`);
  const tasksPath = path.join(STATE_DIR, `${baseName}.tasks.json`);

  // 1. 是否有活跃任务（subagent / shell / workflow，status running|pending；shell 另有常驻与存活判定）
  const { active, ignored } = selectActiveTasks(tasks, tasksPath, hookStart);
  if (active.length === 0) {
    // 没有活跃任务：顺手删掉本会话状态，让还在睡眠的旧实例醒来后判定为 superseded
    deleteFile(statePath);
    log({
      ts: nowIso(),
      session,
      decision: 'exit',
      reason: 'no-task',
      stopHookActive,
      tasks: taskSummary,
      ignored,
    });
    return 0;
  }

  // 2. 状态文件：只有 stop_hook_active=true 且距上次唤醒 <3min 才算同一空闲期的续跑
  const prev = readJsonFile(statePath, null);
  let periodStart = hookStart;
  let wakes = 0;
  let carriedLastWakeAt = null;
  if (
    prev &&
    input.stop_hook_active === true &&
    typeof prev.lastWakeAt === 'number' &&
    Number.isFinite(prev.lastWakeAt) &&
    hookStart - prev.lastWakeAt < SAME_PERIOD_MS &&
    typeof prev.periodStart === 'number' &&
    Number.isFinite(prev.periodStart)
  ) {
    periodStart = prev.periodStart;
    wakes = Number.isFinite(prev.wakes) ? prev.wakes : 0;
    carriedLastWakeAt = prev.lastWakeAt;
  }
  writeJsonFile(statePath, { periodStart, wakes, lastWakeAt: carriedLastWakeAt, owner });

  const ctx = {
    session,
    stopHookActive,
    tasks: taskSummary,
    ignored,
    anchorSource: null,
    anchorAgeS: null,
    upstreamModel: null,
    mainModel: null,
    wakes,
    periodAgeS: null,
    late: false,
    ...(ANY_MODEL ? { anyModel: true } : {}),
  };
  const stamp = () => ({ ts: nowIso(), ...ctx });

  if (hookStart - periodStart >= CAP_MS || wakes >= MAX_WAKES) {
    log({ ...stamp(), decision: 'exit', reason: 'cap', periodAgeS: secs(hookStart - periodStart), wakes });
    return 0;
  }

  // 3. transcript 快照（settle 之前定基线）
  const transcriptPath =
    typeof input.transcript_path === 'string' && input.transcript_path ? input.transcript_path : null;
  const snap = transcriptPath !== null ? snapshotFile(transcriptPath) : null;
  if (snap === null) {
    log({ ...stamp(), decision: 'exit', reason: 'transcript-unreadable' });
    return 0;
  }

  // 4. 锚点（只认成功的主会话请求）
  // 主会话模型 Stop 时读一次：最后一轮主回复此刻已写入 transcript
  const mainModel = readMainModel(transcriptPath);
  ctx.mainModel = mainModel;
  let anchor;
  let anchorSource;
  let anchorModel = null;
  const a0 = await queryLatestRow(session, { okOnly: true, mainModel });
  if (a0 !== null) {
    anchor = a0.start;
    anchorModel = a0.model;
    anchorSource = 'ccswitch';
  } else {
    anchor = hookStart - ANCHOR_FALLBACK_MS;
    anchorSource = 'fallback';
  }

  // 5. settle 后重查锚点（Stop 时最后一个请求可能还没写进库），再判断锚点是否已过期
  await sleep(SETTLE_MS);
  if (process.env.CACHE_KEEPALIVE_TEST_THROW) {
    // 仅测试用：模拟异步崩溃，验证 uncaughtException 兜底会写日志并 exit 0
    setTimeout(() => { throw new Error('test-throw-async'); }, 5);
    await sleep(50);
  }
  const a1 = await queryLatestRow(session, { okOnly: true, mainModel });
  if (a1 !== null && (anchorSource === 'fallback' || a1.start > anchor)) {
    anchor = a1.start;
    anchorModel = a1.model;
    anchorSource = 'ccswitch';
  }
  if (anchorSource === 'ccswitch') {
    ctx.anchorSource = anchorSource;
    ctx.upstreamModel = anchorModel;
    ctx.anchorAgeS = secs(Date.now() - anchor);
    if (!upstreamAllowed(anchorModel)) {
      log({ ...stamp(), decision: 'exit', reason: 'non-claude-model' });
      return 0;
    }
    if (Date.now() - anchor > STALE_MS) {
      log({ ...stamp(), decision: 'exit', reason: 'stale-anchor' });
      return 0;
    }
  }

  // 6. 等到目标时刻决断
  const guardAt = hookStart + GUARD_MS;
  let late = false;
  for (;;) {
    const now0 = Date.now();
    if (now0 >= guardAt) {
      log({ ...stamp(), decision: 'exit', reason: 'timeout-guard', anchorSource, anchorAgeS: secs(now0 - anchor), late });
      return 0;
    }
    const target = anchor + FIRE_AFTER_MS;
    if (now0 < target) await sleep(Math.min(target - now0, guardAt - now0));
    if (Date.now() >= guardAt) {
      log({ ...stamp(), decision: 'exit', reason: 'timeout-guard', anchorSource, anchorAgeS: secs(Date.now() - anchor), late });
      return 0;
    }
    late = Date.now() > target;
    ctx.anchorSource = anchorSource;
    ctx.late = late;

    // a. 被同会话的新一轮 Stop 接管
    const st = readJsonFile(statePath, null);
    if (!st || st.owner !== owner) {
      log({ ...stamp(), decision: 'exit', reason: 'superseded', anchorAgeS: secs(Date.now() - anchor) });
      return 0;
    }

    // b. transcript 出现新条目 → 会话本来就活跃
    const tr = checkTranscript(transcriptPath, snap, hookStart);
    if (tr === 'unreadable') {
      log({ ...stamp(), decision: 'exit', reason: 'transcript-unreadable', anchorAgeS: secs(Date.now() - anchor) });
      return 0;
    }
    if (tr === 'active') {
      log({ ...stamp(), decision: 'exit', reason: 'activity-transcript', anchorAgeS: secs(Date.now() - anchor) });
      return 0;
    }

    // c. 库里有新请求：先看「任何状态」（失败请求也算活动），再单独看成功请求是否推进锚点
    const anyRow = await queryLatestRow(session, { okOnly: false, mainModel });
    if (anyRow !== null && anyRow.start > hookStart) {
      log({ ...stamp(), decision: 'exit', reason: 'activity-ccswitch', anchorSource, anchorAgeS: secs(Date.now() - anchor) });
      return 0;
    }
    const okRow = await queryLatestRow(session, { okOnly: true, mainModel });
    // 兜底锚点只是估算：查到真实成功请求就无条件采用；已有真实锚点时只接受更晚的请求
    if (okRow !== null && (anchorSource === 'fallback' || okRow.start > anchor)) {
      anchor = okRow.start; // Stop 前发出、晚写入库的成功请求：锚点前移，重新计时
      anchorModel = okRow.model;
      anchorSource = 'ccswitch';
      ctx.anchorSource = anchorSource;
      ctx.upstreamModel = anchorModel;
      ctx.anchorAgeS = secs(Date.now() - anchor);
      if (!upstreamAllowed(anchorModel)) { // 新的一行也要确认上游仍是 Claude（--any-model 时不限）
        log({ ...stamp(), decision: 'exit', reason: 'non-claude-model' });
        return 0;
      }
      if (Date.now() - anchor > STALE_MS) {
        log({ ...stamp(), decision: 'exit', reason: 'stale-anchor' });
        return 0;
      }
      continue;
    }

    // d. 重新确认上限
    const nowD = Date.now();
    if (nowD - periodStart >= CAP_MS || wakes >= MAX_WAKES) {
      log({ ...stamp(), decision: 'exit', reason: 'cap', periodAgeS: secs(nowD - periodStart), wakes });
      return 0;
    }

    // e. 决断：唤醒前把 guard / 锚点新鲜度 / owner / transcript 全部紧挨着再确认一次
    const nowE = Date.now();
    if (nowE >= guardAt) {
      log({ ...stamp(), decision: 'exit', reason: 'timeout-guard', anchorSource, anchorAgeS: secs(nowE - anchor), late });
      return 0;
    }
    if (nowE - anchor > STALE_MS) {
      log({ ...stamp(), decision: 'exit', reason: 'stale-anchor', anchorSource, anchorAgeS: secs(nowE - anchor) });
      return 0;
    }
    const stE = readJsonFile(statePath, null);
    if (!stE || stE.owner !== owner) {
      log({ ...stamp(), decision: 'exit', reason: 'superseded', anchorAgeS: secs(nowE - anchor) });
      return 0;
    }
    const trE = checkTranscript(transcriptPath, snap, hookStart);
    if (trE === 'unreadable') {
      log({ ...stamp(), decision: 'exit', reason: 'transcript-unreadable', anchorAgeS: secs(nowE - anchor) });
      return 0;
    }
    if (trE === 'active') {
      log({ ...stamp(), decision: 'exit', reason: 'activity-transcript', anchorAgeS: secs(nowE - anchor) });
      return 0;
    }

    wakes += 1;
    const lastWakeAt = Date.now();
    writeJsonFile(statePath, { periodStart, wakes, lastWakeAt, owner });
    log({
      ...stamp(),
      decision: 'wake',
      reason: null,
      anchorSource,
      anchorAgeS: secs(lastWakeAt - anchor),
      wakes,
      periodAgeS: secs(lastWakeAt - periodStart),
      late,
    });
    process.stderr.write(wakeMessage(wakes));
    return 2;
  }
}

let code = 0;
try {
  code = await main();
} catch (err) {
  try {
    const msg = String((err && err.message) || err).slice(0, 200);
    log({ ts: nowIso(), session: SESSION, decision: 'error', reason: msg });
  } catch { /* ignore */ }
  code = 0;
}
if (code === 2) {
  process.exitCode = 2; // 让事件循环自然收尾，别用 process.exit 截断 stderr
} else {
  process.exit(0);
}
