# claude-code-cache-keepalive

English | [简体中文](README.zh-CN.md)

A Claude Code `Stop` hook that keeps the main session's **5-minute prompt cache** warm while the session waits for background work (subagents, background shell commands, workflows).

When the main agent hands work to a background subagent and ends its turn, the session goes idle. If the subagent takes longer than about 5 minutes, Claude's prompt cache expires, and the request that resumes the session has to rewrite the entire conversation prefix at cache-write prices. This hook wakes the idle session about 270 seconds after its last request, has it reply with two characters, and so refreshes the cache before it expires.

## How it works

The hook is configured with `asyncRewake: true`, so it runs in the background and does not block Claude Code. Exiting with code 2 wakes the session even when it is idle, and the hook's stderr is shown to the model as a system reminder.

On every `Stop`:

1. **Is the session waiting for something?** It reads `background_tasks` from the hook input. Only running or pending `subagent`, `shell`, and `workflow` tasks count. Shell tasks that look long-lived are ignored: dev servers, watchers, `tail -f`, `docker compose up` without `-d`, and any shell task that has been running for more than 20 minutes. If nothing qualifies, the hook exits.
2. **Find the anchor**, the start time of the session's latest successful Claude request. It is read-only from the [CC Switch](https://github.com/farion1231/cc-switch) request log (`~/.cc-switch/cc-switch.db`, table `proxy_request_logs`). Haiku side requests and the subagent model (`CLAUDE_CODE_SUBAGENT_MODEL`) are excluded. Without that database, the hook falls back to "Stop time minus 30 seconds".
3. **Sleep until anchor + 270 s**, then re-check everything. The hook exits silently if any of these is true:
   - a newer `Stop` has taken over the same session;
   - the transcript has gained an entry timestamped after the hook started, for example a user message or a task-completion notification;
   - the proxy log shows a new main-session request;
   - the cache has already expired (anchor older than 300 s);
   - the real upstream model is not Claude (for example, the proxy routes `claude-*` names to another provider), unless `--any-model` is set;
   - the idle period has reached its cap.
4. **Wake the session.** Otherwise it writes one line to stderr asking the model to reply only `保活` ("keep alive"), without calling any tools, and exits with code 2. That short turn reads the whole cached prefix and appends only a few tokens.

The keepalive turn ends with another `Stop`, so the cycle repeats until the background task finishes or a cap is reached.

### Safety rules

- **Errors never wake the session.** Any exception, including uncaught async errors, is logged and the hook exits 0.
- **Caps per idle period:** 8 wakes or 60 minutes, whichever comes first. Claude Code stops honouring a Stop hook after 8 consecutive continuations, and the turn after a wake arrives with `stop_hook_active: true`, so 8 matches what Claude Code will accept.
- **Only one hook instance per session can wake it.** Each `Stop` starts a separate process. An owner token in the state file makes older instances exit.
- **No content is logged.** Logs hold timestamps, session IDs, decisions, reasons, task types, and model names only. They never contain message text, shell commands, or credentials.

## Measured result

One real run: Claude Opus main session behind a local proxy, a subagent waiting about 8 minutes. Token counts come from the proxy's request log.

| Request | Seconds after anchor | cache_read | cache_creation | output |
|---|---|---|---|---|
| Last request before going idle (anchor) | 0 | 206,352 | 877 | 152 |
| Keepalive turn | +270 | 207,229 | 467 | 4 |
| Resume after the subagent returned | ≈ +499 | 207,696 | 505 | 747 |

- The keepalive turn read exactly the previous full prefix (206,352 + 877).
- The resume request read exactly the keepalive turn's full prefix (207,229 + 467).
- Without the keepalive, the resume request came 499 s after the anchor and would have rewritten about 208K tokens.
- Priced at API rates in the proxy's log, the keepalive turn cost about $0.044 and the avoided rewrite about $1.04. Treat these as estimates; a subscription plan consumes quota rather than dollars.

## Requirements

There are no npm dependencies; everything uses Node built-ins.

- Claude Code with `asyncRewake` hooks and `background_tasks` in the Stop input (v2.1.145 or later). Tested on 2.1.289.
- Node.js 22.13 or later, for the built-in `node:sqlite` module. Tested on 24.20.
- Optional but recommended: CC Switch running as a local proxy with request logging. Without it, the hook uses the fallback anchor and cannot detect a non-Claude upstream.
- Tested on Windows 11. The script only uses Node built-ins and `os.tmpdir()`, but Linux and macOS have not been tested.

## Install

> [!IMPORTANT]
> You need Node.js 22.13+ and Claude Code 2.1.145+. There are no npm dependencies.

### Quick install

```sh
git clone https://github.com/qyh9527/claude-code-cache-keepalive.git
cd claude-code-cache-keepalive
node install.mjs --dry-run   # preview the changes
node install.mjs
```

> [!TIP]
> Run `--dry-run` first. It prints every change the installer would make and writes nothing. To upgrade later, run `git pull`, then `node install.mjs` again.

| Command | What it does |
|---|---|
| `node install.mjs` | Install, or upgrade an existing install |
| `node install.mjs --dry-run` | Show the planned changes without writing anything |
| `node install.mjs --uninstall` | Remove the hook entry and the script; logs are kept |
| `node install.mjs --any-model` | Install without the Claude-only restriction; see [Non-Claude models](#non-claude-models---any-model) |
| `--config-dir <dir>` | Use another Claude config directory. The default is `$CLAUDE_CONFIG_DIR`, or `~/.claude` when that is unset |

The installer copies `cache-keepalive.mjs` into `<config dir>/hooks/` and adds the `Stop` hook to `settings.json`. Claude Code picks up the change without a restart.

> [!NOTE]
> The installer is safe to run repeatedly:
> - It validates `settings.json` first. If the file is not valid JSON, it changes nothing.
> - It backs up `settings.json`, and any older copy of the script, before writing.
> - It leaves every other key and hook untouched.
> - It replaces an earlier entry for this script instead of adding a duplicate.

> [!WARNING]
> **CC Switch 3.x users:** switching providers rewrites `settings.json` from the provider config plus the "common config" snippet. A hook that exists only in `settings.json` is lost on the next switch. Use the optional template installation below, or add the same `Stop` block to common config manually. Default installation only checks whether `~/.cc-switch` exists and prints a reminder; it never opens its database.

### Optional CC Switch template installation

**Exit CC Switch first.** Built-in SQLite is available without a flag in Node 22.x from 22.13, Node 23.x from 23.4, and Node 24+. Node 23.0–23.3 requires `node --experimental-sqlite install.mjs --cc-switch` or an upgrade; if `node:sqlite` cannot be imported, this mode fails safely with a compatibility hint and writes nothing. This explicit mode copies the same script into `<config dir>/hooks/`, but edits only CC Switch's `common_config_claude` template, never reading or writing Claude's `settings.json`.

```sh
node install.mjs --cc-switch --dry-run
node install.mjs --cc-switch
node install.mjs --cc-switch --any-model
node install.mjs --cc-switch --uninstall
# Optional directory override (valid only with --cc-switch):
node install.mjs --cc-switch --cc-switch-dir /path/to/.cc-switch --config-dir /path/to/.claude
```

The database defaults to `~/.cc-switch/cc-switch.db`; a missing database is rejected, not created. Restart CC Switch, then switch providers or apply configuration for the template to take effect. Normal and template installations need separate uninstall commands. Template uninstall removes only its owned handlers and **preserves the shared script**, even when no template hook is installed; it does not inspect Claude settings for references. To delete the script entirely, use normal `node install.mjs --uninstall` after removing template handlers. Normal uninstall does not check template references and can leave a template pointing to a deleted script. No automatic dual-mode management is performed.

The installer validates JSON and hook/group structure before changing anything, preserving unrelated fields and handlers. It reads and merges under a `BEGIN IMMEDIATE` transaction with a three-second lock timeout. Changed existing template rows are backed up locally as `common_config_claude.bak-<timestamp>-<pid>` using exclusive creation and mode `0600` (Windows permissions follow filesystem ACLs), including on uninstall. Backups contain only the original template string, not the database; a missing row has no backup. Identical repeated installations do not back up or rewrite the template. `--dry-run` opens the database read-only, selects the template, and writes no script, configuration, or backup.

**Privacy scope:** installation reads only `settings.value WHERE key = 'common_config_claude'`. It does not read providers, request logs, other setting values, or CC Switch's `settings.json`, and does not back up/export the entire database. To preserve unrelated fields, it parses the **whole template in memory**; this access limit does not guarantee that user-added secrets inside that template are never parsed. Template backups may contain those secrets: keep them private. Template contents and raw SQLite/JSON errors are not printed. There is no network access, upload, or telemetry in this installation mode. This does **not** change the runtime hook's existing read-only access to CC Switch request metadata described in [How it works](#how-it-works).

Database failures roll back the template transaction (rollback failure is reported), and no success is claimed. A backup may remain after a failed update. Script copy happens after commit (template uninstall never deletes it). In this mode, installation/upgrades retain the old-script backup and write the complete script to an exclusively created temporary file in the same directory before atomic rename; a failed write/rename preserves the old script and cleans up the temporary file. If that filesystem step fails, the template may already be updated; correct permissions and rerun. This is not a distributed transaction across database and script files.

### Manual install

Copy `cache-keepalive.mjs` somewhere stable. Then add this block to `~/.claude/settings.json`, next to your existing hooks:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node",
            "args": ["/absolute/path/to/cache-keepalive.mjs"],
            "asyncRewake": true,
            "timeout": 360
          }
        ]
      }
    ]
  }
}
```

> [!IMPORTANT]
> - Use the absolute path to the script.
> - Keep `asyncRewake: true`. Without it the hook cannot wake an idle session.
> - Keep `timeout` at 360 or more. The script gives up on its own after 330 seconds.

## Non-Claude models (`--any-model`)

By default the hook only acts for Claude: it anchors on requests whose model name looks like Claude (`claude`, `opus`, `sonnet`, `fable`), and it stays quiet when the upstream model in the proxy log is something else.

The `--any-model` flag drops both checks, so the hook keeps any upstream warm. Haiku side requests and `CLAUDE_CODE_SUBAGENT_MODEL` are still excluded. Use it when your main model sits behind a provider whose prompt cache also expires after a few minutes of idle time.

```sh
node install.mjs --any-model   # run node install.mjs again without the flag to switch back
```

For a manual install, append `"--any-model"` to `args` after the script path. Log lines then include `"anyModel": true`.

> [!CAUTION]
> Check these before you turn it on:
> - **Timing is tuned for a 5-minute TTL.** The hook fires at 270 s and treats anything older than 300 s as expired. For a provider with a different TTL, adjust `FIRE_AFTER_MS` and `STALE_MS`.
> - **Some providers do not need it.** If their cache does not expire on that schedule, every keepalive is wasted.
> - **Subagents must use a different model.** If a subagent uses the same model name as the main session and `CLAUDE_CODE_SUBAGENT_MODEL` is not set, its requests look like main-session activity. The hook then exits instead of waking the session.

## Logs and state

Files go to `<os temp dir>/cache-keepalive/`:

| File | Content |
|---|---|
| `log.jsonl` | One line per decision. Rotated to `log.1.jsonl` above 1 MB |
| `<session>.json` | Current idle period: start time, wake count, last wake time, owner |
| `<session>.tasks.json` | First-seen time of each background shell task, used for the 20-minute rule |

Common `reason` values in the log:

| reason | Meaning |
|---|---|
| `null` with `decision: "wake"` | Woke the session |
| `no-task` | Nothing worth waiting for. `ignored` lists skipped shell tasks |
| `superseded` | A newer Stop took over |
| `activity-transcript` / `activity-ccswitch` | The session became active again |
| `stale-anchor` | Cache already older than 300 s |
| `non-claude-model` | Upstream model is not Claude |
| `cap` | 8 wakes or 60 minutes reached |
| `transcript-unreadable` | Could not read the transcript or cover newly added data within the tail window; exits to be safe |
| `timeout-guard` | Ran out of time before deciding |
| `error` | Unexpected error, logged and ignored |

## Configuration

Thresholds are constants near the top of the script: `FIRE_AFTER_MS` (270 s), `STALE_MS`, `MAX_WAKES`, `CAP_MS`, `SHELL_MAX_AGE_MS`, and `PERSISTENT_PATTERNS`. Edit them there.

The wake message is in Chinese and asks the model to reply `保活`. To change the language, edit `wakeMessage`.

These environment variables exist for tests:

| Variable | Overrides |
|---|---|
| `CACHE_KEEPALIVE_DIR` | Log and state directory |
| `CACHE_KEEPALIVE_DB` | Path to the CC Switch database |
| `CACHE_KEEPALIVE_SETTLE_S` | Initial settle delay |
| `CACHE_KEEPALIVE_FIRE_AFTER_S` | Seconds after the anchor at which to fire |
| `CACHE_KEEPALIVE_TEST_THROW` | Triggers a simulated async crash |

## Tests

```sh
node test/run.mjs                 # hook behavior scenarios, about 20 seconds
node test/install.test.mjs        # installer; POSIX permission checks are skipped on Windows
node --test test/runner.test.mjs   # successful and failed test-runner exit codes
```

Every run and scenario uses its own temp directory, so your real `~/.claude`, logs, and proxy database are never touched. Each hook scenario also gets its own transcript and a small SQLite database. Any failed check makes the test runner exit nonzero, so it can be used directly in CI.

### Seeded fuzz tests

For development, install the locked test dependencies and run the complete suite:

```sh
npm ci --ignore-scripts
npm test
npm run test:fuzz                 # fuzz only
```

`fast-check` is a development dependency; running or installing the hook still needs only Node's built-in modules. The fuzz suite runs 10,000 generated cases per helper property and 25 installer CLI round trips by default. It checks command quoting and Node options, removal of owned hooks, and transcript activity against a full-file byte oracle around the 256 KB boundary, including Unicode and timestamp thresholds. CLI round trips check config preservation, idempotence, uninstall, and POSIX permissions. Private helpers are loaded from the actual standalone scripts into isolated VM contexts; their implementations are not copied into tests.

`FUZZ_RUNS` changes the helper case count, `FUZZ_INSTALL_RUNS` changes the CLI case count, and `FUZZ_SEED` selects a signed 32-bit seed (default `24301`). A failure reports its minimized counterexample, seed and path. Replay only the failing test by its exact name, using the reported seed and path; for example, in PowerShell:

```powershell
$env:FUZZ_SEED='24301'; $env:FUZZ_PATH='0:1'; node --test --test-name-pattern='^hook ownership follows the script, never option values or data args$' test/fuzz.test.mjs
Remove-Item Env:FUZZ_PATH,Env:FUZZ_SEED
```

Replace the example seed and path with the failure report's values. Turn confirmed failures into fixed regression cases before fixing them. GitHub Actions runs the complete suite on Linux and Windows with Node 22 and 24, using 1,000 cases per helper property and 25 CLI round trips. Its seed is the workflow run number, printed with each property so failures remain reproducible.

## Limitations

- **Permission prompts:** while Claude Code is waiting on a permission prompt, the turn has not ended, so `Stop` does not fire and nothing can be kept warm.
- **History grows:** every keepalive adds a short reminder and a two-character reply to the conversation history.
- **Relies on the model:** the model is asked, not forced, to reply briefly and call no tools.
- **UI label:** Claude Code labels the wake as "Stop hook blocking error". This is cosmetic.
- **Narrow races:** a concurrent Stop can still race the final commit within a window of milliseconds. There is no cross-process lock.
- **CC Switch 4.x:** the database layout has not been verified on 4.x. If the query fails, the hook falls back to the estimated anchor.

## License

[MIT](LICENSE)
