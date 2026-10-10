// cache-keepalive.mjs 回归测试：每个用例独立的状态目录 / transcript / 迷你 sqlite 库，并行运行。
// 用法：node test/run.mjs（需要 Node 22.13+，不读写真实的 CC Switch 库和日志目录）
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cache-keepalive.mjs');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-keepalive-test-'));
const WAKE1 = '[cache-keepalive] Background tasks are still running; this is an automatic cache keep-alive wake (#1). Reply with only the word "alive". Do not call any tools and do not output anything else.\n';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (ms) => new Date(ms).toISOString();

async function waitForState(c, session, previousOwner) {
  const file = path.join(c.state, session + '.json');
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (previousOwner === undefined || state.owner !== previousOwner) return state;
    } catch { /* 尚未写入 */ }
    await sleep(10);
  }
  throw new Error('hook state was not created or ownership did not change');
}

function mkCase(name) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  const transcript = path.join(dir, 't.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', timestamp: iso(Date.now() - 60000) }) + '\n');
  return { dir, state: path.join(dir, 'state'), transcript, db: path.join(dir, 'mini.db') };
}
// 带主会话模型信息的 transcript：主会话 assistant 的 message.model 是 claude-opus-5-5，
// 之后还有一条 sidechain（子代理）assistant 用 sonnet，读主模型时必须跳过它
function mainTranscript(c) {
  fs.writeFileSync(c.transcript, [
    { type: 'assistant', isSidechain: false, message: { model: 'claude-opus-5-5' }, timestamp: iso(Date.now() - 60000) },
    { type: 'assistant', isSidechain: true, message: { model: 'claude-sonnet-5-5' }, timestamp: iso(Date.now() - 50000) },
  ].map((o) => JSON.stringify(o) + '\n').join(''));
}
function dbInit(file) {
  const db = new DatabaseSync(file);
  db.exec('create table if not exists proxy_request_logs (request_id text, session_id text, model text, request_model text, status_code integer, created_at integer, latency_ms integer)');
  db.close();
}
// startAgoMs：请求开始距现在多久；created_at 取整秒，会让开始时间最多偏早 1 秒
// id：CC Switch 4.0.6 的 request_id 形如 "session:<上游响应 id>"；不给时用不含响应 id 的随机串（同失败请求）
function dbAdd(file, rows) {
  dbInit(file);
  const db = new DatabaseSync(file);
  const st = db.prepare('insert into proxy_request_logs (request_id, session_id, model, request_model, status_code, created_at, latency_ms) values (?,?,?,?,?,?,?)');
  for (const r of rows) {
    const lat = r.latency ?? 1000;
    const endMs = Date.now() - r.startAgoMs + lat;
    st.run(r.id ?? crypto.randomUUID(), r.session, r.model ?? 'claude-opus-5-5', r.request_model ?? 'claude-opus-5', r.status ?? 200, Math.floor(endMs / 1000), lat);
  }
  db.close();
}
// 带 message.id 的主会话 transcript（ids 从旧到新）；子代理条目在单独文件里，主 transcript 里只有主会话自己的回复
function idTranscript(c, ids, agoMs = 60000) {
  fs.writeFileSync(c.transcript, ids.map((id) =>
    JSON.stringify({ type: 'assistant', isSidechain: false, message: { id, model: 'claude-opus-5-5' }, timestamp: iso(Date.now() - agoMs) }) + '\n').join(''));
}
function run(c, input, env = {}, extraArgs = []) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(process.execPath, [SCRIPT, ...extraArgs], {
      env: { ...process.env, CLAUDE_CODE_SUBAGENT_MODEL: '', CACHE_KEEPALIVE_DIR: c.state, CACHE_KEEPALIVE_DB: c.db, CACHE_KEEPALIVE_SETTLE_S: '1', ...env },
    });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.stdout.resume();
    p.on('close', (code) => {
      let last = null;
      try { last = JSON.parse(fs.readFileSync(path.join(c.state, 'log.jsonl'), 'utf8').trim().split('\n').at(-1)); } catch { /* none */ }
      resolve({ code, err, last, secs: Math.round((Date.now() - t0) / 100) / 10 });
    });
    p.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}
const inp = (c, session, tasks, extra = {}) => ({ session_id: session, transcript_path: c.transcript, stop_hook_active: false, background_tasks: tasks, ...extra });
const SUB = { id: 'a1', type: 'subagent', status: 'running' };

const results = [];
function check(name, ok, detail) { results.push({ name, ok: !!ok, detail }); }
const brief = (r) => `exit=${r.code} ${r.secs}s reason=${r.last?.reason ?? r.last?.decision} ${r.err && r.err !== WAKE1 ? 'STDERR=' + JSON.stringify(r.err.slice(0, 120)) : ''}`;
const isWake = (r) => r.code === 2 && r.err === WAKE1 && r.last?.decision === 'wake';
const isExit = (r, reason) => r.code === 0 && r.err === '' && r.last?.reason === reason;

const cases = {
  async T1() {
    const c = mkCase('T1'); fs.writeFileSync(path.join(c.state, 's1.json'), '{"owner":"x"}');
    const r = await run(c, inp(c, 's1', []));
    check('T1 无任务→no-task 且删除状态', isExit(r, 'no-task') && !fs.existsSync(path.join(c.state, 's1.json')), brief(r));
  },
  async T2() {
    const c = mkCase('T2');
    const r = await run(c, inp(c, 's2', [{ id: 'm', type: 'monitor', status: 'running' }]));
    check('T2 只有 monitor→no-task', isExit(r, 'no-task'), brief(r));
  },
  async T3() {
    const c = mkCase('T3');
    const r = await run(c, inp(c, 's3', [{ id: 'x', type: 'shell', status: 'running', command: 'node build.js' }]), { CACHE_KEEPALIVE_FIRE_AFTER_S: '35' });
    check('T3 普通 shell（兜底锚点）→wake', isWake(r) && r.last.anchorSource === 'fallback', brief(r));
  },
  async T4() {
    const c = mkCase('T4');
    const r = await run(c, inp(c, 's4', [{ id: 'w', type: 'workflow', status: 'running' }]), { CACHE_KEEPALIVE_FIRE_AFTER_S: '35' });
    check('T4 workflow→wake', isWake(r), brief(r));
  },
  async T5() {
    const c = mkCase('T5'); dbAdd(c.db, [{ session: 's5', startAgoMs: 400000 }]);
    const r = await run(c, inp(c, 's5', [SUB]));
    check('T5 锚点超过 300s→stale-anchor', isExit(r, 'stale-anchor') && r.last.anchorSource === 'ccswitch', brief(r) + ` age=${r.last?.anchorAgeS}`);
  },
  async T6() {
    for (const [sha, expect] of [[false, 'wake'], [true, 'cap']]) {
      const c = mkCase('T6' + sha);
      fs.writeFileSync(path.join(c.state, 's6.json'), JSON.stringify({ wakes: 8, lastWakeAt: Date.now() - 10000, periodStart: Date.now() - 600000, owner: 'x' }));
      const r = await run(c, inp(c, 's6', [SUB], { stop_hook_active: sha }), { CACHE_KEEPALIVE_FIRE_AFTER_S: '35' });
      check(`T6 F4 stop_hook_active=${sha}→${expect}`, expect === 'wake' ? isWake(r) && r.last.wakes === 1 : isExit(r, 'cap'), brief(r));
    }
  },
  async T7() {
    const c = mkCase('T7'); dbAdd(c.db, [{ session: 's7', startAgoMs: 2000 }]);
    const p = run(c, inp(c, 's7', [SUB]), { CACHE_KEEPALIVE_FIRE_AFTER_S: '8' });
    await sleep(3500); fs.appendFileSync(c.transcript, JSON.stringify({ type: 'user', timestamp: iso(Date.now()) }) + '\n');
    const r = await p;
    check('T7 睡眠中出现新 user 条目→activity-transcript', isExit(r, 'activity-transcript'), brief(r));
  },
  async T8() {
    const c = mkCase('T8'); dbAdd(c.db, [{ session: 's8', startAgoMs: 2000 }]);
    const p = run(c, inp(c, 's8', [SUB]), { CACHE_KEEPALIVE_FIRE_AFTER_S: '8' });
    await sleep(3500);
    fs.appendFileSync(c.transcript, JSON.stringify({ type: 'ai-title', title: 'x' }) + '\n' + JSON.stringify({ type: 'assistant', timestamp: iso(Date.now() - 20000) }) + '\n');
    const r = await p;
    check('T8 无时间戳/旧时间戳条目不算活动→wake', isWake(r), brief(r));
  },
  async T9() {
    const c = mkCase('T9');
    const r = await run(c, { ...inp(c, 's9', [SUB]), transcript_path: path.join(c.dir, 'missing.jsonl') });
    check('T9 transcript 不存在→transcript-unreadable', isExit(r, 'transcript-unreadable'), brief(r));
  },
  async T10() {
    const c = mkCase('T10');
    // 等实际取得所有权后才启动下一实例；Windows 上进程启动顺序不保证写入顺序。
    const pa = run(c, inp(c, 's10', [SUB]), { CACHE_KEEPALIVE_FIRE_AFTER_S: '45' });
    const first = await waitForState(c, 's10');
    const pb = run(c, inp(c, 's10', [SUB]), { CACHE_KEEPALIVE_FIRE_AFTER_S: '45' });
    await waitForState(c, 's10', first.owner);
    const [a, b] = await Promise.all([pa, pb]);
    const lines = fs.readFileSync(path.join(c.state, 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).reason ?? 'wake');
    check('T10 竞态：先启动 superseded，后启动 wake', a.code === 0 && b.code === 2 && lines.includes('superseded') && lines.includes('wake'), `a=${a.code} b=${b.code} log=${lines.join(',')}`);
  },
  async T11() {
    const c = mkCase('T11'); fs.writeFileSync(path.join(c.state, 'log.jsonl'), 'x'.repeat(1100000));
    const r = await run(c, inp(c, 's11', []));
    const rot = fs.statSync(path.join(c.state, 'log.1.jsonl')).size;
    const cur = fs.readFileSync(path.join(c.state, 'log.jsonl'), 'utf8').trim().split('\n').length;
    check('T11 日志轮转', rot === 1100000 && cur === 1 && r.code === 0, `rotated=${rot} curLines=${cur}`);
  },
  async T14() {
    const c = mkCase('T14');
    const r = await run(c, inp(c, 's14', [{ id: 'd', type: 'shell', status: 'running', command: 'npm run dev' }]));
    check('T14 npm run dev→no-task(persistent-pattern)', isExit(r, 'no-task') && r.last.ignored?.[0]?.reason === 'persistent-pattern', brief(r));
  },
  async T15() {
    const c1 = mkCase('T15a'), c2 = mkCase('T15b');
    const [a, b] = await Promise.all([
      run(c1, inp(c1, 's15', [{ id: 'k', type: 'shell', status: 'running', command: 'docker compose up -d' }]), { CACHE_KEEPALIVE_FIRE_AFTER_S: '35' }),
      run(c2, inp(c2, 's15', [{ id: 'k', type: 'shell', status: 'running', command: 'docker compose up' }])),
    ]);
    check('T15 compose up -d→wake；compose up→no-task', isWake(a) && isExit(b, 'no-task'), `${brief(a)} | ${brief(b)}`);
  },
  async T16() {
    const out = [];
    for (const [ago, expect] of [[25 * 60000, 'no-task'], [60000, 'wake']]) {
      const c = mkCase('T16-' + expect);
      fs.writeFileSync(path.join(c.state, 's16.tasks.json'), JSON.stringify({ s2: Date.now() - ago }));
      const r = await run(c, inp(c, 's16', [{ id: 's2', type: 'shell', status: 'running', command: 'node build.js' }]), { CACHE_KEEPALIVE_FIRE_AFTER_S: '35' });
      out.push(expect === 'wake' ? isWake(r) : isExit(r, 'no-task') && r.last.ignored?.[0]?.reason === 'too-old');
      out.push(brief(r));
    }
    check('T16 shell 存活 25 分钟→too-old；1 分钟→wake', out[0] && out[2], `${out[1]} | ${out[3]}`);
  },
  async T17() {
    const c = mkCase('T17');
    const r = await run(c, inp(c, 's17', [{ id: 'd', type: 'shell', status: 'running', command: 'pnpm dev' }, SUB]), { CACHE_KEEPALIVE_FIRE_AFTER_S: '35' });
    check('T17 dev server+subagent→wake 且 ignored 记 shell', isWake(r) && r.last.ignored?.length === 1, brief(r));
  },
  async T18() {
    const c = mkCase('T18');
    fs.writeFileSync(path.join(c.state, 's18.tasks.json'), JSON.stringify({ old1: Date.now() - 1000, s5: Date.now() - 2000 }));
    await run(c, inp(c, 's18', [{ id: 's5', type: 'shell', status: 'running', command: 'node a.js' }]), { CACHE_KEEPALIVE_FIRE_AFTER_S: '35' });
    const keys = Object.keys(JSON.parse(fs.readFileSync(path.join(c.state, 's18.tasks.json'), 'utf8')));
    check('T18 tasks 文件清理已结束的 id', keys.length === 1 && keys[0] === 's5', `keys=${keys}`);
  },
  async T19() {
    const c = mkCase('T19'); dbAdd(c.db, [{ session: 's19', startAgoMs: 2000, model: 'deepseek/deepseek-v4.1-flash' }]);
    const r = await run(c, inp(c, 's19', [SUB]), { CACHE_KEEPALIVE_FIRE_AFTER_S: '6' });
    check('T19 上游是 deepseek→non-claude-model', isExit(r, 'non-claude-model') && /deepseek/.test(r.last.upstreamModel), brief(r));
  },
  async T20() {
    const c = mkCase('T20'); dbAdd(c.db, [{ session: 's20', startAgoMs: 2000 }]);
    const r = await run(c, inp(c, 's20', [SUB]), { CACHE_KEEPALIVE_FIRE_AFTER_S: '6' });
    check('T20 上游 claude-opus-5-5→wake', isWake(r) && r.last.upstreamModel === 'claude-opus-5-5' && r.last.anchorSource === 'ccswitch', brief(r));
  },
  async T21() {
    const c = mkCase('T21'); dbAdd(c.db, [{ session: 's21', startAgoMs: 2000, model: 'CC/claude-opus-5-5', request_model: 'CC/claude-opus-5-5' }]);
    const r = await run(c, inp(c, 's21', [SUB]), { CACHE_KEEPALIVE_FIRE_AFTER_S: '6' });
    check('T21 带前缀的模型名（请求名与上游）→wake', isWake(r) && r.last.anchorSource === 'ccswitch', brief(r));
  },
  async T22() {
    const c = mkCase('T22');
    const r = await run(c, inp(c, 's22', [SUB]), { CACHE_KEEPALIVE_TEST_THROW: '1', CACHE_KEEPALIVE_FIRE_AFTER_S: '35' });
    check('T22 异步抛错→error 日志且 exit 0', r.code === 0 && r.err === '' && r.last?.decision === 'error', brief(r));
  },
  async T23() {
    const c = mkCase('T23');
    dbAdd(c.db, [
      { session: 's23', startAgoMs: 400000 },
      { session: 's23', startAgoMs: 2000, request_model: 'claude-sonnet-5', model: 'claude-sonnet-5-5' },
    ]);
    const r = await run(c, inp(c, 's23', [SUB]), { CLAUDE_CODE_SUBAGENT_MODEL: 'claude-sonnet-5', CACHE_KEEPALIVE_FIRE_AFTER_S: '6' });
    check('T23 排除 Claude 子代理模型后锚点过期→stale-anchor', isExit(r, 'stale-anchor'), brief(r));
  },
  async T24() {
    const c = mkCase('T24'); dbAdd(c.db, [{ session: 's24', startAgoMs: 2000 }]);
    const p = run(c, inp(c, 's24', [SUB]), { CACHE_KEEPALIVE_FIRE_AFTER_S: '8' });
    await sleep(3000); dbAdd(c.db, [{ session: 's24', startAgoMs: 500, status: 502 }]);
    const r = await p;
    check('T24 Stop 后出现新请求（502 也算）→activity-ccswitch', isExit(r, 'activity-ccswitch'), brief(r));
  },
  async T25() {
    const c = mkCase('T25'); dbAdd(c.db, [{ session: 's25', startAgoMs: 5000 }]);
    const hookStart = Date.now();
    const p = run(c, inp(c, 's25', [SUB]), { CACHE_KEEPALIVE_FIRE_AFTER_S: '9' });
    await sleep(1500); dbAdd(c.db, [{ session: 's25', startAgoMs: Date.now() - hookStart + 1000, latency: 2000 }]);
    const r = await p;
    check('T25 晚写入库的旧请求让锚点前移后再唤醒', isWake(r) && r.secs >= 6, brief(r) + ` age=${r.last?.anchorAgeS}`);
  },
  async T26() {
    const c = mkCase('T26'); dbAdd(c.db, [{ session: 's26', startAgoMs: 2000 }]);
    const p = run(c, inp(c, 's26', [SUB]), { CACHE_KEEPALIVE_FIRE_AFTER_S: '8' });
    await sleep(3000); fs.rmSync(c.transcript);
    const r = await p;
    check('T26 决断时 transcript 读不到→transcript-unreadable', isExit(r, 'transcript-unreadable'), brief(r));
  },
  async T27() {
    const c = mkCase('T27');
    const r = await run(c, 'not json');
    check('T27 非法输入→bad-input', r.code === 0 && r.err === '' && r.last?.reason === 'bad-input', brief(r));
  },
  async T28() {
    const out = [];
    for (const [model, expect] of [['claude-opus-5-5', 'stale-anchor'], ['deepseek/deepseek-v4.1-flash', 'non-claude-model']]) {
      const c = mkCase('T28-' + expect);
      const hookStart = Date.now();
      const p = run(c, inp(c, 's28', [SUB]), { CACHE_KEEPALIVE_FIRE_AFTER_S: '33' });
      await sleep(1500); dbAdd(c.db, [{ session: 's28', startAgoMs: Date.now() - hookStart + 400000, model }]);
      const r = await p;
      out.push(isExit(r, expect) && r.last.anchorSource === 'ccswitch', brief(r));
    }
    check('O6 兜底后读到更早的真实请求→改用并判过期/非 Claude', out[0] && out[2], `${out[1]} | ${out[3]}`);
  },
  async T29() {
    const c = mkCase('T29'); dbAdd(c.db, [{ session: 's29', startAgoMs: 2000 }]);
    const p = run(c, inp(c, 's29', [SUB]), { CACHE_KEEPALIVE_FIRE_AFTER_S: '8' });
    await sleep(3500); fs.writeFileSync(c.transcript, JSON.stringify({ type: 'user', timestamp: iso(Date.now()) }) + '\n');
    const r = await p;
    check('O2 小文件被改写成只剩一行新条目→activity-transcript', isExit(r, 'activity-transcript'), brief(r));
  },
  async T30() {
    const c = mkCase('T30'); dbAdd(c.db, [{ session: 's30', startAgoMs: 2000, model: 'deepseek/deepseek-v4.1-flash' }]);
    const r = await run(c, inp(c, 's30', [SUB]), { CACHE_KEEPALIVE_FIRE_AFTER_S: '6' }, ['--any-model']);
    check('--any-model：上游是 deepseek 也唤醒', isWake(r) && r.last.anyModel === true && /deepseek/.test(r.last.upstreamModel), brief(r));
  },
  async T31() {
    const out = [];
    for (const flag of [['--any-model'], []]) {
      const c = mkCase('T31' + flag.length); dbAdd(c.db, [{ session: 's31', startAgoMs: 2000, model: 'gpt-5', request_model: 'gpt-5' }]);
      const r = await run(c, inp(c, 's31', [SUB]), { CACHE_KEEPALIVE_FIRE_AFTER_S: flag.length ? '6' : '35' }, flag);
      out.push(r);
    }
    check('--any-model：非 Claude 请求名也能当锚点；默认模式忽略它、走兜底', isWake(out[0]) && out[0].last.anchorSource === 'ccswitch' && isWake(out[1]) && out[1].last.anchorSource === 'fallback', `${brief(out[0])} | ${brief(out[1])}`);
  },
  async T32() {
    const c = mkCase('T32'); dbAdd(c.db, [{ session: 's32', startAgoMs: 2000, request_model: 'claude-haiku-4-5', model: 'claude-haiku-4-5' }]);
    const r = await run(c, inp(c, 's32', [SUB]), { CACHE_KEEPALIVE_FIRE_AFTER_S: '35' }, ['--any-model']);
    check('--any-model 仍排除 haiku 旁路请求', isWake(r) && r.last.anchorSource === 'fallback', brief(r));
  },
  async T33() {
    const c = mkCase('T33'); dbAdd(c.db, [{ session: 's33', startAgoMs: 2000 }]);
    const p = run(c, inp(c, 's33', [SUB]), { CACHE_KEEPALIVE_FIRE_AFTER_S: '8' });
    await sleep(3500);
    const now = () => iso(Date.now());
    fs.appendFileSync(c.transcript, [
      { type: 'queue-operation', operation: 'enqueue', timestamp: now() },
      { type: 'queue-operation', operation: 'remove', timestamp: now() },
      { type: 'attachment', timestamp: now() },
      { type: 'system', subtype: 'stop_hook_summary', timestamp: now() },
      { type: 'pr-link', timestamp: now() },
    ].map((o) => JSON.stringify(o) + '\n').join(''));
    const r = await p;
    check('transcript 只多了 queue-operation/attachment/system 等非对话条目→不算活动，wake', isWake(r), brief(r));
  },
  async T34() {
    const out = [];
    for (const [name, entry, expect] of [
      ['sidechain', { type: 'user', isSidechain: true }, 'wake'],
      ['main', { type: 'user', isSidechain: false }, 'activity-transcript'],
      ['main-assistant', { type: 'assistant' }, 'activity-transcript'],
    ]) {
      const c = mkCase('T34-' + name); dbAdd(c.db, [{ session: 's34', startAgoMs: 2000 }]);
      const p = run(c, inp(c, 's34', [SUB]), { CACHE_KEEPALIVE_FIRE_AFTER_S: '8' });
      await sleep(3500); fs.appendFileSync(c.transcript, JSON.stringify({ ...entry, timestamp: iso(Date.now()) }) + '\n');
      const r = await p;
      out.push(expect === 'wake' ? isWake(r) : isExit(r, expect), brief(r));
    }
    check('新 user/assistant 条目：isSidechain=true 忽略→wake；非 sidechain→activity-transcript', out[0] && out[2] && out[4], out.filter((_, i) => i % 2).join(' | '));
  },
  async T35() {
    const c = mkCase('T35'); mainTranscript(c);
    dbAdd(c.db, [
      { session: 's35', startAgoMs: 4000 },
      { session: 's35', startAgoMs: 500, request_model: 'claude-sonnet-5', model: 'claude-sonnet-5-5' },
    ]);
    const r = await run(c, inp(c, 's35', [SUB]), { CACHE_KEEPALIVE_FIRE_AFTER_S: '9' });
    check('主会话模型已知：锚点取主模型行而非更新的 sonnet 行', isWake(r) && r.last.mainModel === 'claude-opus-5-5' && r.last.upstreamModel === 'claude-opus-5-5' && r.secs < 7.5, brief(r) + ` main=${r.last?.mainModel} up=${r.last?.upstreamModel}`);
  },
  async T36() {
    const c = mkCase('T36'); mainTranscript(c); dbAdd(c.db, [{ session: 's36', startAgoMs: 2000 }]);
    const p = run(c, inp(c, 's36', [SUB]), { CACHE_KEEPALIVE_FIRE_AFTER_S: '8' });
    await sleep(3000); dbAdd(c.db, [{ session: 's36', startAgoMs: 500, request_model: 'claude-sonnet-5', model: 'claude-sonnet-5-5' }]);
    const r = await p;
    check('主会话模型已知：Stop 后只有 sonnet 子代理请求→不判 activity-ccswitch，wake', isWake(r) && r.last.upstreamModel === 'claude-opus-5-5', brief(r));
  },
  async T37() {
    const c = mkCase('T37'); dbAdd(c.db, [{ session: 's37', startAgoMs: 2000 }]);
    const p = run(c, inp(c, 's37', [SUB]), { CACHE_KEEPALIVE_FIRE_AFTER_S: '8' });
    await sleep(3000); dbAdd(c.db, [{ session: 's37', startAgoMs: 500, request_model: 'claude-sonnet-5', model: 'claude-sonnet-5-5' }]);
    const r = await p;
    check('transcript 无 assistant 模型信息→不过滤（旧行为），sonnet 请求算活动', isExit(r, 'activity-ccswitch') && r.last.mainModel === null, brief(r));
  },
  async T38() {
    const c = mkCase('T38');
    dbAdd(c.db, [
      { session: 's38', startAgoMs: 4000 },
      { session: 's38', startAgoMs: 500, request_model: 'claude-sonnet-5', model: 'claude-sonnet-5-5' },
    ]);
    const r = await run(c, inp(c, 's38', [SUB]), { CACHE_KEEPALIVE_FIRE_AFTER_S: '6' });
    check('transcript 无 assistant 模型信息→锚点仍取最新一行（旧行为）', isWake(r) && r.last.mainModel === null && r.last.upstreamModel === 'claude-sonnet-5-5', brief(r) + ` up=${r.last?.upstreamModel}`);
  },
  async T39() {
    const c = mkCase('T39');
    // 最后一条 assistant 是 <synthetic> 或 sidechain，都不能当主模型；更早的主会话 assistant 才是
    fs.writeFileSync(c.transcript, [
      { type: 'assistant', isSidechain: false, message: { model: 'claude-opus-5-5' }, timestamp: iso(Date.now() - 90000) },
      { type: 'assistant', isSidechain: true, message: { model: 'claude-sonnet-5-5' }, timestamp: iso(Date.now() - 70000) },
      { type: 'assistant', message: { model: '<synthetic>' }, timestamp: iso(Date.now() - 60000) },
    ].map((o) => JSON.stringify(o) + '\n').join(''));
    dbAdd(c.db, [{ session: 's39', startAgoMs: 2000 }]);
    const r = await run(c, inp(c, 's39', [SUB]), { CACHE_KEEPALIVE_FIRE_AFTER_S: '6' });
    check('主模型读取跳过 sidechain 与 <synthetic> 条目', isWake(r) && r.last.mainModel === 'claude-opus-5-5', brief(r) + ` main=${r.last?.mainModel}`);
  },
  async T40() {
    await Promise.all([0, 300, 1500].map(async (delay) => {
      const c = mkCase('T40-' + delay);
      const p = run(c, inp(c, 's40', [SUB]), { CACHE_KEEPALIVE_SETTLE_S: '0', CACHE_KEEPALIVE_FIRE_AFTER_S: '35' });
      const state = await waitForState(c, 's40');
      await sleep(delay);
      fs.appendFileSync(c.transcript, JSON.stringify({ type: 'user', isSidechain: false, timestamp: iso(state.periodStart + delay) }) + '\n');
      const r = await p;
      check(`T40 启动后 ${delay}ms 的新 user 立即算活动`, isExit(r, 'activity-transcript'), brief(r));
    }));
  },
  async T41() {
    const c = mkCase('T41');
    const p = run(c, inp(c, 's41', [SUB]), { CACHE_KEEPALIVE_SETTLE_S: '0', CACHE_KEEPALIVE_FIRE_AFTER_S: '35' });
    const state = await waitForState(c, 's41');
    await sleep(300);
    fs.appendFileSync(c.transcript, JSON.stringify({ type: 'assistant', timestamp: iso(state.periodStart + 300) }) + '\n');
    const r = await p;
    check('T41 迟到的本轮 Stop assistant 仍保留宽限', isWake(r), brief(r));
  },
  async T42() {
    await Promise.all([262144, 300000].map(async (bytes) => {
      const c = mkCase('T42-' + bytes);
      const p = run(c, inp(c, 's42', [SUB]), { CACHE_KEEPALIVE_SETTLE_S: '0', CACHE_KEEPALIVE_FIRE_AFTER_S: '36' });
      await waitForState(c, 's42');
      await sleep(3000);
      const entry = { type: 'user', timestamp: iso(Date.now()), message: { role: 'user', content: '' } };
      entry.message.content = 'x'.repeat(bytes - Buffer.byteLength(JSON.stringify(entry) + '\n'));
      fs.appendFileSync(c.transcript, JSON.stringify(entry) + '\n');
      const r = await p;
      const expected = bytes === 262144 ? 'activity-transcript' : 'transcript-unreadable';
      check(`T42 新 user 条目 ${bytes} 字节不误唤醒`, isExit(r, expected), brief(r));
    }));
  },
  async T43() {
    await Promise.all([false, true].map(async (oldLarge) => {
      const c = mkCase('T43-' + oldLarge);
      if (oldLarge) {
        fs.writeFileSync(c.transcript, JSON.stringify({ type: 'assistant', timestamp: iso(Date.now() - 60000), message: { content: 'x'.repeat(300000) } }) + '\n');
      }
      const p = run(c, inp(c, 's43', [SUB]), { CACHE_KEEPALIVE_SETTLE_S: '0', CACHE_KEEPALIVE_FIRE_AFTER_S: '36' });
      await waitForState(c, 's43');
      await sleep(3000);
      if (!oldLarge) fs.appendFileSync(c.transcript, JSON.stringify({ type: 'user', timestamp: iso(Date.now()) }) + '\n');
      fs.appendFileSync(c.transcript, JSON.stringify({ type: 'queue-operation', timestamp: iso(Date.now()), data: oldLarge ? 'ok' : 'x'.repeat(300000) }) + '\n');
      const r = await p;
      check(oldLarge ? 'T43 截断仅影响旧条目，新增区间可完整判断→wake' : 'T43 新 user 被后续大条目挤出窗口→保守退出', oldLarge ? isWake(r) : isExit(r, 'transcript-unreadable'), brief(r));
    }));
  },
  async T44() {
    const c = mkCase('T44');
    const p = run(c, inp(c, 's44', [SUB]), { CACHE_KEEPALIVE_SETTLE_S: '0', CACHE_KEEPALIVE_FIRE_AFTER_S: '36' });
    await waitForState(c, 's44');
    await sleep(3000);
    fs.writeFileSync(c.transcript, JSON.stringify({ type: 'user', timestamp: iso(Date.now()), message: { content: 'x'.repeat(300000) } }) + '\n');
    const r = await p;
    check('T44 改写为超长新 user 条目→保守退出', isExit(r, 'transcript-unreadable'), brief(r));
  },
  async T45() {
    // 2026-10-10 实测故障：子代理请求 claude-sonnet-5 被路由到与主会话相同的上游 claude-opus-5-5，session_id 也相同
    const c = mkCase('T45'); idTranscript(c, ['msg_m1']);
    dbAdd(c.db, [
      { session: 's45', startAgoMs: 4000, id: 'session:msg_m1' },
      { session: 's45', startAgoMs: 500, id: 'session:msg_s1', request_model: 'claude-sonnet-5' },
    ]);
    const p = run(c, inp(c, 's45', [SUB]), { CACHE_KEEPALIVE_FIRE_AFTER_S: '9' });
    await sleep(3000); dbAdd(c.db, [{ session: 's45', startAgoMs: 500, id: 'session:msg_s2', request_model: 'claude-sonnet-5' }]);
    const r = await p;
    check('T45 子代理与主会话同上游：锚点取主会话 id 行，Stop 后子代理请求不算活动→wake',
      isWake(r) && r.secs < 7.5 && r.last.mainRequestModel === 'claude-opus-5' && r.last.upstreamModel === 'claude-opus-5-5',
      brief(r) + ` mainReq=${r.last?.mainRequestModel}`);
  },
  async T46() {
    const out = [];
    for (const [status, expect] of [[200, 'wake'], [502, 'activity-ccswitch']]) {
      const c = mkCase('T46-' + status); idTranscript(c, ['msg_m1']);
      dbAdd(c.db, [{ session: 's46', startAgoMs: 2000, id: 'session:msg_m1' }]);
      const p = run(c, inp(c, 's46', [SUB]), { CACHE_KEEPALIVE_FIRE_AFTER_S: '10' });
      await waitForState(c, 's46');
      // 子代理与主会话请求模型也相同：成功行仍可按 id 区分；失败行没有响应 id，只能按请求模型归给主会话
      await sleep(2000); dbAdd(c.db, [{ session: 's46', startAgoMs: 0, status, ...(status === 200 ? { id: 'session:msg_s1' } : {}) }]);
      const r = await p;
      out.push(expect === 'wake' ? isWake(r) : isExit(r, expect), brief(r));
    }
    check('T46 子代理与主会话模型名完全相同：成功请求→wake；失败请求→activity-ccswitch（已知限制）', out[0] && out[2], `${out[1]} | ${out[3]}`);
  },
  async T47() {
    const out = [];
    for (const kind of ['failed', 'ok']) {
      const c = mkCase('T47-' + kind); idTranscript(c, ['msg_m1']);
      dbAdd(c.db, [{ session: 's47', startAgoMs: 2000, id: 'session:msg_m1' }]);
      const p = run(c, inp(c, 's47', [SUB]), { CACHE_KEEPALIVE_FIRE_AFTER_S: '10' });
      const state = await waitForState(c, 's47');
      await sleep(2000);
      if (kind === 'failed') {
        dbAdd(c.db, [{ session: 's47', startAgoMs: 0, status: 502 }]);
      } else {
        // 主会话新回复写进 transcript（时间戳仍在 2 秒宽限内，不触发 activity-transcript），数据库里有同 id 的行
        fs.appendFileSync(c.transcript, JSON.stringify({ type: 'assistant', message: { id: 'msg_m2', model: 'claude-opus-5-5' }, timestamp: iso(state.periodStart) }) + '\n');
        dbAdd(c.db, [{ session: 's47', startAgoMs: 0, id: 'session:msg_m2' }]);
      }
      const r = await p;
      out.push(isExit(r, 'activity-ccswitch'), brief(r));
    }
    check('T47 主会话自己的新请求（失败 / 成功）→activity-ccswitch', out[0] && out[2], `${out[1]} | ${out[3]}`);
  },
  async T48() {
    const c = mkCase('T48'); idTranscript(c, ['msg_m1']);
    dbAdd(c.db, [
      { session: 's48', startAgoMs: 4000 },
      { session: 's48', startAgoMs: 500, request_model: 'claude-sonnet-5', model: 'claude-sonnet-5-5' },
    ]);
    const r = await run(c, inp(c, 's48', [SUB]), { CACHE_KEEPALIVE_FIRE_AFTER_S: '9' });
    check('T48 request_id 不含响应 id→退回上游模型过滤（旧行为）', isWake(r) && r.secs < 7.5 && r.last.mainRequestModel === null && r.last.upstreamModel === 'claude-opus-5-5', brief(r) + ` mainReq=${r.last?.mainRequestModel}`);
  },
  async T49() {
    const c = mkCase('T49'); idTranscript(c, ['msg_m1']);
    dbAdd(c.db, [{ session: 's49', startAgoMs: 0, id: 'session:msg_s1', request_model: 'claude-sonnet-5' }]);
    const p = run(c, inp(c, 's49', [SUB]), { CACHE_KEEPALIVE_SETTLE_S: '3', CACHE_KEEPALIVE_FIRE_AFTER_S: '14' });
    await waitForState(c, 's49');
    await sleep(400); dbAdd(c.db, [{ session: 's49', startAgoMs: 8000, id: 'session:msg_m1' }]);
    const tIns = Date.now();
    const r = await p;
    // 按主会话行应在入库后约 6 秒唤醒；若仍用子代理行，要到其开始后 14 秒
    const after = Math.round((Date.now() - tIns) / 100) / 10;
    check('T49 结算期间才入库的主会话行更早，仍替换按模型选中的子代理行', isWake(r) && after < 10 && r.last.mainRequestModel === 'claude-opus-5', brief(r) + ` afterInsert=${after}s mainReq=${r.last?.mainRequestModel}`);
  },
  async T50() {
    // 主会话 id 行在结算之后才入库，同时有同上游的子代理请求：先按 id 切换匹配方式，子代理请求不算活动
    const c = mkCase('T50'); idTranscript(c, ['msg_m1']);
    const p = run(c, inp(c, 's50', [SUB]), { CACHE_KEEPALIVE_FIRE_AFTER_S: '38' });
    await waitForState(c, 's50');
    await sleep(2500);
    dbAdd(c.db, [
      { session: 's50', startAgoMs: 400000, id: 'session:msg_m1' },
      { session: 's50', startAgoMs: 0, id: 'session:msg_s1', request_model: 'claude-sonnet-5' },
    ]);
    const r = await p;
    check('T50 结算后才入库的主会话 id 行先切换为 id 匹配，同上游子代理请求不判 activity', isExit(r, 'stale-anchor') && r.last.mainRequestModel === 'claude-opus-5', brief(r) + ` mainReq=${r.last?.mainRequestModel}`);
  },
};

const t0 = Date.now();
await Promise.all(Object.values(cases).map((f) => f().catch((e) => check(f.name + ' 异常', false, String(e)))));
results.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
const fail = results.filter((r) => !r.ok);
console.log(`## ${results.length - fail.length}/${results.length} 通过，用时 ${Math.round((Date.now() - t0) / 1000)}s`);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name} :: ${r.detail}`);
process.exitCode = fail.length ? 1 : 0;
fs.rmSync(ROOT, { recursive: true, force: true });
