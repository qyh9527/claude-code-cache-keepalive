// cache-keepalive.mjs 回归测试：每个用例独立的状态目录 / transcript / 迷你 sqlite 库，并行运行。
// 用法：node test/run.mjs（需要 Node 22.13+，不读写真实的 CC Switch 库和日志目录）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cache-keepalive.mjs');
const ROOT = path.join(os.tmpdir(), 'cache-keepalive-test', 'cases');
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });
const WAKE1 = '[cache-keepalive] 后台任务仍在运行，这是自动缓存保活唤醒（第 1 次）。请只回复“保活”两个字，不要调用任何工具，不要输出任何其他内容。\n';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (ms) => new Date(ms).toISOString();

function mkCase(name) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  const transcript = path.join(dir, 't.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', timestamp: iso(Date.now() - 60000) }) + '\n');
  return { dir, state: path.join(dir, 'state'), transcript, db: path.join(dir, 'mini.db') };
}
function dbInit(file) {
  const db = new DatabaseSync(file);
  db.exec('create table if not exists proxy_request_logs (session_id text, model text, request_model text, status_code integer, created_at integer, latency_ms integer)');
  db.close();
}
// startAgoMs：请求开始距现在多久；created_at 取整秒，会让开始时间最多偏早 1 秒
function dbAdd(file, rows) {
  dbInit(file);
  const db = new DatabaseSync(file);
  const st = db.prepare('insert into proxy_request_logs values (?,?,?,?,?,?)');
  for (const r of rows) {
    const lat = r.latency ?? 1000;
    const endMs = Date.now() - r.startAgoMs + lat;
    st.run(r.session, r.model ?? 'claude-opus-5-5', r.request_model ?? 'claude-opus-5', r.status ?? 200, Math.floor(endMs / 1000), lat);
  }
  db.close();
}
function run(c, input, env = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(process.execPath, [SCRIPT], {
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
    const pa = run(c, inp(c, 's10', [SUB]), { CACHE_KEEPALIVE_FIRE_AFTER_S: '36' });
    await sleep(2000);
    const pb = run(c, inp(c, 's10', [SUB]), { CACHE_KEEPALIVE_FIRE_AFTER_S: '36' });
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
};

const t0 = Date.now();
await Promise.all(Object.values(cases).map((f) => f().catch((e) => check(f.name + ' 异常', false, String(e)))));
results.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
const fail = results.filter((r) => !r.ok);
console.log(`## ${results.length - fail.length}/${results.length} 通过，用时 ${Math.round((Date.now() - t0) / 1000)}s`);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name} :: ${r.detail}`);
