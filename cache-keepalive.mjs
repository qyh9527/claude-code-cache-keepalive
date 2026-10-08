// cache-keepalive.mjs — Claude Code Stop hook (asyncRewake).
//
// Purpose: while the main session waits on background tasks, the prompt cache's 5-minute TTL
// expires. This hook sleeps in the background until "anchor + 270s"; if nothing happened in the
// meantime (no new transcript entries, no new main-session requests in CC Switch), it writes one
// wake line to stderr and exits 2, so the idle main session sends a very short request that
// refreshes the cache.
//
// Contract: exit 2 + one line on stderr = wake; exit 0 = quiet exit; any error always exits 0.
// Environment variables (for tests):
//   CACHE_KEEPALIVE_DIR (state and log directory) / CACHE_KEEPALIVE_DB (cc-switch database path)
//   CACHE_KEEPALIVE_SETTLE_S / CACHE_KEEPALIVE_FIRE_AFTER_S
// The subagent model can be excluded via CLAUDE_CODE_SUBAGENT_MODEL so its requests are not
// mistaken for main-session requests.
// Per-call subagent models (the model parameter of an Agent call) are filtered by matching the
// database model column against message.model of the main session's last assistant entry in the
// transcript; known limitation: a subagent using the same model as the main session cannot be told apart.
//
// Command-line arguments:
//   --any-model  Not limited to the Claude family: main-session requests no longer need a
//                Claude-like model name, and any upstream model is kept alive.
//                Useful for other upstreams that also have a short-TTL prompt cache; by default
//                only Claude is covered.
//
// Uses only Node built-in modules. node:sqlite emits an ExperimentalWarning, and on exit 2 stderr
// is passed to the model verbatim, so the warning listeners are removed before the dynamic import.

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

const SAME_PERIOD_MS = 180000;      // continue the same idle period only if <3min since last wake and stop_hook_active=true
const CAP_MS = 60 * 60 * 1000;      // a single idle period lasts at most 60 minutes
const MAX_WAKES = 8;                // at most 8 wakes per idle period (matches Claude Code's limit of 8 consecutive stop-hook continuations)
const GUARD_MS = 330 * 1000;        // hook timeout is configured as 360s; keep a 30s margin
const ANCHOR_FALLBACK_MS = 30000;   // fallback anchor when the database is unavailable: 30 seconds before Stop
const STALE_MS = 300000;            // stop waking once the anchor is more than 5 minutes old (the cache has already expired)
const SHELL_MAX_AGE_MS = 20 * 60 * 1000; // shell tasks alive for more than 20 minutes count as long-running; no keep-alive
const TRANSCRIPT_TAIL_BYTES = 256 * 1024; // transcript activity detection only looks at the last 256KB
const TRANSCRIPT_LAG_MS = 2000;     // 2s grace for assistant entries only, tolerating this turn's late Stop writes; a new user entry counts as activity immediately
const LOG_MAX_BYTES = 1024 * 1024;  // rotate the log once it exceeds 1MB

const TASK_TYPES = new Set(['subagent', 'shell', 'workflow']);
const ACTIVE_STATUSES = new Set(['running', 'pending']);

// A shell task matching these patterns = long-running process (dev server / watch / tail -f, etc.); no keep-alive.
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
// docker compose up is long-running, but with -d/--detach it returns immediately; checked in two steps (no lookarounds).
const DOCKER_UP_RE = /\bdocker(\s+compose|-compose)\s+up\b/i;
const DOCKER_DETACH_RE = /(^|\s)-d(\s|$)|--detach\b/i;

const SUBAGENT_MODEL = typeof process.env.CLAUDE_CODE_SUBAGENT_MODEL === 'string'
  ? process.env.CLAUDE_CODE_SUBAGENT_MODEL.trim()
  : '';
const ANY_MODEL = process.argv.slice(2).includes('--any-model');

const wakeMessage = (n) =>
  `[cache-keepalive] Background tasks are still running; this is an automatic cache keep-alive wake (#${n}). ` +
  `Reply with only the word "alive". Do not call any tools and do not output anything else.\n`;

const nowIso = () => new Date().toISOString();
const secs = (ms) => Math.round(ms / 10) / 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const safeSessionName = (s) => s.replace(/[^A-Za-z0-9._-]/g, '_');

// —— Logging: only numbers and enums, never last_assistant_message / description / command ——
function log(rec) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    try {
      if (fs.statSync(LOG_FILE).size > LOG_MAX_BYTES) fs.renameSync(LOG_FILE, LOG_ROTATED);
    } catch {
      /* no previous log or rotation failed: ignore */
    }
    fs.appendFileSync(LOG_FILE, JSON.stringify(rec) + '\n');
  } catch {
    /* logging failures must not affect the main flow */
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

// —— State file / tasks file: both "write a temp file, then rename" ——
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
  fs.renameSync(tmp, p); // on Windows, rename overwrites an existing file
}

function deleteFile(p) {
  try { fs.rmSync(p, { force: true }); } catch { /* ignore */ }
}

// —— CC Switch request start: open a read-only connection per query and close it right after ——
// Main-session request filter: request_model contains claude/opus/sonnet/fable (also matching
// prefixed names like CC/claude-…) and is not a haiku side request; if the subagent model name is
// known, exclude it too. With --any-model the model name does not need to look like Claude.
// okOnly=true takes only successful requests with status_code=200: failed requests such as 502 never
// reached the upstream, did not refresh the cache, and cannot serve as an anchor. When checking
// whether the session has resumed activity, okOnly=false is used and requests of any status count.
let sqliteModule = null;
// Returns { start, model } or null; model is the real upstream model name (it changes when CC Switch switches to a non-Claude provider)
// mainModel (optional): the main-session model; when non-empty, only rows whose upstream model column equals it are taken, excluding subagent requests with a per-call model.
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
    return null; // database missing / table missing / lock conflict → handled by the fallback
  } finally {
    if (db !== null) {
      try { db.close(); } catch { /* ignore */ }
    }
  }
}

// A non-Claude upstream (e.g. switched to DeepSeek) has no 5-minute cache problem; keep-alive would just waste money.
const CLAUDE_MODEL_RE = /claude|opus|sonnet|fable/i;
const looksClaudeModel = (m) => typeof m === 'string' && CLAUDE_MODEL_RE.test(m);
const upstreamAllowed = (m) => ANY_MODEL || looksClaudeModel(m);

// —— Transcript activity detection ——
// Watching mtime/size changes alone is not enough: Stop itself writes assistant + system/stop_hook_summary
// entries (timestamped ≈ the Stop moment), which is not "the session resumed". So the tail must
// contain an entry whose timestamp is later than hookStart+2s.
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

// Reads a bounded tail; returns the complete JSONL lines and the first covered byte offset; returns null if unreadable.
function readTranscriptTail(p, size) {
  let text;
  let start = 0;
  let firstByte = 0;
  try {
    const fd = fs.openSync(p, 'r');
    try {
      start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
      const len = Math.max(0, size - start);
      const buf = Buffer.alloc(len);
      const n = len > 0 ? fs.readSync(fd, buf, 0, len, start) : 0;
      let offset = 0;
      if (start > 0) {
        const previous = Buffer.alloc(1);
        fs.readSync(fd, previous, 0, 1, start - 1);
        if (previous[0] !== 10) {
          const newline = buf.subarray(0, n).indexOf(10);
          offset = newline < 0 ? n : newline + 1;
        }
      }
      firstByte = start + offset;
      text = buf.subarray(offset, n).toString('utf8');
    } finally {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  } catch {
    return null;
  }
  return { lines: text.split('\n'), firstByte };
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

// Only the main session's own user / assistant entries mean "the session started a new turn". queue-operation
// (background task notifications enqueued and immediately removed), attachment, system, pr-link, etc. do not;
// nor do subagent (isSidechain) entries.
const isMainTurnEntry = (o) => (o.type === 'user' || o.type === 'assistant') && o.isSidechain !== true;

// Main-session model: message.model of the last main-session assistant entry in the transcript tail; null if unavailable.
// Skips the "<synthetic>" placeholder model that Claude Code generates itself.
function readMainModel(p) {
  const cur = snapshotFile(p);
  if (cur === null) return null;
  const tail = readTranscriptTail(p, cur.size);
  if (tail === null) return null;
  const { lines } = tail;
  for (let i = lines.length - 1; i >= 0; i--) {
    const o = parseJsonLine(lines[i]);
    if (!o || o.type !== 'assistant' || o.isSidechain === true) continue;
    const m = o.message && typeof o.message === 'object' ? o.message.model : null;
    if (typeof m === 'string' && m.trim() && !m.startsWith('<')) return m.trim();
  }
  return null;
}

// Returns 'idle' | 'active' | 'unreadable'
function checkTranscript(p, snap, hookStart) {
  const cur = snapshotFile(p);
  if (cur === null) return 'unreadable';
  if (cur.mtimeMs === snap.mtimeMs && cur.size === snap.size) return 'idle';
  const tail = readTranscriptTail(p, cur.size);
  if (tail === null) return 'unreadable';
  for (const line of tail.lines) {
    const o = parseJsonLine(line);
    if (!o || !isMainTurnEntry(o)) continue;
    const ms = parseTsMs(o.timestamp);
    if (ms === null) continue;
    if (o.type === 'user' ? ms >= hookStart : ms > hookStart + TRANSCRIPT_LAG_MS) return 'active';
  }
  // Some newly added bytes fall outside the read window, or the file was rewritten and cannot be fully covered: idle cannot be safely asserted.
  if (tail.firstByte > snap.size || (cur.size <= snap.size && tail.firstByte > 0)) return 'unreadable';
  return 'idle';
}

function isPersistentCommand(text) {
  for (const re of PERSISTENT_PATTERNS) if (re.test(text)) return true;
  if (DOCKER_UP_RE.test(text) && !DOCKER_DETACH_RE.test(text)) return true;
  return false;
}

// —— Active task selection (including the shell long-running check and the 20-minute age cap) ——
// tasksFilePath records when each shell task was first seen, keeping only ids present in this background_tasks.
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

// Last resort: any uncaught exception must still leave a log entry and must never wake the session with exit 2
function emergencyLog(reason) {
  if (LOGGED_ERROR) return;
  LOGGED_ERROR = true;
  try {
    log({ ts: nowIso(), session: SESSION, decision: 'error', reason: String(reason).slice(0, 200) });
  } catch {
    /* if even logging fails, give up */
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

  // 1. Any active tasks? (subagent / shell / workflow with status running|pending; shell also gets the long-running and age checks)
  const { active, ignored } = selectActiveTasks(tasks, tasksPath, hookStart);
  if (active.length === 0) {
    // No active tasks: also delete this session's state so an older instance still sleeping wakes up as superseded
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

  // 2. State file: it only continues the same idle period when stop_hook_active=true and <3min since the last wake
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

  // 3. Transcript snapshot (baseline taken before settling)
  const transcriptPath =
    typeof input.transcript_path === 'string' && input.transcript_path ? input.transcript_path : null;
  const snap = transcriptPath !== null ? snapshotFile(transcriptPath) : null;
  if (snap === null) {
    log({ ...stamp(), decision: 'exit', reason: 'transcript-unreadable' });
    return 0;
  }

  // 4. Anchor (only successful main-session requests count)
  // Read the main-session model once at Stop: the last main reply is already in the transcript by now
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

  // 5. Re-query the anchor after settling (the last request at Stop may not be in the database yet), then check whether the anchor is stale
  await sleep(SETTLE_MS);
  if (process.env.CACHE_KEEPALIVE_TEST_THROW) {
    // Test only: simulate an async crash to verify the uncaughtException fallback logs and exits 0
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

  // 6. Wait until the target time, then decide
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

    // a. Taken over by a newer Stop in the same session
    const st = readJsonFile(statePath, null);
    if (!st || st.owner !== owner) {
      log({ ...stamp(), decision: 'exit', reason: 'superseded', anchorAgeS: secs(Date.now() - anchor) });
      return 0;
    }

    // b. New transcript entries → the session is already active
    const tr = checkTranscript(transcriptPath, snap, hookStart);
    if (tr === 'unreadable') {
      log({ ...stamp(), decision: 'exit', reason: 'transcript-unreadable', anchorAgeS: secs(Date.now() - anchor) });
      return 0;
    }
    if (tr === 'active') {
      log({ ...stamp(), decision: 'exit', reason: 'activity-transcript', anchorAgeS: secs(Date.now() - anchor) });
      return 0;
    }

    // c. New requests in the database: first check requests of any status (failed ones count as activity), then separately check whether a successful request moves the anchor
    const anyRow = await queryLatestRow(session, { okOnly: false, mainModel });
    if (anyRow !== null && anyRow.start > hookStart) {
      log({ ...stamp(), decision: 'exit', reason: 'activity-ccswitch', anchorSource, anchorAgeS: secs(Date.now() - anchor) });
      return 0;
    }
    const okRow = await queryLatestRow(session, { okOnly: true, mainModel });
    // The fallback anchor is only an estimate: adopt a real successful request unconditionally; with a real anchor, accept only later requests
    if (okRow !== null && (anchorSource === 'fallback' || okRow.start > anchor)) {
      anchor = okRow.start; // a successful request sent before Stop but written to the database late: move the anchor forward and restart the timer
      anchorModel = okRow.model;
      anchorSource = 'ccswitch';
      ctx.anchorSource = anchorSource;
      ctx.upstreamModel = anchorModel;
      ctx.anchorAgeS = secs(Date.now() - anchor);
      if (!upstreamAllowed(anchorModel)) { // the new row must also confirm the upstream is still Claude (unrestricted with --any-model)
        log({ ...stamp(), decision: 'exit', reason: 'non-claude-model' });
        return 0;
      }
      if (Date.now() - anchor > STALE_MS) {
        log({ ...stamp(), decision: 'exit', reason: 'stale-anchor' });
        return 0;
      }
      continue;
    }

    // d. Re-check the caps
    const nowD = Date.now();
    if (nowD - periodStart >= CAP_MS || wakes >= MAX_WAKES) {
      log({ ...stamp(), decision: 'exit', reason: 'cap', periodAgeS: secs(nowD - periodStart), wakes });
      return 0;
    }

    // e. Decide: right before waking, re-confirm guard / anchor freshness / owner / transcript back to back
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
  process.exitCode = 2; // let the event loop wind down naturally; process.exit would truncate stderr
} else {
  process.exit(0);
}
