# claude-code-cache-keepalive

[English](README.md) | 简体中文

一个 Claude Code `Stop` hook：主会话等待后台任务（子代理、后台 shell 命令、workflow）时，在 **5 分钟 prompt cache** 过期前唤醒一次主会话，让缓存续上。

主代理把活交给后台子代理、结束本轮之后，会话就空闲了。如果子代理跑了 5 分钟以上，Claude 的 prompt cache 会过期，子代理返回后那次恢复请求要把整段对话前缀按缓存写入价重写一遍。这个 hook 在最近一次请求开始约 270 秒后唤醒空闲的会话，让它只回两个字，赶在缓存过期前把缓存刷新。

## 工作原理

hook 配置为 `asyncRewake: true`：它在后台运行，不阻塞 Claude Code；以 exit 2 退出时，即使会话空闲也会被立即唤醒，hook 的 stderr 会作为 system reminder 交给模型。

每次 `Stop` 时依次执行：

1. **判断会话是否在等任务。** 读取 hook 输入里的 `background_tasks`，只有运行中或排队中的 `subagent`、`shell`、`workflow` 才算。看起来是常驻进程的 shell 会被忽略，包括：
   - dev server、watch 模式、`tail -f`；
   - 不带 `-d` 的 `docker compose up`；
   - 运行超过 20 分钟的 shell 任务。

   没有符合条件的任务就直接退出。
2. **确定锚点**，即本会话最近一次成功的 Claude 请求的开始时间。锚点从 [CC Switch](https://github.com/farion1231/cc-switch) 的请求日志里只读查询（`~/.cc-switch/cc-switch.db` 的 `proxy_request_logs` 表）。子代理和主会话共用 `session_id`，还可能被路由到同一个上游模型，所以只认 `request_id` 里带有主 transcript 消息 id 的行（CC Switch 4.0.6 记为 `session:<响应 id>`）；找不到这样的行时，改为按主会话最后一条回复的上游模型匹配。haiku 旁路请求和子代理模型（`CLAUDE_CODE_SUBAGENT_MODEL`）会被排除。没有这个库时，用"Stop 时刻减 30 秒"兜底。
3. **睡到锚点 + 270 秒，醒来后重新检查。** 下面任一条件成立就静默退出：
   - 同一会话有更新的 `Stop` 接管；
   - transcript 出现了时间戳晚于 hook 启动的条目，例如用户消息或任务完成通知；
   - 请求日志里出现了新的主会话请求；
   - 锚点已超过 300 秒，缓存已经过期；
   - 上游实际模型不是 Claude，比如代理把 `claude-*` 转发到了别家（设置了 `--any-model` 时不检查这一条）；
   - 本空闲期已经到达上限。
4. **唤醒会话。** 以上条件都不成立时，往 stderr 写一句话，要求模型只回复"alive"、不调用任何工具，然后以 exit 2 退出。这一轮会读取整段缓存前缀，只追加几个 token。

保活这一轮结束时又会触发 `Stop`，如此循环，直到后台任务结束或达到上限。

### 安全规则

- **出错永远不唤醒。** 任何异常（包括未捕获的异步异常）都只记日志，然后 exit 0。
- **每个空闲期的上限：** 最多唤醒 8 次或持续 60 分钟，先到为准。Claude Code 对 Stop hook 连续续跑最多认 8 次；而被唤醒那一轮结束时，Stop 输入里 `stop_hook_active` 为 `true`。8 次正好是 Claude Code 能接受的上限。
- **同一会话只有一个实例能唤醒。** 每次 `Stop` 都会起一个独立进程；状态文件里的 owner 标记让旧实例自动退出。
- **不记录正文。** 日志只有时间、会话 ID、决策、原因、任务类型和模型名，不含消息内容、shell 命令或凭据。

## 实测结果

一次真实运行：Claude Opus 主会话，经本地代理转发，子代理等待约 8 分钟。token 数来自代理的请求日志。

| 请求 | 距锚点（秒） | cache_read | cache_creation | output |
|---|---|---|---|---|
| 进入空闲前的最后一次请求（锚点） | 0 | 206,352 | 877 | 152 |
| 保活轮 | +270 | 207,229 | 467 | 4 |
| 子代理返回后的恢复请求 | ≈ +499 | 207,696 | 505 | 747 |

- 保活轮读到的正好是上一轮的完整前缀（206,352 + 877）。
- 恢复请求读到的正好是保活轮的完整前缀（207,229 + 467）。
- 如果没有保活，恢复请求距锚点已有 499 秒，需要重写约 20.8 万 token。
- 按代理日志里的 API 价格折算，保活轮约 $0.044，省下的重写约 $1.04。这只是估算；订阅制消耗的是额度，不是美元。

## 环境要求

没有任何 npm 依赖，只用 Node 内置模块。

- Claude Code 需支持 `asyncRewake`，并且 Stop 输入里有 `background_tasks`（v2.1.145 及以上）。已在 2.1.289 上测试。
- Node.js 22.13 及以上，因为要用内置的 `node:sqlite`。已在 24.20 上测试。
- 可选但推荐：CC Switch 作为本地代理并开启请求日志。没有它时，只能用兜底锚点，也无法识别上游是不是 Claude。
- 已在 Windows 11 上测试。脚本只用 Node 内置模块和 `os.tmpdir()`，但没有在 Linux 和 macOS 上测试过。

## 安装

> [!IMPORTANT]
> 需要 Node.js 22.13+ 和 Claude Code 2.1.145+。没有任何 npm 依赖。

### 一键安装

```sh
git clone https://github.com/qyh9527/claude-code-cache-keepalive.git
cd claude-code-cache-keepalive
node install.mjs --dry-run   # 先预览会改什么
node install.mjs
```

> [!TIP]
> 建议先跑 `--dry-run`：它会列出安装器将做的每一处改动，但什么都不写。以后升级时，先 `git pull`，再跑一次 `node install.mjs`。

| 命令 | 作用 |
|---|---|
| `node install.mjs` | 安装；已安装时就是升级 |
| `node install.mjs --dry-run` | 只显示将要做的改动，不写任何东西 |
| `node install.mjs --uninstall` | 移除 hook 条目和脚本，日志保留 |
| `node install.mjs --any-model` | 安装不限 Claude 的版本，见下方「非 Claude 模型」一节 |
| `--config-dir <目录>` | 指定别的 Claude 配置目录。默认用 `$CLAUDE_CONFIG_DIR`，没设置时用 `~/.claude` |

安装器会把 `cache-keepalive.mjs` 复制到 `<配置目录>/hooks/`，并在 `settings.json` 里加上 `Stop` hook。Claude Code 会自动加载，不需要重启。

> [!NOTE]
> 安装器可以放心重复运行：
> - 先校验 `settings.json`，不是合法 JSON 就什么都不改；
> - 写入前先备份 `settings.json`，旧版脚本也会备份；
> - 其他键和其他 hook 原样保留；
> - 已有本脚本的旧条目会被替换，不会重复添加。

> [!WARNING]
> **CC Switch 用户：** 某些版本切换供应商时会重写 `settings.json`，只存在于该文件的 hook 可能丢失。请按下面的步骤手动配置；安装器只检测 `~/.cc-switch` 是否存在并提醒，不自动修改 CC Switch 的通用模板或供应商配置。

### CC Switch：手动配置通用模板

以下步骤依据 **CC Switch 3.16.5 的旧通用配置机制**。其他版本需确认相应入口；上游开发分支 `8596a23` 已改变该机制，不能保证此方法适用。

1. 运行 `node install.mjs` 安装脚本，记下输出中的脚本绝对路径。
2. **先不要切换供应商。** 在 CC Switch 中编辑当前 Claude 供应商，把下面的 `hooks.Stop` 条目合并到「通用配置」JSON；保留其他字段及已有 hook，将示例路径换成实际绝对路径。
3. 启用 **Apply Common Config（应用通用配置）**，保存**整个供应商表单**，不要只关闭通用配置编辑器。
4. 对其他需要使用的 Claude 供应商逐个启用该选项并保存，再切换供应商。未启用时，模板不保证生效。

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

> [!WARNING]
> 在 3.16.5 中，直接切换可能将旧 live 配置回填到通用模板，撤销刚做的修改。卸载时，先从通用模板和相关供应商配置中移除本工具条目，确认当前供应商的配置 JSON 也已移除并保存，再运行 `node install.mjs --uninstall`；否则切换时可能恢复旧条目。只移除本工具的 handler，不删除其他 hook。

**隐私范围：** 这些步骤由你在 CC Switch GUI 中手动完成；安装器不打开 CC Switch 数据库、不读取供应商或通用模板、不上传配置。此说明仅针对安装过程，运行时保活脚本仍会只读请求元数据，见「工作原理」。

源码依据：[3.16.5 切换时回填](https://github.com/farion1231/cc-switch/blob/8d1b3306d09a27b9d8fc29694791d8421aba5f93/src-tauri/src/services/provider/mod.rs#L2190-L2244)、[通用配置启用条件](https://github.com/farion1231/cc-switch/blob/8d1b3306d09a27b9d8fc29694791d8421aba5f93/src-tauri/src/services/provider/live.rs#L354-L368)。

### 手动安装

把 `cache-keepalive.mjs` 放到一个固定位置，然后在 `~/.claude/settings.json` 的 `hooks` 里加入下面这段，和已有的 hook 并列：

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
> - 脚本路径必须写绝对路径。
> - `asyncRewake: true` 不能去掉，没有它就无法唤醒空闲的会话。
> - `timeout` 至少保持 360。脚本自己会在 330 秒时放弃。

## 非 Claude 模型（`--any-model`）

默认只对 Claude 生效，具体有两条检查：
- 锚点只取模型名像 Claude 的请求（含 `claude`、`opus`、`sonnet`、`fable`）；
- 代理日志显示上游实际是别的模型时，hook 不唤醒。

加上 `--any-model` 后这两条都不再检查，上游是任何模型都保活。haiku 旁路请求和 `CLAUDE_CODE_SUBAGENT_MODEL` 仍然会被排除。如果你的主模型所在的供应商，prompt cache 也会在空闲几分钟后过期，就用这个参数。

```sh
node install.mjs --any-model   # 想切回默认，不带这个参数再运行一次 node install.mjs
```

手动安装时，在 `args` 里脚本路径后面加上 `"--any-model"`。开启后日志里会多一个 `"anyModel": true` 字段。

> [!CAUTION]
> 开启前先确认这三点：
> - **时间参数是按 5 分钟 TTL 定的。** hook 在 270 秒时触发，超过 300 秒就视为缓存已过期。供应商的 TTL 不同，就要调整 `FIRE_AFTER_MS` 和 `STALE_MS`。
> - **有的供应商根本不需要保活。** 如果它的缓存不会按这个时间表过期，每次保活都是浪费。
> - **子代理的失败请求可能被当成主会话。** 成功的请求按消息 id 区分；失败的请求没有响应 id，只能按请求模型归属。如果子代理和主会话用同一个模型名，子代理的失败请求会被当成主会话的活动，hook 就会直接退出，不再唤醒会话。数据库里没有消息 id 时（不记录响应 id 的 CC Switch 版本），和以前一样，凡是上游模型与主会话相同的子代理请求都会被算进来。

## 日志与状态

文件都放在 `<系统临时目录>/cache-keepalive/`：

| 文件 | 内容 |
|---|---|
| `log.jsonl` | 每次决策一行。超过 1 MB 时转存为 `log.1.jsonl` |
| `<session>.json` | 当前空闲期：开始时间、唤醒次数、上次唤醒时间、owner |
| `<session>.tasks.json` | 每个后台 shell 任务首次出现的时间，用于 20 分钟判定 |

日志里常见的 `reason`：

| reason | 含义 |
|---|---|
| `null`，且 `decision: "wake"` | 已唤醒 |
| `no-task` | 没有值得等的任务。被忽略的 shell 任务列在 `ignored` 里 |
| `superseded` | 被更新的 Stop 接管 |
| `activity-transcript` / `activity-ccswitch` | 会话恢复了活动 |
| `stale-anchor` | 缓存已超过 300 秒 |
| `non-claude-model` | 上游不是 Claude |
| `cap` | 已唤醒 8 次或已满 60 分钟 |
| `transcript-unreadable` | 读不到 transcript，或尾部窗口无法覆盖新增数据，保守退出 |
| `timeout-guard` | 来不及决策就超时 |
| `error` | 意外错误，已记录并忽略 |

## 配置

各项阈值是脚本顶部的常量，直接在脚本里改：`FIRE_AFTER_MS`（270 秒）、`STALE_MS`、`MAX_WAKES`、`CAP_MS`、`SHELL_MAX_AGE_MS`、`PERSISTENT_PATTERNS`。

唤醒语是英文，要求模型回复"alive"。想换语言就改 `wakeMessage`。

下面这些环境变量供测试使用：

| 变量 | 覆盖的内容 |
|---|---|
| `CACHE_KEEPALIVE_DIR` | 日志和状态目录 |
| `CACHE_KEEPALIVE_DB` | CC Switch 数据库路径 |
| `CACHE_KEEPALIVE_SETTLE_S` | 启动后的等待时间 |
| `CACHE_KEEPALIVE_FIRE_AFTER_S` | 锚点后多少秒触发 |
| `CACHE_KEEPALIVE_TEST_THROW` | 模拟一次异步崩溃 |

## 测试

```sh
node test/run.mjs                 # hook 行为场景，约 20 秒
node test/install.test.mjs        # 安装器（POSIX 权限检查在 Windows 上跳过）
node --test test/runner.test.mjs   # 测试入口的成功／失败退出码
```

每次运行和每个场景都用独立的临时目录，不会碰真实的 `~/.claude`、日志和代理数据库。hook 的每个场景还各有自己的 transcript 和迷你 SQLite 库。任何检查失败时测试入口都会返回非零退出码，可直接用于 CI。

### 可复现的 fuzz 测试

开发时安装锁定的测试依赖，再运行完整测试：

```sh
npm ci --ignore-scripts
npm test
npm run test:fuzz                 # 仅 fuzz
```

`fast-check` 仅为开发依赖，运行和安装 hook 仍然只需 Node 内置模块。默认每条辅助函数属性生成 10,000 个用例，另做 25 次安装器 CLI 往返测试。覆盖命令引号和 Node 参数、本工具 hook 的移除，以及 256KB 边界附近的 transcript 活动判断；后者用全文件字节位置作独立参照，包含 Unicode 和时间戳阈值。CLI 测试检查配置保留、重复安装幂等、卸载和 POSIX 权限。私有辅助函数从实际独立脚本加载到隔离的 VM 中，不在测试里复制实现。

`FUZZ_RUNS` 控制辅助函数用例数，`FUZZ_INSTALL_RUNS` 控制 CLI 用例数，`FUZZ_SEED` 指定有符号 32 位种子，默认 `24301`。失败报告会给出缩减后的输入、种子和 path。复现时用报告里的种子和 path，并按完整名称只选中失败的测试，例如 PowerShell：

```powershell
$env:FUZZ_SEED='24301'; $env:FUZZ_PATH='0:1'; node --test --test-name-pattern='^hook ownership follows the script, never option values or data args$' test/fuzz.test.mjs
Remove-Item Env:FUZZ_PATH,Env:FUZZ_SEED
```

请把示例种子和 path 替换为失败报告中的值。确认缺陷后，先把最小输入固化为回归用例再修复。GitHub Actions 在 Linux／Windows、Node 22／24 上运行完整测试，每条辅助函数属性生成 1,000 个用例，另做 25 次 CLI 往返。CI 使用工作流运行序号作为种子，每条属性都会打印，方便复现失败。

## 已知限制

- **权限弹窗：** Claude Code 等待权限确认时，这一轮还没结束，`Stop` 不会触发，所以这段时间无法保活。
- **历史变长：** 每次保活都会在对话历史里留下一条简短提醒和两个字的回复。
- **依赖模型配合：** 只是要求模型简短回复、不调用工具，无法强制。
- **界面提示：** Claude Code 会把唤醒显示为 "Stop hook blocking error"，只是显示问题。
- **竞态窗口：** 并发的 Stop 仍可能在毫秒级窗口内和最后一次提交发生竞争；脚本没有跨进程锁。
- **CC Switch 4.x：** 只在 4.0.6 上验证过数据库结构。查询失败时会退回兜底锚点。

## 许可证

[MIT](LICENSE)
