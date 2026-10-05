// 运行真实汇总逻辑：成功 hook 返回 0，故意损坏的 hook 必须让测试入口返回非零。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const runner = fs.readFileSync(path.join(testDir, 'run.mjs'), 'utf8');
const hook = fs.readFileSync(path.join(testDir, '..', 'cache-keepalive.mjs'), 'utf8');

function runFixture(broken) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keepalive-runner-'));
  try {
    fs.mkdirSync(path.join(root, 'test'));
    // 仅选取已有 T3 场景，保留原有判定与退出码汇总，避免重跑所有长等待用例。
    assert.ok(runner.includes('Object.values(cases)'), 'runner case selection changed');
    fs.writeFileSync(path.join(root, 'test', 'run.mjs'), runner.replace('Object.values(cases)', '[cases.T3]'));
    fs.writeFileSync(path.join(root, 'cache-keepalive.mjs'), broken ? 'process.exit(0);\n' : hook);
    const result = spawnSync(process.execPath, [path.join(root, 'test', 'run.mjs')], {
      encoding: 'utf8', timeout: 15000,
    });
    assert.equal(result.error, undefined);
    return result;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('全部检查通过时测试入口返回 0', () => {
  const result = runFixture(false);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /1\/1 通过/);
  assert.doesNotMatch(result.stdout, /^FAIL /m);
});

test('hook 回归导致检查失败时测试入口返回非零', () => {
  const result = runFixture(true);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /0\/1 通过/);
  assert.match(result.stdout, /^FAIL T3 /m);
});
