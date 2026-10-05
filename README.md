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
   - the real upstream model is not Claude (for example, the proxy routes `claude-*` names to another provider);
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

```sh
git clone https://github.com/qyh9527/claude-code-cache-keepalive.git
cd claude-code-cache-keepalive
node install.mjs --dry-run   # preview the changes
node install.mjs
```

The installer:

- checks the Node version;
- copies `cache-keepalive.mjs` into `~/.claude/hooks/`. It honours `CLAUDE_CONFIG_DIR`, or you can pass `--config-dir <dir>`;
- adds the `Stop` hook to `settings.json`.

It is safe to run again; use it to upgrade as well. It also:

- validates `settings.json` first and changes nothing if the file is not valid JSON;
- backs up `settings.json` (and an older copy of the script) before writing;
- keeps every other key and hook as is;
- replaces an earlier entry for this script instead of adding a duplicate.

To remove the hook entry and the script, run `node install.mjs --uninstall`. Logs are kept.

Claude Code picks up hook changes without a restart.

**CC Switch 3.x users:** switching providers rewrites `settings.json` from the provider config plus the "common config" snippet. Hooks that exist only in `settings.json` are lost on the next switch, so add the same `Stop` block to CC Switch's common config as well. The installer prints a reminder when it finds `~/.cc-switch`.

### Manual install

Copy `cache-keepalive.mjs` somewhere stable and add this next to your existing hooks in `~/.claude/settings.json`, using the absolute path to the script:

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

Keep `timeout` at 360 or more; the script gives up on its own after 330 seconds.

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
| `transcript-unreadable` | Could not read the transcript; exits to be safe |
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
node test/run.mjs            # the hook: 28 scenarios in parallel, about 8 seconds
node test/install.test.mjs   # the installer: 7 scenarios
```

Every scenario uses its own temp directory, so your real `~/.claude`, logs, and proxy database are never touched. Each hook scenario also gets its own transcript and a small SQLite database.

## Limitations

- **Permission prompts:** while Claude Code is waiting on a permission prompt, the turn has not ended, so `Stop` does not fire and nothing can be kept warm.
- **History grows:** every keepalive adds a short reminder and a two-character reply to the conversation history.
- **Relies on the model:** the model is asked, not forced, to reply briefly and call no tools.
- **UI label:** Claude Code labels the wake as "Stop hook blocking error". This is cosmetic.
- **Narrow races:** a concurrent Stop can still race the final commit within a window of milliseconds. There is no cross-process lock.
- **CC Switch 4.x:** the database layout has not been verified on 4.x. If the query fails, the hook falls back to the estimated anchor.

## License

[MIT](LICENSE)
