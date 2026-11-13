---
description: Latch 的 MCP 服务器：本机命令与远程地址的定义与秘密、本机确认与出站许可、测试、「用在」、latch-mcp 桥与工具网关、Host 作为远程 MCP 客户端、交给各 Harness、审计与限制。
sources:
  - apps/host/src/mcp.ts
  - apps/host/src/mcp-remote.ts
  - apps/host/src/mcp-import.ts
  - apps/host/src/routes/mcp.ts
  - apps/host/src/audit-actions/mcp.ts
  - apps/host/src/tool-gateway.ts
  - packages/harness-acp/src/mcp-bridge.ts
  - packages/protocol/src/mcp.ts
  - apps/web/src/settings/McpSettings.tsx
  - apps/web/src/settings/HarnessMcp.tsx
  - apps/web/src/settings/McpImport.tsx
  - packages/harness-acp/src/wires/codex.ts
  - apps/web/src/agents/McpSection.tsx
  - packages/testkit/fixtures/fake-mcp-stdio.mjs
  - packages/testkit/src/fake-mcp-http.ts
  - apps/host/test/mcp.test.ts
  - apps/host/test/mcp-remote.test.ts
  - apps/host/test/mcp-import.test.ts
  - packages/harness-acp/test/mcp-bridge.test.ts
  - e2e/mcp.e2e.ts
---

# MCP 服务器

MCP 有两半：Latch 定义的服务器，和各 Harness 自己配置的服务器。Latch 只管前一半，经 Latch 的调用有记录；Harness 自己的服务器只显示它经协议报告的（现在只有 Codex 直连，见「Harness 自己的 MCP」），它们的调用（以及完全访问的 Agent 自己启动的任何程序）Latch 一次也看不到。**这不是沙箱**：本机命令以你的身份运行，Latch 不隔离它。

两种服务器：本机命令（stdio，Agent 一侧经桥启动）与远程地址（Streamable HTTP，Host 是它唯一的客户端，见「远程地址」）。OAuth（需要登录的远程服务器显示「需要登录 · 尚未实现」）与旧的 HTTP+SSE 传输（MCP 规范已弃用）尚未实现。

## 定义与秘密

- `<数据目录>/mcp/servers.json`：定义，strict schema。每个服务器有 ID（`mcp_` 加 22 位）、名称、命令（保存时找到的绝对路径）、参数、**普通变量**（名字与值，属于确认过的定义，设备可读）、**秘密变量**的名字、「在项目文件夹里启动」、「用在」、开关、关掉的工具、修订号、`specHash`（命令、参数、普通变量、秘密变量名与工作目录方式的 SHA-256）、`confirmed`（本机确认通过时的 `specHash` 与它点名的秘密变量名，只在确认通过时写）和最近一次报告（状态、工具名、原因枚举、时间、来自测试还是会话）。还存最近 256 个请求的回执：请求 ID 与设备的哈希、请求体的哈希。
- 远程地址的定义（`transport: 'http'`）没有命令、参数与变量，只有地址 `url`（源与路径，见「远程地址」）与请求头的名字 `headerNames`；`specHash` 是地址与请求头名字的 SHA-256，`confirmed` 记下确认时的哈希与它点名的请求头名字。
- `<数据目录>/mcp/secrets.json`：秘密变量的值与远程地址请求头的值（`headers`；请求头的值一律是秘密），strict schema。值从不返回任何设备：读接口只回 `{ name, set, secret: true }`；普通变量带 `value`。秘密变量的名字不能决定加载哪些程序或文件（`BASH_ENV`、`ENV`、`PYTHONPATH`、`PYTHONHOME`、`PYTHONSTARTUP`、`PERL5OPT`、`PERL5LIB`、`RUBYOPT`、`RUBYLIB`、`NODE_OPTIONS`、`NODE_PATH`、`JAVA_TOOL_OPTIONS`、`_JAVA_OPTIONS`、`JDK_JAVA_OPTIONS`、`PERLLIB`、`SHELLOPTS`、`PS4`、`LUA_INIT`、`GOFLAGS`、`GOPROXY`、`CLASSPATH`、`RUSTFLAGS`、`PATH`、`HOME`，以及 `UV_*`、`PIP_*`、`PIPX_*`、`NPM_CONFIG_*`、`BUN_*`、`DENO_*`、`GEM_*`、`CARGO_*`、`XDG_*`、`DYLD_*`、`LD_*`、`GIT_*`，不分大小写），值也不能像路径或地址（`~/`、`./`、`../`、盘符开头，或形如路径的 `/…`：只有路径字符、且有第二个 `/` 或以 `/usr`、`/Users` 等根目录开头，所以以 `/` 开头的 base64 秘密仍可作秘密；`<scheme>://`、`file:`、`data:` 与 `host:port`）：这些只能作普通变量，出现在确认里（400 `mcp-secret-not-allowed`，说明原因）。
- 两个文件都是 0600，目录 0700，原子写入，不进时间机器备份，诊断导出不含它们。和模型密钥一样，这是「磁盘上只存哈希」的例外：完全访问的 Agent 能读它，也能读服务器进程的环境。
- 秘密变量与请求头的值（8 个字符以上；更短的不加入，不受这一层保护；`Bearer <令牌>` 这样带方案的请求头另把令牌本身加入）从此在 Host 发出的文字里按确切值遮盖，原样、JSON 转义与 URL 编码三种写法都算（`redactKnownSecrets`、`maskKnownSecrets`）：日志、错误、事件、诊断，ACP Agent 的文字与工具输出（存下与发给设备之前），终端「加入对话」、应用构建与 Git 交付的输出。判断文件或文字是否含秘密的检查（`redactSecrets`、`containsSecret`）只认形状，不受它影响。
- 命令按 Harness 命令的同一规则查找（`resolveCommand`），含 `/` 的相对路径按找不到处理。命令落在数据目录、Latch 程序目录、默认工作区或任何项目的文件夹里时拒绝（400 `mcp-command-forbidden`）。名称是字母、数字、`-`、`_`，最多 32 个，不以 `latch` 开头，不连写 `__`（内置 Harness 用它分开服务器与工具；之前保存的名字照旧可读、可改其他字段）（留给 `latch-skills`、`latch-browser`）。变量名不能是 `PATH` 或 Harness 定义保留的名字（`NODE_OPTIONS`、`LATCH_*`、`DYLD_*` 等）。

## 路由

| 路由 | 谁 | 说明 |
| --- | --- | --- |
| `GET /mcp/servers` | `view` | `{ revision, servers }`；没有值 |
| `POST /mcp/servers` | `host.sock` 的 `admin` | 本机命令 `{ requestId, baseRevision, name, command, args, env, secrets, projectCwd, scope }`；远程地址 `{ requestId, baseRevision, transport: 'http', name, url, headers, scope }`；本机确认 `mcp.server.apply` |
| `PATCH /mcp/servers/:id` | `host.sock` 的 `admin`；`{ enabled: false }` 任何 `admin` 设备 | `{ requestId, baseRevision, …改动 }`，`baseRevision` 是这个服务器的修订号；远程地址的改动是 `url` 与 `headers`（值为 `null` 即移除），给另一种服务器的字段 400 `mcp-transport`；放宽时本机确认 |
| `DELETE /mcp/servers/:id` | `host.sock` 的 `admin` | 连同它的值一起删除 |
| `POST /mcp/servers/:id/test` | `host.sock` 的 `admin` | `{ requestId }`；见「测试」 |
| `GET /mcp/import?project=<项目 ID>` | `host.sock` 的 `admin` | 项目每个文件夹的 `.mcp.json`；见「从项目导入」 |
| `POST /agents/:id/mcp` | `run` | 「读取」这个 Harness 自己的 MCP；见「Harness 自己的 MCP」 |

- 同一设备的同一 `requestId` 带同样的请求体：按回执回答，不再确认、不再执行；带不同的请求体：409 `request-conflict`。修订号不对：409 `mcp-changed`。
- **要本机确认**：新增；换命令、参数或工作目录方式；新增、修改或移除普通变量；新的秘密变量名。由 `widens` 一处判断（`spec`）。标题「添加 MCP 服务器」，系统表单的句子是「让 Agent 运行 <命令的绝对路径>（MCP 服务器「<名称>」）」。命令是 `npx`、`pnpx`、`uvx`、`pipx`、`bunx`、`node`、`python`、`python3`、`deno` 或 `ruby` 时（`mcp.server.apply-runner`）句子是「让 Agent 运行 <程序的文件名> <它运行的包或脚本>（<四位哈希>，MCP「<名称>」）」：包或脚本按各程序的选项解析（`--package`/`-p`、`--from`、`--spec`、`-m`，跳过 `--with`、`-r` 等带值的选项与 `run` 子命令），只在中间截断，后面是整串的 SHA-256 前四位，所以 `evilmodelcontextprotocol/server-github` 与 `@modelcontextprotocol/server-github` 不会看起来一样；选项说不清时（`-e`、`-c` 等内联代码、不认识的选项）显示原样的第一个参数加哈希。路径在前，人起的名字只能在它后面。卡片上的行列出命令、参数、普通变量（含值）、秘密变量名、工作目录与「用在」；秘密的值只以哈希绑定在确认上。保存时记下 `confirmed`；测试与每次启动之前都核对定义与它一致（`isConfirmed`）。
- **远程地址要本机确认**：新增；换源或路径；新的请求头名字（同样由 `widens` 判断）。表单 `mcp.server.apply-remote` 的句子是「让 Latch 连接 <host:port>（MCP 服务器「<名称>」）」，地址在前、保留结尾的域名。卡片上的行列出地址、请求头的名字（「值只发往这个地址」）、出站许可（需要时）与「用在」；请求头的值只以哈希绑定在确认上。换请求头的值、移除请求头不要确认（`use`）。
- **不要确认，但先审计、写不进就不生效**（`widens` 的 `use`）：秘密变量换值、「用在」多了 Agent、项目或所有会话、关掉的工具重新打开、启用。移除秘密变量也算这一类。**只收窄**（审计失败照常执行，响应带 `x-latch-audit: failed`）：改名、「用在」变少、关工具、停用、移除服务器。代码与去向确认过一次，挂到更多会话是使用，不是新边界。
- 有完全访问会话在运行或等你处理时，放宽与其他本机确认一样返回 409 `presence-blocked`；停用、移除从不被挡。
- 审计（detail 只有 ID、哈希、枚举、布尔与计数，没有名称、命令、值）：`mcp.server.added`（先于保存，写不进就不保存；从项目导入的带来源项目的 ID `importedFrom`）、`mcp.server.changed`（`kinds`：`spec`、`secret`、`scope`、`tools`、`enabled`、`name`；只收窄的改动在审计失败时照常执行，响应带 `x-latch-audit: failed`）、`mcp.server.removed`、`mcp.server.test`。

## 测试

只在这台 Mac 上由人按下，只对与确认一致的定义（`isConfirmed`）。命令本身，或参数与普通变量值里的任何路径（绝对路径、`~/`、`file:` URL、`--选项=路径` 的值、相对路径按测试自己的空文件夹解析，`NODE_OPTIONS` 里 `--require`/`-r`/`--import`/`--loader` 的模块；含 `${workspaceFolder}` 的参数也算），按路径段比较、连同 `realpath`，落在任何项目的文件夹、工作树目录、Agent 目录、数据目录、Latch 的程序目录或任何会话的文件夹里时拒绝（409 `mcp-test-repository`，说明原因）：测试是 Host 自己运行程序，Host 不运行仓库里的程序。Agent 一侧经桥启动的服务器不受这条限制。Host 在自己临时目录里新建一个空文件夹，以下面「环境」的清单启动命令（自己的进程组，stderr 丢弃），发 `initialize`（不声明任何客户端能力）与 `tools/list`，最多 20 秒、最多读 1 MiB 输出，然后结束整个进程组、删除文件夹。服务器自己的请求一律回答 method not found。结果（工具名，或原因：`spawn-failed`、`exited`、`timeout`、`protocol`、`list-failed`、`output-too-large`）记为这个服务器的报告。

远程地址的测试不运行任何程序：Host 以客户端连接绑定的地址，`initialize` 与 `tools/list`，最多 20 秒，然后结束会话（`DELETE`）。结果同样记为报告，原因是「远程地址」所列的枚举。

## 远程地址

- **地址**：只收 `https://`；`http://` 只收这台 Mac 的回环地址，且要写成字面的 `localhost`、`127.x.x.x` 或 `[::1]`（解析结果可能变的名字不算）。不带账号、查询或片段（400 `mcp-url-invalid`）；保存的是源与路径。请求头的名字是 HTTP 的 token，客户端自己的（`Accept`、`Content-Type`、`Mcp-Session-Id`、`MCP-Protocol-Version`、`Host`、`Cookie`、`Connection` 等与 `Sec-*`）不能填，名字不分大小写不能重复，最多 32 个。
- **确认与出站许可合在一次**：保存前 Host 按出站策略判断这个地址（与模型服务地址同一个 `inspectEgress`）。云元数据等永远不许的地址 403 `egress-denied`；回环、私网等要许可、而 `hostEgressAllow`（及启动时的出站许可）还没有它时，许可作为「出站许可」一行放进同一次 `mcp.server.apply`，确认通过后以同一个 stepup 写进策略（审计 `policy.changed`），保存失败时撤回。地址已经许可过（例如同一个源的模型服务、另一个远程 MCP 服务器）时不再出现这一行，所以同一个地址不会问两次；但新的远程服务器本身总要确认，因为它绑定的是要带去的请求头。移除服务器时可以一并收回只有它在用的许可（见下「移除」）。
- **Host 是客户端**（`mcp-remote.ts`，自己写，不引入依赖）：Streamable HTTP（MCP 2025-06-18；服务器回答 2025-03-26、2025-06-18 或 2025-11-25 之外的版本按协议错误处理）。每条消息 POST 到确认时绑定的地址（只此一处，`DELETE` 结束会话也是），`Accept: application/json, text/event-stream`，`initialize` 之后带服务器给的 `Mcp-Session-Id`（只收可见 ASCII、最多 256 个字符）与协商出的 `MCP-Protocol-Version`。请求只经 Host 注入的出站 `fetch`（出站策略按连接时解析出的地址检查），`redirect: 'manual'`：任何 3xx 都按「Latch 没有连接这个地址」拒绝，请求头不会跟着去别处。回答是 JSON 或事件流（SSE 分帧沿用模型服务的 `sseData`），整个回答最多 2 MiB，一次请求最多 60 秒（测试与内置 Harness 列工具时 20 秒）；服务器忘了会话（404）时重新 `initialize` 一次再试；服务器自己的请求（sampling、elicitation、roots）一律拒绝：每个回答里最多回复 16 个 method not found，再多的不回复；通知的回答（202）不读、立即放掉。这台 Host 对同一个源同时最多 8 个请求，其余排队；调用被停止时另发 `notifications/cancelled`。客户端不声明任何能力。
- **失败的原因只是枚举**：`auth-required`（401，OAuth 尚未实现，界面写「需要登录 · 尚未实现」，琥珀）、`unreachable`（连不上或 HTTP 错误）、`refused`（出站策略不许或重定向）、`timeout`、`protocol`、`output-too-large`、`list-failed`。错误文字是 Host 自己的固定句子，从不带服务器的原文、请求头或它的值。
- **回答在离开 Host 之前遮盖**：工具列表与结果里的每个字符串与对象的键都经 `redactKnownSecrets`，包括服务器说回来的请求头值；名字里含已保存秘密的工具不记进报告、不交给内置 Harness。
- **只用一份定义**：Host 每次打开会话时重新读定义，要求它与调用方核对过的 `specHash` 一致，地址与请求头取自同一份；在途调用的审计还没写完时改了地址，新的请求头也不会发往旧地址。桥只在启动清单成功（`mcp.server.started` 已写下）并说明是远程地址之后才转发。
- **移除**：远程服务器的出站许可没有别的远程服务器、模型服务或启动时的许可在用时，列表给出 `allowance`，移除对话框给出「同时移除出站许可」（`DELETE …?allowance=remove`）；收窄不要确认，记为 `policy.changed`。
- **会话**：每个桥（外部 Harness）或每个内置会话与服务器的组合各一个 Host 会话；桥结束、令牌失效、服务器停用、移除、改动或「用在」不再包括这个会话时，Host 结束会话并中止在途的调用。

## 用在哪些会话

「用在」是所有会话，或选中的 Agent（我的 Agent，含它们的定时运行）与项目（会话的 `workspaceId`），后两者取并集。一个会话拿到哪些服务器，在每次启动 Agent 进程时按当时的定义算出（新会话、恢复、载入、分叉），这组服务器与它们的 `specHash` 的哈希在给出它们的同一刻算出，记进 `task.l3.started` 的 `mcpSetHash`。停用、移除、改了定义或「用在」不再包括这个会话的服务器：正在运行的桥立即结束，下一次也不再给。桥启动服务器与每次调用时 Host 再核对一次：服务器仍在、开着、定义与确认一致、这个会话仍在「用在」里、工具没被关掉，否则拒绝。

## latch-mcp 桥

- 每个服务器在 `mcpServers` 里是一个桥（本机命令与远程地址一样）：命令是 Host 自己的 Node，参数是 `--disable-sigusr1 -e <固定源码> <网关套接字> <令牌文件>`，`env` 为空，名字是服务器的名称。参数里没有令牌、没有秘密。
- 令牌：工具网关（[ARCHITECTURE.md](ARCHITECTURE.md#harness-与会话路由) 的「工具网关」）为每个桥发一个 `lbt1.` 令牌，写进网关目录里新建的 0600 文件；Host 只存哈希。桥在 `initialize` 时才读出并删除它，所以只问 `server/discover`（2026 版握手）的一次性副本拿不到令牌：桥回答 method not found，Agent 回到 `initialize`。令牌随 Agent 进程结束、会话归档或删除、服务器被移除、停用或改动而失效。
- 启动：桥经网关取 `mcp/launch`：命令、参数（`${workspaceFolder}` 换成会话的主文件夹）、环境与工作目录。Host 先写 `mcp.server.started`（服务器 ID、会话 ID、`specHash`），写不进就不启动。这是秘密离开 Host 的唯一地方：它们只写进服务器进程的环境。服务器在自己的进程组里。
- **远程模式**：远程地址的启动清单只说 `remote: true`（审计照样先写 `mcp.server.started`）。桥不启动任何程序、不连外网：`initialize`、`tools/list`、`tools/call` 经网关的 `mcp/remote` 交给 Host，Agent 的取消经 `mcp/cancel` 中止 Host 那边的请求，`ping` 由桥自己回答。桥与 Agent 之间的会话按 Agent 要的协议版本回答，与 Host 和服务器之间的会话互不相干。`tools/call` 由 Host 先核对（与本机命令的调用一样）、先写 `mcp.tool.called`，写不进就不发，结束补 `mcp.tool.settled`；参数与结果经过网关，但请求头从不离开 Host。服务器连不上时桥照样回答 `initialize`、工具列表为空，会话里写一行「MCP 服务器「名称」没有启动：原因」。
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
| 内置 Harness | 只有远程地址：Host 在每次运行开始时（`mcpTools`）列出这个会话「用在」的、与确认一致的远程服务器的工具，每次运行先写 `mcp.server.started`，写不进就不打开这个服务器；每个工具注册为 `mcp__<服务器名称>__<工具>_<8 位哈希>`（哈希取服务器 ID 与工具原名，总在；不合模型协议的字符换成 `_`，最多 64 个字符，所以两个服务器或工具不会得到同一个名字），说明写明来自哪个服务器。调用一律 R2（`riskReason: 'mcp-tool'`）：每次询问，没有「始终允许」，服务器自报的 `readOnlyHint` 不改变它；因为是 R2，调用过的会话之后的记忆提议都标「来自外部内容」。执行前再核对服务器仍在、开着、与确认一致、仍「用在」这个会话、工具没关，先写 `mcp.tool.called`。设了「可以使用」的 Agent 只拿到名单里写作 `mcp:<服务器 ID>` 的服务器；名单现在还选不了这一项，所以这样的 Agent 在内置 Harness 上没有 MCP 工具。本机命令尚未实现：要由 Host 自己运行这个命令，而内置 Harness 是 L1 |

`HarnessInfo.skills === 'server'` 的 Harness 接收 Latch 的服务器；页面据此说明。真实的 Agent 是否真的启动并调用桥，测试不能代替：只在假 Agent 与回放上验证。

## Harness 自己的 MCP

- 只显示 Harness 经协议报告的，从不读写任何 CLI 的配置（`~/.codex/config.toml`、`~/.claude.json`、`~/.cursor/mcp.json` 等），也不代它登录：现在只有 Codex 直连报告（app-server 的 `mcpServerStatus/list` 与 `mcpServer/startupStatus/updated`，0.156.0 与 0.167.0 都有；wire 的做法见 [HARNESSES.md](HARNESSES.md#codex-的-app-server)）。`HarnessInfo.ownMcp` 只在报告的 Harness 上有：`last`（服务器、时间、来自会话还是读取）、`running`、`failed`；只在 Host 内存里，定义变了就作废。
- 设置 › MCP 与这个 Harness 的页（设置 › Harness）都列出它们，只读。每个服务器是名字、状态（可用、正在启动、需要登录、失败、已取消、已停用、未启动、状态未知）、工具数与远程服务器的源。Codex 报告需要登录时给出它自己的 `codex mcp login <名字>`（名字只有字母、数字、`-`、`_`、不以 `-` 开头时；否则不给），Latch 不调用它的 OAuth。
- 会话里的状态随 Codex 的启动通知更新，不启动任何东西；「读取」在空的私有文件夹里启动一次 `codex app-server`（整个读取连同进程启动与翻页共 60 秒），不开 thread，Codex 这时会启动它配置的服务器，所以只由人按下，ⓘ 写明。线程配置里 Latch 自己的服务器不算 Codex 的。与 Latch 的服务器同名的写「会话里用 Latch 的同名服务器」：线程配置覆盖 Codex 自己的。
- 其他 Harness（经 ACP 的各预设、codex-acp、pi）在设置 › MCP 与它的 Harness 页写「这个 Harness 不报告自己的 MCP」。

## 从项目导入

- 只在添加的地方（这台 Mac 的桌面端，`host.sock`）：「添加 MCP 服务器」表单下的「从项目导入…」选一个项目，Host 读它每个文件夹里的 `.mcp.json`（`mcp-import.ts`），只读这一个文件：`.cursor/mcp.json`、`.codex/config.toml` 是各家工具自己的配置，不读。什么都不运行，不经 Agent，也不随会话交给 Agent。
- 读法：不跟随链接（`O_NOFOLLOW`，链接可能指向你的任何文件），必须是只有一个名字的普通文件（硬链接同样可能是你的任何文件），最多 64 KiB，从检查过的同一个描述符读；否则整份拒绝（`not-file`、`too-large`）。JSON 必须恰好是 `{ "mcpServers": { … } }`（`not-json`、`invalid`）；每个服务器按 strict schema 单独判断：本机命令 `{ type?: "stdio", command, args?, env? }`，远程地址 `{ type?: "http" | "streamable-http", url, headers? }`，未知字段、`__proto__` 之类的键、`escapeSecurityText` 要写出来的字符（控制字符、C1、改变方向的字符、行与段落分隔符、不可见字符）都按「格式不对」跳过，`type: "sse"` 写「旧的 HTTP+SSE 传输尚未实现」，最多列出 32 个。
- `${…}` 一律按原样显示，从不用 Host 的环境展开，标「含 ${…}」；`${workspaceFolder}` 是 Latch 自己的参数写法，不算。
- 秘密的值不导入：请求头只给名字；变量值是 `${…}`、名字像凭据（`KEY`、`TOKEN`、`SECRET`、`PASS`、`AUTH` 等）、形如已知的密钥或一长串字母数字的，只给名字，作空的秘密字段等人填；其余作普通变量带值（它们会出现在确认里）。参数里像秘密的值（整个参数、`--x=值` 的值、`--token` 这类参数之后的那个）与地址里的账号、像秘密的查询都留空，标「像秘密的值已留空」，由人作为秘密变量填写。
- 命令或参数落在项目里时按「测试」的同一规则标出（相对路径从那个文件夹算起，按路径段与各根目录及其 `realpath` 比较）；只有文字上已在某个根目录下的路径才去查文件系统，`/net/…` 这类自动挂载或别处的路径从不触碰：命令在项目、工作树、会话文件夹或 Latch 自己的目录里写「命令在项目里：不能添加」（保存本来就拒绝，`mcp-command-forbidden`）；参数或普通变量指向那里、且那里真有这个文件时（`@scope/server` 这样的包名有分隔符，但不是路径）写「参数指向项目里的文件：测试会拒绝」。
- 选一个后预填表单（名称在合规且没人用时才填），然后是正常的添加：本机确认 `mcp.server.apply`，审计 `mcp.server.added` 带 `importedFrom`（项目 ID）。导入后是 Latch 自己的一份，仓库以后怎么改都不影响它。
- 添加表单的命令与参数里有控制字符、改变方向的字符、行或段落分隔符或不可见字符时拒绝保存（「含不可见或改变方向的字符」），与导入的规则相同。

## 界面

- **设置 › MCP**（`admin` 设备可见）：下半是各外部 Harness 自己的 MCP（见「Harness 自己的 MCP」）：Codex 直连一组「<名称> 自己的 MCP」带「读取」，其他 Harness 一行灰字。上半「Latch 的 MCP 服务器」，每行是传输图标（本机命令是终端，远程地址是地球）、名称、「用在」与状态词（已停用、未测试、可用 · N 个工具、琥珀的「需要登录 · 尚未实现」、红色的失败，原因在悬停里）。「添加…」先分段选「命令 | 远程地址」；远程地址的页列出 URL（「编辑…」）与请求头的名字和「已设置」（更换值、移除、添加），值从不显示。点开是这个服务器的页：状态与读取时间，「测试」「停用 / 启用」「移除」；命令、参数与工作目录；变量只列名字与「已设置」，可以更换值或移除；工具逐个开关；「用在」。`npx`、`uvx` 等没写版本时一行琥珀色「每次启动可能下载新版本」。「添加…」与除停用以外的改动只在这台 Mac 的桌面端出现；其他设备只看、只能停用。
- **我的 Agent › 资料面板 › MCP**：这个 Agent 的会话拿到的服务器（「所有会话」的标出来）；这台 Mac 的桌面端可以用开关把已有的服务器挂上或取下，改的是服务器的「用在」，不要确认。内置 Harness 的 Agent 写「内置 Harness 尚未支持 MCP 命令」，pi 写「这个 Harness 不接收 MCP 服务器」。

## 测试替身

`packages/testkit/src/fake-mcp-http.ts`（`startFakeMcpHttp`）：进程内只听 127.0.0.1 的 Streamable HTTP 服务器，会话 ID、JSON 或事件流回答，工具 `echo`（可把指名的请求头说回来，用于检查遮盖）、`slow`、`big`；可以要求登录（带 `resource_metadata` 的 401）、重定向、忘掉会话、在回答前发自己的请求；记下每个请求的请求头名字，值只记测试点名的。

`packages/testkit/fixtures/fake-mcp-stdio.mjs`（`FAKE_MCP_STDIO`）：2025 握手，工具 `echo`、`slow`、`env_names`、`where`；`FAKE_MCP_MODE` 为 `crash`、`silent`、`noisy`、`ask`、`changed`；`FAKE_MCP_LOG` 只记环境变量的名字。假 ACP Agent 在 `FAKE_ACP_MCP=dsh` 下的提示 `mcp <服务器> <工具> [JSON 参数]` 调用一个工具，`mcp-list <服务器>` 列出工具。
