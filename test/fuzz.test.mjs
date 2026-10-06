// Seeded property fuzzing of the actual helpers, plus bounded CLI round trips.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import fc from 'fast-check';
import { installFunctions, transcriptFunctions } from './source-functions.mjs';

const { commandWords, isOurHandler, removeOurHandlers } = installFunctions;
const { snapshotFile, readTranscriptTail, checkTranscript } = transcriptFunctions;
const INSTALLER = fileURLToPath(new URL('../install.mjs', import.meta.url));
const TAIL_BYTES = 256 * 1024;
const START = 1_700_000_000_000;

function integerEnv(name, fallback, min, max) {
  if (process.env[name] === undefined) return fallback;
  const value = Number(process.env[name]);
  assert.ok(Number.isInteger(value) && value >= min && value <= max, `Invalid ${name}`);
  return value;
}
const seed = integerEnv('FUZZ_SEED', 0x5eed, -0x80000000, 0x7fffffff);
const numRuns = integerEnv('FUZZ_RUNS', 10_000, 1, 1_000_000);
const installRuns = integerEnv('FUZZ_INSTALL_RUNS', 25, 1, 1000);
function fuzz(t, property, runs = numRuns) {
  t.diagnostic(`FUZZ_SEED=${seed} runs=${runs}; replay this test by name with FUZZ_PATH from the failure report`);
  fc.assert(property, { seed, numRuns: runs, ...(process.env.FUZZ_PATH ? { path: process.env.FUZZ_PATH } : {}) });
}

const text = fc.array(fc.constantFrom('a', 'b', '0', ' ', '\t', '\n', "'", '"', '\\', '中', '🐋', '$', ';', '&', '='), { maxLength: 30 }).map((chars) => chars.join(''));
function quote(word, style) {
  if (style === 0) return "'" + word.replaceAll("'", "'\\''") + "'";
  if (style === 1) return '"' + word.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
  // Adjacent quoted fragments are one argument, including empty arguments.
  const mid = Math.floor(word.length / 2);
  return quote(word.slice(0, mid), 0) + quote(word.slice(mid), 1);
}

test('command words round-trip quotes, escapes and Unicode', (t) => {
  fuzz(t, fc.property(fc.array(text, { maxLength: 12 }), fc.integer({ min: 0, max: 2 }), fc.constantFrom(' ', '\t', '\r\n'), (words, style, gap) => {
    const command = words.map((word) => quote(word, style)).join(gap);
    assert.deepEqual(Array.from(commandWords(command)), words);
    assert.equal(commandWords(command + " 'unfinished"), null);
  }));
});

const runtimeOption = fc.record({
  name: fc.constantFrom('--require', '--import', '--title', '--conditions', '-r', '-C'),
  value: fc.oneof(text, fc.constant('cache-keepalive.mjs')),
  inline: fc.boolean(),
// Node accepts --option=value, but short options require a separate value.
}).map(({ name, value, inline }) => inline && name.startsWith('--') ? [`${name}=${value}`] : [name, value]);
const hookCase = fc.record({
  ours: fc.boolean(),
  prefix: fc.constantFrom('/old place/', 'C:\\old place\\', '\\\\server\\share\\', './', ''),
  other: fc.constantFrom('audit.mjs', 'verify-cache-keepalive.mjs', 'cache-keepalive.mjs.bak'),
  options: fc.array(runtimeOption, { maxLength: 4 }),
  flags: fc.array(fc.constantFrom('--no-warnings', '--trace-warnings', '--inspect=0'), { maxLength: 3 }),
  delimiter: fc.boolean(),
  mode: fc.constantFrom('', '--eval', '--print', '--check', '--run'),
  style: fc.integer({ min: 0, max: 2 }),
  split: fc.nat({ max: 30 }),
  executable: fc.constantFrom('node', '/usr/bin/node', 'C:\\Program Files\\nodejs\\node.exe'),
}).map((c) => {
  const script = c.prefix + (c.ours ? 'cache-keepalive.mjs' : c.other);
  const argv = [...c.flags, ...c.options.flat(), ...(c.mode ? [c.mode] : []), ...(c.delimiter ? ['--'] : []), script, 'cache-keepalive.mjs'];
  const split = Math.min(c.split, argv.length);
  return {
    ours: c.ours && !c.mode,
    handler: { type: 'command', command: [c.executable, ...argv.slice(0, split)].map((arg) => quote(arg, c.style)).join(' '), args: argv.slice(split) },
  };
});

test('hook ownership follows the script, never option values or data args', (t) => {
  fuzz(t, fc.property(hookCase, ({ ours, handler }) => {
    assert.equal(isOurHandler(handler), ours, JSON.stringify(handler));
  }));
});

const groups = fc.array(fc.record({
  label: text,
  hooks: fc.array(hookCase, { minLength: 1, maxLength: 5 }),
}), { minLength: 1, maxLength: 4 });
function settingsFixture(input, extra) {
  return { ...extra, hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo start' }] }], Stop: input.map((group) => ({ label: group.label, hooks: group.hooks.map((h) => h.handler) })) } };
}
function expectedRemaining(input) {
  return input.map((group) => ({ label: group.label, hooks: group.hooks.filter((h) => !h.ours).map((h) => h.handler) })).filter((group) => group.hooks.length);
}

test('removing hooks preserves unrelated groups and is idempotent', (t) => {
  fuzz(t, fc.property(groups, fc.dictionary(text, fc.jsonValue()), (input, extra) => {
    const settings = settingsFixture(input, { metadata: extra });
    const start = JSON.stringify(settings.hooks.SessionStart);
    const count = input.flatMap((g) => g.hooks).filter((h) => h.ours).length;
    assert.equal(removeOurHandlers(settings, { prune: true }), count);
    assert.equal(JSON.stringify(settings.hooks.Stop ?? []), JSON.stringify(expectedRemaining(input)));
    assert.equal(JSON.stringify(settings.hooks.SessionStart), start);
    assert.deepEqual(settings.metadata, extra);
    const after = JSON.stringify(settings);
    assert.equal(removeOurHandlers(settings, { prune: true }), 0);
    assert.equal(JSON.stringify(settings), after);
  }));
});

const size = fc.oneof(fc.integer({ min: 0, max: 512 }), fc.constantFrom(TAIL_BYTES - 200, TAIL_BYTES - 1, TAIL_BYTES, TAIL_BYTES + 1, TAIL_BYTES + 200));
const transcriptCase = fc.record({
  prefixSize: size,
  bodySize: size,
  unit: fc.constantFrom('x', '中', '🐋'),
  type: fc.constantFrom('user', 'assistant', 'system', 'queue-operation'),
  sidechain: fc.boolean(),
  delta: fc.oneof(fc.integer({ min: -3000, max: 3000 }), fc.constantFrom(-1, 0, 1, 1999, 2000, 2001)),
  format: fc.constantFrom('iso', 'seconds', 'millis', 'invalid'),
  newline: fc.boolean(),
  truncatedBytes: fc.constantFrom(0, 0, 1, 2, 3, 6),
  rewrite: fc.boolean(),
});

test('transcript tail and activity agree with a full-file byte oracle', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-keepalive-fuzz-transcript-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'transcript.jsonl');
  fuzz(t, fc.property(transcriptCase, (c) => {
    const padding = (n) => c.unit.repeat(Math.floor(n / Buffer.byteLength(c.unit)));
    const prefix = JSON.stringify({ type: 'system', padding: padding(c.prefixSize) }) + '\n';
    const ms = START + c.delta;
    const timestamp = c.format === 'iso' ? new Date(ms).toISOString() : c.format === 'seconds' ? ms / 1000 : c.format === 'millis' ? ms : 'bad timestamp';
    const entry = { type: c.type, isSidechain: c.sidechain, timestamp, message: { content: padding(c.bodySize) } };
    const encodedEntry = Buffer.from(JSON.stringify(entry));
    const data = Buffer.concat([Buffer.from(prefix), encodedEntry.subarray(0, encodedEntry.length - c.truncatedBytes), Buffer.from(c.newline ? '\n' : '')]);
    // The baseline is a known older version. A rewrite's old size covers the new file.
    const baselineSize = c.rewrite ? data.length + 1 : Buffer.byteLength(prefix);
    const snap = { size: baselineSize, mtimeMs: -1 };
    fs.writeFileSync(file, data);

    // Enumerate all line starts from the full file; do not reuse the tail reader's scan.
    const starts = [0];
    for (let i = 0; i < data.length; i++) if (data[i] === 10) starts.push(i + 1);
    const firstByte = starts.find((offset) => offset >= Math.max(0, data.length - TAIL_BYTES)) ?? data.length;
    const expectedLines = data.subarray(firstByte).toString('utf8').split('\n');
    const tail = readTranscriptTail(file, data.length);
    assert.equal(tail.firstByte, firstByte);
    assert.deepEqual(Array.from(tail.lines), expectedLines);
    assert.ok(data.length - tail.firstByte <= TAIL_BYTES);
    const visible = Buffer.byteLength(prefix) >= firstByte;
    const active = c.truncatedBytes === 0 && !c.sidechain && c.format !== 'invalid' && (c.type === 'user' ? c.delta >= 0 : c.type === 'assistant' && c.delta > 2000);
    const incomplete = firstByte > baselineSize || (c.rewrite && firstByte > 0);
    const expected = visible && active ? 'active' : incomplete ? 'unreadable' : 'idle';
    assert.equal(checkTranscript(file, snap, START), expected, JSON.stringify(c));
    assert.equal(checkTranscript(file, snapshotFile(file), START), 'idle');
    fs.rmSync(file);
    assert.equal(checkTranscript(file, snap, START), 'unreadable');
  }));
});

test('installer CLI round-trip preserves config, permissions and one hook', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-keepalive-fuzz-install-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fuzz(t, fc.property(groups, fc.jsonValue(), fc.constantFrom(0o600, 0o640, 0o644), (input, metadata, mode) => {
    const config = path.join(dir, 'config');
    fs.rmSync(config, { recursive: true, force: true });
    fs.mkdirSync(config);
    const file = path.join(config, 'settings.json');
    const original = settingsFixture(input, { metadata });
    fs.writeFileSync(file, JSON.stringify(original));
    fs.chmodSync(file, mode);
    const run = (...flags) => {
      const result = spawnSync(process.execPath, [INSTALLER, '--config-dir', config, ...flags], { encoding: 'utf8', timeout: 5000 });
      assert.equal(result.status, 0, result.error?.message ?? result.stdout + result.stderr);
      if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, mode);
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    };
    const installed = run();
    assert.equal(installed.hooks.Stop.flatMap((g) => g.hooks).filter(isOurHandler).length, 1);
    const before = fs.readFileSync(file, 'utf8');
    run();
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    const removed = run('--uninstall');
    assert.deepEqual(removed, { metadata, hooks: { SessionStart: original.hooks.SessionStart, ...(expectedRemaining(input).length ? { Stop: expectedRemaining(input) } : {}) } });
    assert.equal(fs.existsSync(path.join(config, 'hooks', 'cache-keepalive.mjs')), false);
  }), installRuns);
});
