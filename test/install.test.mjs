// install.mjs 测试：全部在临时配置目录里进行，不碰真实的 ~/.claude。
// 用法：node test/install.test.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const INSTALLER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'install.mjs');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-keepalive-install-'));
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });

function run(dir, ...flags) {
  const r = spawnSync(process.execPath, [INSTALLER, '--config-dir', dir, ...flags], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}
const settingsOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
const ourHandlers = (s) =>
  (s.hooks?.Stop ?? []).flatMap((g) => g.hooks ?? []).filter((h) => (h.args ?? []).some((a) => a.includes('cache-keepalive.mjs')));
const backups = (dir) => fs.readdirSync(dir).filter((f) => f.startsWith('settings.json.bak-')).length;

// 1. 全新安装：没有 settings.json
{
  const d = path.join(ROOT, 'fresh');
  const r = run(d);
  const s = settingsOf(d);
  const h = ourHandlers(s);
  check('全新安装', r.code === 0 && h.length === 1 && h[0].asyncRewake === true && h[0].timeout === 360 && fs.existsSync(path.join(d, 'hooks', 'cache-keepalive.mjs')), r.out.split('\n')[1]);
  // 2. 重复运行：不新增条目，不改写文件
  const before = fs.readFileSync(path.join(d, 'settings.json'), 'utf8');
  const r2 = run(d);
  check('重复安装幂等', r2.code === 0 && ourHandlers(settingsOf(d)).length === 1 && fs.readFileSync(path.join(d, 'settings.json'), 'utf8') === before && /already configured/.test(r2.out));
}

// 3. 保留已有配置：其他键、其他 Stop hook、SessionStart 都不动；旧路径的本工具条目被替换
{
  const d = path.join(ROOT, 'existing');
  fs.mkdirSync(d, { recursive: true });
  const orig = {
    env: { FOO: 'bar' },
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: 'node a.js' }] }],
      Stop: [
        { hooks: [{ type: 'command', command: 'node notify.js' }, { type: 'command', command: 'node', args: ['/old/place/cache-keepalive.mjs'], asyncRewake: true }] },
      ],
    },
    permissions: { allow: ['Read'] },
  };
  fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify(orig, null, 2));
  const r = run(d);
  const s = settingsOf(d);
  const h = ourHandlers(s);
  const others = s.hooks.Stop.flatMap((g) => g.hooks).filter((x) => x.command === 'node notify.js');
  check(
    '保留已有配置并替换旧条目',
    r.code === 0 && s.env.FOO === 'bar' && s.permissions.allow[0] === 'Read' && s.hooks.SessionStart.length === 1 && others.length === 1 && h.length === 1 && !h[0].args[0].startsWith('/old/') && backups(d) === 1,
    JSON.stringify(Object.keys(s)),
  );
  // 4. 卸载：只删本工具条目和脚本，其他 hook 保留
  const u = run(d, '--uninstall');
  const s2 = settingsOf(d);
  check('卸载只移除本工具', u.code === 0 && ourHandlers(s2).length === 0 && s2.hooks.Stop.length === 1 && s2.hooks.SessionStart.length === 1 && !fs.existsSync(path.join(d, 'hooks', 'cache-keepalive.mjs')));
}

// 5. 卸载后 Stop / hooks 变空时一并删除
{
  const d = path.join(ROOT, 'prune');
  run(d);
  run(d, '--uninstall');
  check('卸载后清掉空的 hooks', !('hooks' in settingsOf(d)));
}

// 6. settings.json 不是合法 JSON：报错退出，不写任何东西
{
  const d = path.join(ROOT, 'broken');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'settings.json'), '{ "env": { ');
  const r = run(d);
  check('非法 JSON 时拒绝写入', r.code === 1 && fs.readFileSync(path.join(d, 'settings.json'), 'utf8') === '{ "env": { ' && backups(d) === 0 && !fs.existsSync(path.join(d, 'hooks')), r.out.trim().split('\n').at(-1));
}

// 7. dry run：什么都不写
{
  const d = path.join(ROOT, 'dry');
  const r = run(d, '--dry-run');
  check('dry run 不落盘', r.code === 0 && !fs.existsSync(path.join(d, 'settings.json')) && !fs.existsSync(path.join(d, 'hooks')));
}

// 8. --any-model：写入参数；再不带参数运行就切回默认，且始终只有一条
{
  const d = path.join(ROOT, 'anymodel');
  run(d, '--any-model');
  const a = ourHandlers(settingsOf(d));
  run(d);
  const b = ourHandlers(settingsOf(d));
  check('--any-model 切换', a.length === 1 && a[0].args.includes('--any-model') && b.length === 1 && !b[0].args.includes('--any-model'));
}

fs.rmSync(ROOT, { recursive: true, force: true });
const fail = results.filter((r) => !r.ok);
console.log(`## ${results.length - fail.length}/${results.length} passed`);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.detail ? ' :: ' + r.detail : ''}`);
process.exitCode = fail.length ? 1 : 0;
