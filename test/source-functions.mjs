// Load the actual private helpers without running either standalone CLI.
// Keep production scripts self-contained: the installer copies just one hook file.
import fs from 'node:fs';
import vm from 'node:vm';

function section(source, first, next) {
  const start = source.indexOf(first);
  const end = source.indexOf(next, start + first.length);
  if (start < 0 || end < 0) throw new Error(`Missing source section: ${first} -> ${next}`);
  return source.slice(start, end);
}

function constant(source, name) {
  const match = source.match(new RegExp(`^const ${name} = .*;`, 'm'));
  if (!match) throw new Error(`Missing source constant: ${name}`);
  return match[0];
}

const installer = fs.readFileSync(new URL('../install.mjs', import.meta.url), 'utf8');
export const installFunctions = vm.runInNewContext([
  constant(installer, 'SCRIPT_NAME'),
  section(installer, 'const portableBasename =', 'function readSettings()'),
  section(installer, 'function removeOurHandlers(', 'function checkNode()'),
  '({ commandWords, isOurHandler, removeOurHandlers })',
].join('\n'), {}, { timeout: 1000, filename: 'install-helpers.mjs' });

const hook = fs.readFileSync(new URL('../cache-keepalive.mjs', import.meta.url), 'utf8');
export const transcriptFunctions = vm.runInNewContext([
  constant(hook, 'TRANSCRIPT_TAIL_BYTES'),
  constant(hook, 'TRANSCRIPT_LAG_MS'),
  section(hook, 'function snapshotFile(', 'function isPersistentCommand('),
  '({ snapshotFile, readTranscriptTail, checkTranscript })',
].join('\n'), { fs, Buffer }, { timeout: 1000, filename: 'transcript-helpers.mjs' });
