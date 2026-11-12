---
description: Latch 的 MCP 服务器：本机命令的定义与秘密、本机确认、测试、「用在」、latch-mcp 桥与工具网关、交给各 Harness、审计与限制。
sources:
  - apps/host/src/mcp.ts
  - apps/host/src/routes/mcp.ts
  - apps/host/src/audit-actions/mcp.ts
  - apps/host/src/tool-gateway.ts
  - packages/harness-acp/src/mcp-bridge.ts
  - packages/protocol/src/mcp.ts
  - apps/web/src/settings/McpSettings.tsx
  - apps/web/src/agents/McpSection.tsx
  - packages/testkit/fixtures/fake-mcp-stdio.mjs
  - apps/host/test/mcp.test.ts
  - packages/harness-acp/test/mcp-bridge.test.ts
  - e2e/mcp.e2e.ts
---

# MCP 服务器

MCP 有两半：Latch 定义的服务器，和各 Harness 自己配置的服务器。Latch 只管前一半，经 Latch 的调用有记录；Harness 自己的服务器（以及完全访问的 Agent 自己启动的任何程序）Latch 一次也看不到。**这不是沙箱**：本机命令以你的身份运行，Latch 不隔离它。

现在只有本机命令（stdio）。远程地址、OAuth、Harness 自己的 MCP 的状态与「从项目导入」尚未实现。

## 定义与秘密

- `<数据目录>/mcp/servers.json`：定义，strict schema。每个服务器有 ID（`mcp_` 加 22 位）、名称、命令（保存时找到的绝对路径）、参数、**普通变量**（名字与值，属于确认过的定义，设备可读）、**秘密变量**的名字、「在项目文件夹里启动」、「用在」、开关、关掉的工具、修订号、`specHash`（命令、参数、普通变量、秘密变量名与工作目录方式的 SHA-256）、`confirmed`（本机确认通过时的 `specHash` 与它点名的秘密变量名，只在确认通过时写）和最近一次报告（状态、工具名、原因枚举、时间、来自测试还是会话）。还存最近 256 个请求的回执：请求 ID 与设备的哈希、请求体的哈希。
- `<数据目录>/mcp/secrets.json`：秘密变量的值，strict schema。值从不返回任何设备：读接口只回 `{ name, set, secret: true }`；普通变量带 `value`。秘密变量的名字不能决定加载哪些程序或文件（`BASH_ENV`、`ENV`、`PYTHONPATH`、`PYTHONHOME`、`PYTHONSTARTUP`、`PERL5OPT`、`PERL5LIB`、`RUBYOPT`、`RUBYLIB`、`NODE_OPTIONS`、`NODE_PATH`、`JAVA_TOOL_OPTIONS`、`_JAVA_OPTIONS`、`JDK_JAVA_OPTIONS`、`PERLLIB`、`SHELLOPTS`、`PS4`、`LUA_INIT`、`GOFLAGS`、`GOPROXY`、`CLASSPATH`、`RUSTFLAGS`、`PATH`、`HOME`，以及 `UV_*`、`PIP_*`、`PIPX_*`、`NPM_CONFIG_*`、`BUN_*`、`DENO_*`、`GEM_*`、`CARGO_*`、`XDG_*`、`DYLD_*`、`LD_*`、`GIT_*`，不分大小写），值也不能像路径或地址（`~/`、`./`、`../`、盘符开头，或形如路径的 `/…`：只有路径字符、且有第二个 `/` 或以 `/usr`、`/Users` 等根目录开头，所以以 `/` 开头的 base64 秘密仍可作秘密；`<scheme>://`、`file:`、`data:` 与 `host:port`）：这些只能作普通变量，出现在确认里（400 `mcp-secret-not-allowed`，说明原因）。
- 两个文件都是 0600，目录 0700，原子写入，不进时间机器备份，诊断导出不含它们。和模型密钥一样，这是「磁盘上只存哈希」的例外：完全访问的 Agent 能读它，也能读服务器进程的环境。
- 秘密变量的值（8 个字符以上；更短的不加入，不受这一层保护）从此在 Host 发出的文字里按确切值遮盖，原样、JSON 转义与 URL 编码三种写法都算（`redactKnownSecrets`、`maskKnownSecrets`）：日志、错误、事件、诊断，ACP Agent 的文字与工具输出（存下与发给设备之前），终端「加入对话」、应用构建与 Git 交付的输出。判断文件或文字是否含秘密的检查（`redactSecrets`、`containsSecret`）只认形状，不受它影响。
- 命令按 Harness 命令的同一规则查找（`resolveCommand`），含 `/` 的相对路径按找不到处理。命令落在数据目录、Latch 程序目录、默认工作区或任何项目的文件夹里时拒绝（400 `mcp-command-forbidden`）。名称是字母、数字、`-`、`_`，最多 32 个，不以 `latch` 开头（留给 `latch-skills`、`latch-browser`）。变量名不能是 `PATH` 或 Harness 定义保留的名字（`NODE_OPTIONS`、`LATCH_*`、`DYLD_*` 等）。

## 路由

| 路由 | 谁 | 说明 |
| --- | --- | --- |
| `GET /mcp/servers` | `view` | `{ revision, servers }`；没有值 |
| `POST /mcp/servers` | `host.sock` 的 `admin` | `{ requestId, baseRevision, name, command, args, env, secrets, projectCwd, scope }`；本机确认 `mcp.server.apply` |
| `PATCH /mcp/servers/:id` | `host.sock` 的 `admin`；`{ enabled: false }` 任何 `admin` 设备 | `{ requestId, baseRevision, …改动 }`，`baseRevision` 是这个服务器的修订号；放宽时本机确认 |
| `DELETE /mcp/servers/:id` | `host.sock` 的 `admin` | 连同它的值一起删除 |
| `POST /mcp/servers/:id/test` | `host.sock` 的 `admin` | `{ requestId }`；见「测试」 |

- 同一设备的同一 `requestId` 带同样的请求体：按回执回答，不再确认、不再执行；带不同的请求体：409 `request-conflict`。修订号不对：409 `mcp-changed`。
- **要本机确认**：新增；换命令、参数或工作目录方式；新增、修改或移除普通变量；新的秘密变量名。由 `widens` 一处判断（`spec`）。标题「添加 MCP 服务器」，系统表单的句子是「让 Agent 运行 <命令的绝对路径>（MCP 服务器「<名称>」）」。命令是 `npx`、`pnpx`、`uvx`、`pipx`、`bunx`、`node`、`python`、`python3`、`deno` 或 `ruby` 时（`mcp.server.apply-runner`）句子是「让 Agent 运行 <程序的文件名> <它运行的包或脚本>（<四位哈希>，MCP「<名称>」）」：包或脚本按各程序的选项解析（`--package`/`-p`、`--from`、`--spec`、`-m`，跳过 `--with`、`-r` 等带值的选项与 `run` 子命令），只在中间截断，后面是整串的 SHA-256 前四位，所以 `evilmodelcontextprotocol/server-github` 与 `@modelcontextprotocol/server-github` 不会看起来一样；选项说不清时（`-e`、`-c` 等内联代码、不认识的选项）显示原样的第一个参数加哈希。路径在前，人起的名字只能在它后面。卡片上的行列出命令、参数、普通变量（含值）、秘密变量名、工作目录与「用在」；秘密的值只以哈希绑定在确认上。保存时记下 `confirmed`；测试与每次启动之前都核对定义与它一致（`isConfirmed`）。
- **不要确认，但先审计、写不进就不生效**（`widens` 的 `use`）：秘密变量换值、「用在」多了 Agent、项目或所有会话、关掉的工具重新打开、启用。移除秘密变量也算这一类。**只收窄**（审计失败照常执行，响应带 `x-latch-audit: failed`）：改名、「用在」变少、关工具、停用、移除服务器。代码与去向确认过一次，挂到更多会话是使用，不是新边界。
- 有完全访问会话在运行或等你处理时，放宽与其他本机确认一样返回 409 `presence-blocked`；停用、移除从不被挡。
- 审计（detail 只有 ID、哈希、枚举、布尔与计数，没有名称、命令、值）：`mcp.server.added`（先于保存，写不进就不保存）、`mcp.server.changed`（`kinds`：`spec`、`secret`、`scope`、`tools`、`enabled`、`name`；只收窄的改动在审计失败时照常执行，响应带 `x-latch-audit: failed`）、`mcp.server.removed`、`mcp.server.test`。

## 测试

只在这台 Mac 上由人按下，只对与确认一致的定义（`isConfirmed`）。命令本身，或参数与普通变量值里的任何路径（绝对路径、`~/`、`file:` URL、`--选项=路径` 的值、相对路径按测试自己的空文件夹解析，`NODE_OPTIONS` 里 `--require`/`-r`/`--import`/`--loader` 的模块；含 `${workspaceFolder}` 的参数也算），按路径段比较、连同 `realpath`，落在任何项目的文件夹、工作树目录、Agent 目录、数据目录、Latch 的程序目录或任何会话的文件夹里时拒绝（409 `mcp-test-repository`，说明原因）：测试是 Host 自己运行程序，Host 不运行仓库里的程序。Agent 一侧经桥启动的服务器不受这条限制。Host 在自己临时目录里新建一个空文件夹，以下面「环境」的清单启动命令（自己的进程组，stderr 丢弃），发 `initialize`（不声明任何客户端能力）与 `tools/list`，最多 20 秒、最多读 1 MiB 输出，然后结束整个进程组、删除文件夹。服务器自己的请求一律回答 method not found。结果（工具名，或原因：`spawn-failed`、`exited`、`timeout`、`protocol`、`list-failed`、`output-too-large`）记为这个服务器的报告。

## 用在哪些会话

「用在」是所有会话，或选中的 Agent（我的 Agent，含它们的定时运行）与项目（会话的 `workspaceId`），后两者取并集。一个会话拿到哪些服务器，在每次启动 Agent 进程时按当时的定义算出（新会话、恢复、载入、分叉），这组服务器与它们的 `specHash` 的哈希在给出它们的同一刻算出，记进 `task.l3.started` 的 `mcpSetHash`。停用、移除、改了定义或「用在」不再包括这个会话的服务器：正在运行的桥立即结束，下一次也不再给。桥启动服务器与每次调用时 Host 再核对一次：服务器仍在、开着、定义与确认一致、这个会话仍在「用在」里、工具没被关掉，否则拒绝。

## latch-mcp 桥

- 每个服务器在 `mcpServers` 里是一个桥：命令是 Host 自己的 Node，参数是 `--disable-sigusr1 -e <固定源码> <网关套接字> <令牌文件>`，`env` 为空，名字是服务器的名称。参数里没有令牌、没有秘密。
- 令牌：工具网关（[ARCHITECTURE.md](ARCHITECTURE.md#harness-与会话路由) 的「工具网关」）为每个桥发一个 `lbt1.` 令牌，写进网关目录里新建的 0600 文件；Host 只存哈希。桥在 `initialize` 时才读出并删除它，所以只问 `server/discover`（2026 版握手）的一次性副本拿不到令牌：桥回答 method not found，Agent 回到 `initialize`。令牌随 Agent 进程结束、会话归档或删除、服务器被移除、停用或改动而失效。
- 启动：桥经网关取 `mcp/launch`：命令、参数（`${workspaceFolder}` 换成会话的主文件夹）、环境与工作目录。Host 先写 `mcp.server.started`（服务器 ID、会话 ID、`specHash`），写不进就不启动。这是秘密离开 Host 的唯一地方：它们只写进服务器进程的环境。服务器在自己的进程组里。
- 环境只来自 Host 的清单：`PATH`（命令所在目录在前，再加这个人的程序目录）、`HOME`、`USER`、`LOGNAME`、`LANG`、`LC_ALL`、`TMPDIR`、`SHELL`、`TERM`、Host 的代理与 CA 变量，再加这个服务器自己的变量。Agent 进程的环境（包括 `lmg1.` 网关凭据与 `lbt1.` 令牌）带不进去。
- 工作目录：默认是 Host 运行目录里为这个桥新建的空文件夹（所以 `npx` 不会先用项目 `node_modules` 里的同名包），桥结束时删除；打开「在项目文件夹里启动」时是会话的主文件夹。
- 只转发 `initialize`、`ping`、`tools/list`、`tools/call`、取消与 `notifications/tools/list_changed`。服务器的能力只报告 `tools`；服务器自己的请求（sampling、elicitation、roots）一律回答 method not found；resources 与 prompts 尚未实现。
- 关掉的工具不在 `tools/list` 里，调用直接回答错误，不经过服务器。
- 每次 `tools/call` 先经网关写 `mcp.tool.called`（服务器 ID、会话 ID、调用 ID、工具名与服务器 ID 的哈希），写不进就不转发；结束时补 `mcp.tool.settled`（`ok`、`error`、`cancelled`、`failed` 与耗时）。参数与结果从不经过网关。
- **坏掉的服务器不挡会话。** 命令起不来、进程退出或 30 秒内没有完成 `initialize` 时，桥自己回答 `initialize`（只有 tools 能力）、`tools/list` 为空，并经网关报告原因：DeepSeek Harness（任何一个服务器失败就拒绝建会话）也照常开始。会话里写一行「MCP 服务器「名称」没有启动：原因」，设置里的状态变成「失败」。
- 桥的标准输入关闭、令牌失效（网关断开连接）或收到 SIGTERM 时，结束服务器的整个进程组。

## 各 Harness

| Harness | 怎样拿到 |
| --- | --- |
| 经 ACP 的预设与自定义 Harness | `session/new`、`resume`、`load` 与分叉的 `mcpServers`，在 `latch-skills`、`latch-browser` 之后，每个服务器一个桥 |
| Codex 直连 | 线程的 `config.mcp_servers`（`thread/start` 与 `thread/resume`），每个服务器一个桥，加 `startup_timeout_sec: 60`（`npx` 首次下载常超过 Codex 默认的 10 秒）；Codex 可能把线程配置写进它自己的文件，那里只有路径。同名时线程覆盖 Codex 自己的服务器 |
| pi | 不接收（预设 `skillServer: false`） |
| 内置 Harness | 本机命令尚未实现：要由 Host 自己运行这个命令，而内置 Harness 是 L1 |

`HarnessInfo.skills === 'server'` 的 Harness 接收 Latch 的服务器；页面据此说明。真实的 Agent 是否真的启动并调用桥，测试不能代替：只在假 Agent 与回放上验证。

## 界面

- **设置 › MCP**（`admin` 设备可见）：「Latch 的 MCP 服务器」，每行是终端图标、名称、「用在」与状态词（已停用、未测试、可用 · N 个工具、红色的失败，原因在悬停里）。点开是这个服务器的页：状态与读取时间，「测试」「停用 / 启用」「移除」；命令、参数与工作目录；变量只列名字与「已设置」，可以更换值或移除；工具逐个开关；「用在」。`npx`、`uvx` 等没写版本时一行琥珀色「每次启动可能下载新版本」。「添加…」与除停用以外的改动只在这台 Mac 的桌面端出现；其他设备只看、只能停用。
- **我的 Agent › 资料面板 › MCP**：这个 Agent 的会话拿到的服务器（「所有会话」的标出来）；这台 Mac 的桌面端可以用开关把已有的服务器挂上或取下，改的是服务器的「用在」，不要确认。内置 Harness 的 Agent 写「内置 Harness 尚未支持 MCP 命令」，pi 写「这个 Harness 不接收 MCP 服务器」。

## 测试替身

`packages/testkit/fixtures/fake-mcp-stdio.mjs`（`FAKE_MCP_STDIO`）：2025 握手，工具 `echo`、`slow`、`env_names`、`where`；`FAKE_MCP_MODE` 为 `crash`、`silent`、`noisy`、`ask`、`changed`；`FAKE_MCP_LOG` 只记环境变量的名字。假 ACP Agent 在 `FAKE_ACP_MCP=dsh` 下的提示 `mcp <服务器> <工具> [JSON 参数]` 调用一个工具，`mcp-list <服务器>` 列出工具。
