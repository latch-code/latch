---
description: Latch 的 MCP 服务器：本机命令与远程地址的定义与秘密、本机确认与出站许可、测试、「用在」、latch-mcp 桥与工具网关、Host 作为远程 MCP 客户端、远程服务器的登录（OAuth）、交给各 Harness、「操控这台 Mac」（Cua Driver）、「Xcode」（xcrun mcpbridge，见 DEVICE-PREVIEW.md）、审计与限制。
sources:
  - apps/host/src/mcp.ts
  - apps/host/src/mcp-remote.ts
  - apps/host/src/mcp-oauth.ts
  - apps/host/src/mcp-import.ts
  - apps/host/src/mcp-computer.ts
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
  - packages/testkit/src/fake-oauth.ts
  - packages/testkit/src/fake-cua-driver.ts
  - apps/host/test/mcp.test.ts
  - apps/host/test/mcp-remote.test.ts
  - apps/host/test/mcp-oauth.test.ts
  - apps/host/test/mcp-prompts.test.ts
  - apps/host/test/mcp-import.test.ts
  - apps/host/test/mcp-computer.test.ts
  - packages/harness-acp/test/mcp-bridge.test.ts
  - e2e/mcp.e2e.ts
  - e2e/mcp-oauth.e2e.ts
---

# MCP 服务器

MCP 有两半：Latch 定义的服务器，和各 Harness 自己配置的服务器。

- Latch 只管前一半：经 Latch 的调用有记录。
- Harness 自己的服务器只显示它经协议报告的（见 [Harness 自己的 MCP](#harness-自己的-mcp)）。它们的调用，以及完全访问的 Agent 自己启动的任何程序，Latch 一次也看不到。
- **这不是沙箱**：本机命令以你的身份运行，Latch 不隔离它。

Latch 的服务器有两种：

| 种类 | 传输 | 谁连接它 |
| --- | --- | --- |
| 本机命令 | stdio | Agent 一侧的桥启动它 |
| 远程地址 | Streamable HTTP | Host 是它唯一的客户端；要登录的在这台 Mac 上登录（OAuth） |

尚未实现：旧的 HTTP+SSE 传输（MCP 规范已弃用）；Client ID Metadata Document（要 Latch 在 HTTPS 上托管一份文档，Latch 没有这样的服务）；resources；内置 Harness 使用本机命令。

## 定义与秘密

两个文件都在 `<数据目录>/mcp/`，0600，目录 0700，原子写入，strict schema，不进时间机器备份，诊断导出不含它们。

**`servers.json`：定义。**

- 本机命令：ID（`mcp_` 加 22 位）、名称、命令（保存时找到的绝对路径）、参数、普通变量（名字与值，属于确认过的定义，设备可读）、秘密变量的名字、「在项目文件夹里启动」、「用在」、开关、关掉的工具、修订号；[操控这台 Mac](#操控这台-mac) 与 [Xcode](DEVICE-PREVIEW.md#xcode预设设置--mcp) 另有 `preset` 与 `knownTools`。
- 远程地址（`transport: 'http'`）：没有命令、参数与变量，只有地址 `url`（源与路径）与请求头的名字 `headerNames`；登录后另有 `oauth`（`issuer`、`scopes`、`resource`）。
- `specHash`：本机命令是命令、参数、普通变量、秘密变量名与工作目录方式的 SHA-256；远程地址是地址、请求头名字与 `oauth` 的 SHA-256。
- `confirmed`：本机确认通过时的 `specHash` 与它点名的秘密变量名或请求头名字，只在确认通过时写。测试与每次启动之前都核对定义与它一致（`isConfirmed`）。
- 最近一次报告：状态、工具名、原因枚举、时间、来自测试还是会话。
- 最近 256 个请求的回执：请求 ID 与设备的哈希、请求体的哈希。

**`secrets.json`：值。** 秘密变量的值、请求头的值（`headers`，一律是秘密）、登录的令牌与客户端密钥（`oauth`：`accessToken`、`refreshToken`、`clientSecret`）。

- 值从不返回任何设备：读接口只回 `{ name, set, secret: true }`；普通变量带 `value`。
- 和模型密钥一样，这是「磁盘上只存哈希」的例外：完全访问的 Agent 能读它，也能读服务器进程的环境。

**什么不能作秘密变量**（400 `mcp-secret-not-allowed`，说明原因；它们只能作普通变量，出现在确认里）：

- 名字会决定加载哪些程序或文件的变量：`SECRET_RESERVED` 与 `SECRET_RESERVED_PREFIXES`（`mcp.ts`；`PATH`、`HOME`、`NODE_OPTIONS`、`PYTHONPATH`、`DYLD_*`、`GIT_*` 等，不分大小写）。
- 值像路径或地址的：`~/`、`./`、`../`、盘符开头；`<scheme>://`、`file:`、`data:`、`host:port`；形如路径的 `/…`（只有路径字符，且有第二个 `/` 或以 `/usr`、`/Users` 等根目录开头，所以以 `/` 开头的 base64 秘密仍可作秘密）。

**遮盖。** 秘密变量、请求头的值、登录的令牌与客户端密钥从此在 Host 发出的文字里按确切值遮盖（`redactKnownSecrets`、`maskKnownSecrets`）。

- 原样、JSON 转义与 URL 编码三种写法都算。`Bearer <令牌>` 这样带方案的请求头另把令牌本身加入。
- 只对 8 个字符以上的值；更短的不受这一层保护。
- 覆盖日志、错误、事件、诊断，ACP Agent 的文字与工具输出（存下与发给设备之前），终端「加入对话」、应用构建与 Git 交付的输出。
- 判断文字是否含秘密的检查（`redactSecrets`、`containsSecret`）只认形状，不受它影响。

**命令与名字。**

- 命令按 Harness 命令的同一规则查找（`resolveCommand`），含 `/` 的相对路径按找不到处理。
- 命令落在数据目录、Latch 程序目录、默认工作区或任何项目的文件夹里时拒绝（400 `mcp-command-forbidden`）。
- 名称是字母、数字、`-`、`_`，最多 32 个，不以 `latch` 开头（留给 `latch-skills`、`latch-browser`），不连写 `__`（内置 Harness 用它分开服务器与工具）。已保存的不合规名字仍可读、可改其他字段。
- 变量名不能是 `PATH` 或 Harness 定义保留的名字（`NODE_OPTIONS`、`LATCH_*`、`DYLD_*` 等）。
- 添加表单在命令与参数里有控制字符、改变方向的字符、行或段落分隔符或不可见字符时不让保存（`McpSettings.tsx`，与导入的规则相同）；Host 的 schema 只拒绝 NUL。

## 路由

都在 `/link/api` 下。

| 路由 | 谁 | 说明 |
| --- | --- | --- |
| `GET /mcp/servers` | `view` | `{ revision, servers }`；没有值 |
| `POST /mcp/servers` | `host.sock` 的 `admin` | 本机命令 `{ requestId, baseRevision, name, command, args, env, secrets, projectCwd, scope }`；远程地址 `{ requestId, baseRevision, transport: 'http', name, url, headers, scope }` |
| `PATCH /mcp/servers/:id` | `host.sock` 的 `admin`；`{ enabled: false }` 任何 `admin` 设备 | `{ requestId, baseRevision, …改动 }`，`baseRevision` 是这个服务器的修订号；远程地址的改动是 `url` 与 `headers`（值为 `null` 即移除）；给另一种服务器的字段 400 `mcp-transport` |
| `DELETE /mcp/servers/:id` | `host.sock` 的 `admin` | 连同它的值一起删除；`?allowance=remove` 见[远程地址](#远程地址) |
| `POST /mcp/servers/:id/test` | `host.sock` 的 `admin` | `{ requestId }`；见[测试](#测试) |
| `POST /mcp/servers/:id/oauth/login` | `host.sock` 的 `admin` | `{ requestId, clientId?, clientSecret? }`；回答 `{ authorizationUrl, until, server }` |
| `POST /mcp/servers/:id/oauth/logout` | `host.sock` 的 `admin` | `{ requestId }`；回答 `{ oauth, server }` |
| `GET /mcp/import?project=<项目 ID>` | `host.sock` 的 `admin` | 见[从项目导入](#从项目导入) |
| `GET /mcp/computer` | `host.sock` 的 `admin` | 见[操控这台 Mac](#操控这台-mac)；Host 没有指定位置时 404 |
| `GET /mcp/xcode` | `host.sock` 的 `admin` | 见 [DEVICE-PREVIEW.md](DEVICE-PREVIEW.md#xcode预设设置--mcp)；Host 不找 Xcode 时 404 |
| `POST /agents/:id/mcp` | `run` | 「读取」这个 Harness 自己的 MCP |

- 同一设备的同一 `requestId` 带同样的请求体：按回执回答，不再确认、不再执行；带不同的请求体：409 `request-conflict`。修订号不对：409 `mcp-changed`。
- 有完全访问会话在运行或等你处理时，要本机确认的改动返回 409 `presence-blocked`；停用、移除从不被挡。

### 哪些改动要确认

由 `widens` 一处判断。代码与去向确认过一次；挂到更多会话是使用，不是新边界。

| 类别 | 改动 | 处理 |
| --- | --- | --- |
| `spec`（本机命令） | 新增；换命令、参数或工作目录方式；新增、修改或移除普通变量；新的秘密变量名 | 本机确认 `mcp.server.apply` |
| `spec`（远程地址） | 新增；换源或路径；新的请求头名字；新的授权服务器、更宽的范围或 `resource` 变了（见[登录](#登录)） | 本机确认 `mcp.server.apply` |
| `use` | 秘密变量或请求头换值、移除；「用在」多了 Agent、项目或所有会话；关掉的工具重新打开；启用 | 不确认；先审计，写不进就不生效 |
| 只收窄 | 改名、「用在」变少、关工具、停用、移除服务器 | 不确认；审计失败照常执行，响应带 `x-latch-audit: failed` |

### 确认卡片写什么

系统表单只有一句话，路径或地址在前，人起的名字只能在它后面。

| 表单 | 句子 |
| --- | --- |
| `mcp.server.apply`（本机命令） | 「让 Agent 运行 <命令的绝对路径>（MCP 服务器「<名称>」）」 |
| `mcp.server.apply-runner`（命令是 `mcp.ts` 的 `RUNNERS` 之一：`npx`、`uvx`、`node`、`python` 等） | 「让 Agent 运行 <程序的文件名> <它运行的包或脚本>（<四位哈希>，MCP「<名称>」）」 |
| `mcp.server.apply-remote` | 「让 Latch 连接 <host:port>（MCP 服务器「<名称>」）」，保留结尾的域名 |

- **包或脚本**按各程序的选项解析（`--package`/`-p`、`--from`、`--spec`、`-m`，跳过带值的选项与 `run` 子命令），只在中间截断，后面是整串的 SHA-256 前四位：两个只有前缀不同的包名不会看起来一样。选项说不清时（`-e`、`-c` 等内联代码、不认识的选项）显示原样的第一个参数加哈希。
- **本机命令的行**：命令、参数、普通变量（含值）、秘密变量名、工作目录与「用在」。
- **远程地址的行**：地址、请求头的名字（「值只发往这个地址」）、出站许可（需要时）与「用在」。
- 秘密与请求头的值只以哈希绑定在确认上。

### 审计

detail 只有 ID、哈希、枚举、布尔与计数，没有名称、命令、地址或值。

| 动作 | 何时 |
| --- | --- |
| `mcp.server.added` | 先于保存，写不进就不保存；从项目导入的带 `importedFrom`（项目 ID） |
| `mcp.server.changed` | `kinds`：`spec`、`secret`、`scope`、`tools`、`enabled`、`name` |
| `mcp.server.removed`、`mcp.server.test` | 移除、测试 |
| `mcp.server.started` | 桥或内置 Harness 的一次运行打开服务器之前；写不进就不启动 |
| `mcp.tool.called`、`mcp.tool.settled` | 每次工具调用之前（写不进就不转发）与结束 |
| `mcp.prompt.got` | 取提示之前 |
| `mcp.oauth.*` | 见[登录](#登录) |

## 测试

只在这台 Mac 上由人按下，只对与确认一致的定义。结果记为这个服务器的报告。

**本机命令。** 测试是 Host 自己运行程序，而 Host 不运行仓库里的程序：

- 命令本身，或参数与普通变量值里的任何路径，落在任何项目的文件夹、工作树目录、Agent 目录、数据目录、Latch 的程序目录或任何会话的文件夹里时拒绝（409 `mcp-test-repository`，说明原因）。
- 「路径」包括：绝对路径、`~/`、`file:` URL、`--选项=路径` 的值、相对路径（按测试自己的空文件夹解析）、`NODE_OPTIONS` 里 `--require`/`-r`/`--import`/`--loader` 的模块、含 `${workspaceFolder}` 的参数。按路径段比较，连同 `realpath`。
- Agent 一侧经桥启动的服务器不受这条限制。

通过后，Host 在自己的临时目录里新建一个空文件夹，以[桥的环境清单](#latch-mcp-桥)启动命令（自己的进程组，stderr 丢弃），发 `initialize`（不声明任何客户端能力）与 `tools/list`。最多 20 秒、最多读 1 MiB 输出，然后结束整个进程组、删除文件夹。服务器自己的请求一律回答 method not found。

失败的原因：`spawn-failed`、`exited`、`timeout`、`protocol`、`list-failed`、`output-too-large`。

**远程地址。** 不运行任何程序：Host 以客户端连接绑定的地址，`initialize` 与 `tools/list`，最多 20 秒，然后结束会话（`DELETE`）。原因是[远程地址](#远程地址)所列的枚举。

## 远程地址

**地址与请求头**

- 只收 `https://`。`http://` 只收这台 Mac 的回环地址，且要写成字面的 `localhost`、`127.x.x.x` 或 `[::1]`：解析结果可能变的名字不算。
- 不带账号、查询或片段（400 `mcp-url-invalid`）；保存的是源与路径。
- 请求头的名字是 HTTP 的 token，不分大小写不能重复，最多 32 个。客户端自己的头（`packages/protocol/src/mcp.ts` 的 `RESERVED_HEADERS`：`Accept`、`Content-Type`、`Mcp-Session-Id`、`Host`、`Cookie` 等，与 `Sec-*`）不能填。

**确认与出站许可合在一次**

- 保存前 Host 按出站策略判断这个地址（与模型服务地址同一个 `inspectEgress`）。云元数据等永远不许的地址 403 `egress-denied`。
- 回环、私网等要许可、而 `hostEgressAllow`（及启动时的出站许可）还没有它时，许可作为「出站许可」一行放进同一次 `mcp.server.apply`；确认通过后以同一个 stepup 写进策略（审计 `policy.changed`），保存失败时撤回。
- 地址已经许可过时不再出现这一行。新的远程服务器本身总要确认：它绑定的是要带去的请求头。
- **移除时收回。** 远程服务器的出站许可没有别的远程服务器、模型服务或启动时的许可在用时，列表给出 `allowance`，移除时可以带 `?allowance=remove`。收窄不要确认，记为 `policy.changed`。

**Host 是客户端**（`mcp-remote.ts`，不引入依赖）

- Streamable HTTP，MCP 2025-06-18；服务器回答 2025-03-26、2025-06-18 或 2025-11-25 之外的版本按协议错误处理。客户端不声明任何能力。
- 每条消息 POST 到确认时绑定的地址，只此一处（`DELETE` 结束会话也是）。`initialize` 之后带服务器给的 `Mcp-Session-Id`（只收可见 ASCII、最多 256 个字符）与协商出的 `MCP-Protocol-Version`。
- 请求只经 Host 注入的出站 `fetch`：出站策略按连接时解析出的地址检查。`redirect: 'manual'`，任何 3xx 都按拒绝处理，请求头不会跟着去别处。
- 回答是 JSON 或事件流，整个回答最多 2 MiB。一次请求最多 60 秒（测试与内置 Harness 列工具时 20 秒）。
- 服务器忘了会话（404）时重新 `initialize` 一次再试。通知的回答（202）不读、立即放掉。
- 服务器自己的请求（sampling、elicitation、roots）一律拒绝：每个回答里最多回复 16 个 method not found，再多的不回复。
- 这台 Host 对同一个源同时最多 8 个请求，其余排队。调用被停止时另发 `notifications/cancelled`。

**失败的原因只是枚举。** 错误文字是 Host 自己的固定句子，从不带服务器的原文、请求头或它的值。

| 原因 | 含义 |
| --- | --- |
| `auth-required` | 401：没有登录，或登录不再有效 |
| `unreachable` | 连不上或 HTTP 错误 |
| `refused` | 出站策略不许，或重定向 |
| `timeout`、`protocol`、`output-too-large`、`list-failed` | 超时、协议错误、回答过大、列工具失败 |

**回答与会话**

- **离开 Host 之前遮盖。** 工具列表与结果里的每个字符串与对象的键都经 `redactKnownSecrets`，包括服务器说回来的请求头值。名字里含已保存秘密的工具不记进报告、不交给内置 Harness。
- **只用一份定义。** Host 每次打开会话时重新读定义，要求它与调用方核对过的 `specHash` 一致，地址与请求头取自同一份：在途调用的审计还没写完时改了地址，新的请求头也不会发往旧地址。
- 每个桥（外部 Harness）或每个内置会话与服务器的组合各一个 Host 会话。桥结束、令牌失效、服务器停用、移除、改动或「用在」不再包括这个会话时，Host 结束会话并中止在途的调用。

## 登录

远程服务器回答 401 时要登录：OAuth 2.1，MCP 授权规范 2025-11-25，加 RFC 9207 的 `iss` 核对。Host 是 OAuth 客户端（`mcp-oauth.ts`，不引入依赖）；Agent、桥与其他设备从不接触令牌。

失败的类别是 `McpOAuthFailure` 的枚举（下文括号里的词），错误码是 `mcp-oauth-<类别>`；`replay` 只是审计里的原因，不是登录的状态。

### 谁能发起

- `oauth/login` 与 `oauth/logout` 只收 `host.sock` 上的 `admin`，其他入口 403 `local-only`。
- 其他设备只看到状态（`McpHttpServerView.oauth`）：未登录、登录中、已登录（到期时间）、需要重新登录、登录失败与原因的类别。
- 读接口从不回令牌、Client ID、state 或登录地址。

### 发现

只问绑定的源。到这一步结束，授权服务器只是被点了名，什么都没有发给它。

1. Host 向服务器的地址发一次 `initialize`（带它的请求头，不带令牌），听 401 的 `WWW-Authenticate`。
2. 读资源元数据（RFC 9728）：挑战里的 `resource_metadata`；没有时是 `/.well-known/oauth-protected-resource<路径>` 与 `/.well-known/oauth-protected-resource`。
3. 元数据必须在服务器自己的源上。它的 `resource` 必须正是服务器的地址，或正是这个地址的源；源上别的目录会让令牌对确认之外的东西也有效，拒绝（`resource`）。
4. 授权服务器取 `authorization_servers` 的第一个，只收 `https://` 或字面的本机回环（否则 `endpoint`）。
5. 范围取挑战里的 `scope`，没有时取 `scopes_supported`。一次登录最多 64 个，更多的在确认之前就拒绝。

### 确认

授权服务器、范围与 `resource` 都在 `specHash` 与 `confirmed` 里。

- **要确认**：第一次登录、换了授权服务器、多了范围、`resource` 变了。远程服务器按新的出站地址对待，更宽的范围算放宽。
- **不确认**：同一个授权服务器、范围不超出已确认的再次登录。信任在连接时建立一次。
- 表单 `mcp.server.apply-remote` 的句子是「让 Latch 连接 <授权服务器的 host:port>（MCP 服务器「<名称>」）」。
- 卡片的行：授权服务器的 issuer 全文（同一个源上的两个租户读起来不同，经安全文字写出）；`resource` 不是服务器地址时的「资源」一行；范围（「N 个：」加每一个，从不截断）；服务器的地址；授权服务器在回环或私网时的出站许可（同一次确认，同一个 stepup）。
- 系统表单只有那一句话，所以页面上的确认卡片对登录总是列出这些行（`detailsLeftOut`）：人在按下之前看得到每一个范围。
- 确认通过后先写 `mcp.server.changed`（`spec`），再把 `oauth` 记进定义与 `confirmed`。`specHash` 因此变化，旧定义下的会话结束。

### 授权服务器的元数据

从确认过的 issuer 读（RFC 8414 与 OIDC 的位置，按规范的顺序）。

- `issuer` 必须与确认的完全相同（`metadata`）。
- 授权、令牌、注册、撤销端点都必须在 issuer 的源上，`https://` 或字面的本机回环（`endpoint`）。所以 code、verifier 与令牌只发往确认过的那一个源；端点分在几个源上的授权服务器登录不了。
- `code_challenge_methods_supported` 没有 `S256` 时拒绝（`pkce`）。

### 客户端

- **人填的 Client ID**（`clientId`；密钥 `clientSecret` 存 `secrets.json`）：有密钥时用 `client_secret_basic`，服务器只收 `client_secret_post` 时用它。回调路径固定为 `/callback`（注册时填 `http://127.0.0.1/callback`，端口任意）。
- **动态注册**（RFC 7591）：没有 Client ID 时向 `registration_endpoint` 注册公开客户端，每次登录一次，回调路径带 128 位随机值。
- 两者都没有：409 `mcp-oauth-client-required`，界面让人填。
- **远端给的值要像秘密。** 注册回答里的 `client_secret` 与授权服务器发的每个令牌都必须是 token68、至少 20 个字符（否则 `registration`、`token`，续期时按被拒处理）。保存的令牌会按确切值被遮盖，所以不让远端把一个普通的词变成「秘密」。
- Basic 头里的 Client ID 与密钥各自先按表单编码（RFC 6749 §2.3.1）。
- 填写或更换 Client ID 不弹确认，先写 `mcp.server.changed`（`secret`）。

### 开始登录

1. 先写 `mcp.oauth.started`，写不进就不开始。
2. Host 在 `127.0.0.1` 的随机端口开一个只为这次登录存在的监听（不是 API 的入口），生成 `state`（256 位）与 PKCE verifier。
3. 回答授权地址：`response_type=code`、`client_id`、`redirect_uri`、`state`、`code_challenge`（`S256`）、`resource`、`scope`。

- 地址只在这一次回答里给发起的桌面端。**浏览器由人在桌面端打开**，Host 不启动任何程序。
- **重发。** 同一设备的同一 `requestId` 按回执回答（登录与退出登录都是；回执只在内存里；带不同的请求体 409 `request-conflict`），不再注册、不再开监听、不再撤销。那次登录还在等就给同一个地址；已经完成、取消或超时就只给现在的状态。
- 同一个服务器只有一次登录在进行（新的顶掉旧的）；全部服务器最多 4 次，正在准备的也算。

### 回调

- 只认 `GET`、这次登录自己的路径、`Host` 是 `127.0.0.1:<端口>`；其他一律 404。
- **不带这次登录的 `state` 的请求**谁都发得出（别的进程、扫回环的网页）：回答 400，什么都不改变，登录继续等。这类拒绝每秒最多回答 20 个，再多的直接断开，不写审计。
- **带着 `state` 的**才是浏览器的回调。`iss` 与确认的 issuer 不同，或元数据说会带而没带（`issuer`）；带了 `error`（`denied`）：拒绝并结束这次登录。
- 5 分钟没回来（`expired`）监听关闭。
- 第一个相符的回调之后不再收别的：换令牌期间同一个回调再来被拒绝并记 `replay`（一次登录最多 3 条）；换完监听关闭。
- 页面无论结果都只显示同一句固定的话（`CALLBACK_TEXT`），不显示授权服务器的任何内容。

### 换令牌与保存

- `code`、`redirect_uri`、`code_verifier`、`resource` 发往令牌端点。回答必须是 `Bearer`；回答的 `scope` 超出请求的范围时拒绝（`scope`）。
- **保存前核对**：服务器的定义没变、仍启用；这期间没有退出登录或移除；发起的设备仍是能管理这台 Mac 的设备（否则 `cancelled`）。
- 再写 `mcp.oauth.authorized`，写不进就不保存（`audit`）。
- 没保存的令牌，以及被这次登录顶替的旧令牌，在有撤销端点时交还。
- 换令牌期间 code 与拿到的令牌按确切值加入遮盖。

### 使用与续期

- `McpRemoteSession` 在每个请求上带 `Authorization: Bearer`，只发往绑定的地址（与请求头同一条路，不跟随重定向）。
- 到期前 60 秒先用 refresh token 续期（带 `resource`；轮换出的新 refresh token 替换旧的）。服务器回答 401 时续期一次、重发一次。同一时刻要续期的请求共用一次续期。成功的续期不写审计。
- 续期的回答按登录时同样的规则核对：范围超出确认过的不保存、交还。
- **变成「需要重新登录」**（原因 `refresh`、`expired`、`rejected`、`scope`）：续期被授权服务器拒绝（令牌删除）；没有 refresh token；续期后仍 401；范围超出；403 `insufficient_scope`（不自动扩大范围）。续期失败记 `mcp.oauth.refresh-failed`。

### 结束

「退出登录」、移除服务器、换地址（登录属于确认时的地址）或换授权服务器时：

1. **先在这台 Mac 上结束**（`forget`）。这个服务器的登录「代」加一：正在准备的登录立刻关掉监听；正在换令牌的登录与在途的续期回来时什么都不保存、把拿到的交还。从这一刻起不再带 bearer；令牌从 `secrets.json` 删除，用着它的会话结束。
2. **再向撤销端点撤销**（RFC 7009，必须在确认的 issuer 的源上）refresh 与 access token，在配置锁之外，每个请求有时限、尽力而为。

- 结果（`revoked`、`failed`、`unsupported`）在回答与 `mcp.oauth.revoked` 里。
- **本机的删除写不进**时结果是 `undeleted`（审计记的也是它）：令牌还在磁盘上但不再发出，界面写「没能删除这台 Mac 上的登录」与「重试」，这期间不能开始新的登录（409 `mcp-oauth-delete`）。
- **`mcp-ended.json`。** 「已结束」另写在 `<数据目录>/mcp-ended.json`：只有服务器 ID，在 `mcp/` 之外，所以 `mcp/` 写不进时它仍可能写得进。Host 启动时先把这些服务器的令牌从内存里拿掉、再从文件里删除，删成了才去掉记号：结束过的登录不会在重启后回来。连这个记号也写不进时，结束只在这次运行里有效，界面同样写没能删除。
- 换地址、换授权服务器或换 Client ID 时，旧登录随那一次写入一起删除；写入失败就保留原样。
- 授权服务器在回环或私网、而且不再有服务器在那里登录时，它的出站许可随之收回；与服务器自己的地址同一个 `host:port` 的不动。
- 结束只收窄：审计写不进照常执行，响应带 `x-latch-audit: failed`。
- 人填的 Client ID 与密钥留到移除服务器。

### 登录的审计

detail 只有服务器 ID 与类别。令牌、code、state、verifier、Client ID 与地址都不在其中，也不进日志、事件流与错误文字。

| 动作 | detail |
| --- | --- |
| `mcp.oauth.started`、`mcp.oauth.authorized` | actor 是发起的设备；后者带 `registered`、`renewable` |
| `mcp.oauth.failed` | `reason` |
| `mcp.oauth.refresh-failed` | — |
| `mcp.oauth.revoked` | `result` |

### 登录的限制

- `state`、进行中的登录与「登录失败」的原因只在内存里，Host 重启后要重新开始。
- 动态注册在授权服务器那边留下的客户端不会被删除：每次登录注册一个，Latch 不调用注册管理接口（RFC 7592）。
- 运行中 403 的 `scope` 挑战不被记下：重新登录时按服务器当时说的范围，比确认过的宽就再确认。
- 只在假授权服务器上验证过，真实的授权服务器没有逐一验证。

## 用在哪些会话

「用在」是所有会话，或选中的 Agent（我的 Agent，含它们的定时运行）与项目（会话的 `workspaceId`），后两者取并集。

- 一个会话拿到哪些服务器，在每次启动 Agent 进程时按当时的定义算出（新会话、恢复、载入、分叉）。
- 这组服务器与它们的 `specHash` 的哈希在给出它们的同一刻算出，记进 `task.l3.started` 的 `mcpSetHash`。
- 停用、移除、改了定义或「用在」不再包括这个会话的服务器：正在运行的桥立即结束，下一次也不再给。
- 桥启动服务器与每次调用时 Host 再核对一次：服务器仍在、开着、定义与确认一致、这个会话仍在「用在」里、工具没被关掉，否则拒绝。

## latch-mcp 桥

每个服务器在 `mcpServers` 里是一个桥，本机命令与远程地址一样。

**桥的启动**

- 命令是 Host 自己的 Node，参数是 `--disable-sigusr1 -e <固定源码> <网关套接字> <令牌文件>`，`env` 为空，名字是服务器的名称。参数里没有令牌、没有秘密。
- **令牌。** 工具网关（[ARCHITECTURE.md](ARCHITECTURE.md#harness-与会话路由)）为每个桥发一个 `lbt1.` 令牌，写进网关目录里新建的 0600 文件；Host 只存哈希。
- 桥在 `initialize` 时才读出并删除令牌。只问 `server/discover` 的一次性副本因此拿不到它：桥回答 method not found，Agent 回到 `initialize`。
- 令牌随 Agent 进程结束、会话归档或删除、服务器被移除、停用或改动而失效。

**本机命令**

- 桥经网关取 `mcp/launch`：命令、参数（`${workspaceFolder}` 换成会话的主文件夹）、环境与工作目录。Host 先写 `mcp.server.started`（服务器 ID、会话 ID、`specHash`），写不进就不启动。
- **这是秘密离开 Host 的唯一地方**：它们只写进服务器进程的环境。服务器在自己的进程组里。
- **环境只来自 Host 的清单**：`PATH`（命令所在目录在前，再加这个人的程序目录）、`BASE_ENV` 与 `PROXY_ENV`（`mcp.ts`：`HOME`、`USER`、`LANG`、`TMPDIR` 等与 Host 的代理和 CA 变量），再加这个服务器自己的变量。Agent 进程的环境（包括 `lmg1.` 网关凭据与 `lbt1.` 令牌）带不进去。
- **工作目录**默认是 Host 运行目录里为这个桥新建的空文件夹，桥结束时删除：`npx` 不会先用项目 `node_modules` 里的同名包。打开「在项目文件夹里启动」时是会话的主文件夹。
- 桥转发 `initialize`、`ping`、`tools/list`、`tools/call`、取消、`notifications/tools/list_changed` 与[提示](#提示)请求。服务器自己的请求（sampling、elicitation、roots）一律回答 method not found。
- 每次 `tools/call` 先经网关写 `mcp.tool.called`（服务器 ID、会话 ID、调用 ID、工具名与服务器 ID 的哈希），结束时补 `mcp.tool.settled`（`ok`、`error`、`cancelled`、`failed` 与耗时）。参数与结果从不经过网关。
- 关掉的工具不在 `tools/list` 里，调用直接回答「This tool is switched off in Latch.」，不经过服务器；启动清单给了 `offHints` 时后面接一句该怎么做（见[给 Agent 的指引](#给-agent-的指引)）。
- 启动清单带 `instructions` 时，桥在 `initialize` 的结果里用它替换服务器自己的 `instructions`；不带时原样转出。
- 参数与结果从不经过网关的唯一例外：参数名含 device、udid 或 destination 的值里若有一个 UUID，桥把它（大写）随 `mcp/call` 交给 Host，「Xcode」预设用它记设备并显示「Agent 正在使用」（[DEVICE-PREVIEW.md](DEVICE-PREVIEW.md#xcode预设设置--mcp)）。

**远程地址**

- 启动清单只说 `remote: true`，审计照样先写 `mcp.server.started`。桥只在清单成功并说明是远程地址之后才转发。
- 桥不启动任何程序、不连外网：`initialize`、`tools/list`、`tools/call` 经网关的 `mcp/remote` 交给 Host；Agent 的取消经 `mcp/cancel` 中止 Host 那边的请求；`ping` 由桥自己回答。
- 桥与 Agent 之间的会话按 Agent 要的协议版本回答，与 Host 和服务器之间的会话互不相干。
- `tools/call` 由 Host 先核对、先写 `mcp.tool.called`，写不进就不发，结束补 `mcp.tool.settled`。参数与结果经过网关，但请求头从不离开 Host。

**失败与结束**

- **坏掉的服务器不挡会话。** 命令起不来、进程退出、30 秒内没有完成 `initialize`，或远程服务器连不上时，桥自己回答 `initialize`（只有 tools 能力）、`tools/list` 为空，并经网关报告原因。任何一个服务器失败就拒绝建会话的 Harness（DeepSeek Harness）也照常开始。
- 会话里写一行「MCP 服务器「名称」没有启动：原因」，设置里的状态变成「失败」。
- 桥的标准输入关闭、令牌失效（网关断开连接）或收到 SIGTERM 时，结束服务器的整个进程组。

### 提示

- 本机命令声明 `prompts` 时，桥向 Harness 报告这个能力，转发 `prompts/list` 与 `prompts/get`；不转发提示列表变化通知。
- 远程桥拒绝这两种请求：Host 的远程客户端只提供工具。
- **取提示前**，Host 复查服务器的定义和会话范围，先写 `mcp.prompt.got`（服务器 ID、会话 ID、提示名的哈希），再让当前 Driver 持久化会话的外部来源标记。审计或来源标记写不成、Driver 不支持持久化标记或会话找不到时，桥拒绝请求。
- 通过之后桥才把原有参数发给本机命令，并且从这一刻起才接受对应请求的回包。参数与服务器回给 Harness 的正文只在桥这一侧流转。
- **来源。** 到会话清空上下文前，该会话产生的记忆和定时提议都标作外部内容。清空时旧桥结束并清理旧来源；新桥绑定期间经它转发的提示计入新上下文。
- 审计和标记记录的是获准转发，之后仍可能取消、失败或退出。会话仍有正在运行的用户消息时，Web 与 iOS 在这条消息上显示「来自 MCP 提示」。
- 是否列出和执行提示命令由 Harness 决定。页面只显示 Harness 自己报告的命令；桥返回的提示目录不直接进入斜杠菜单（[HARNESSES.md](HARNESSES.md#会话命令)）。

## 各 Harness

`HarnessInfo.skills === 'server'` 的 Harness 接收 Latch 的服务器。

| Harness | 怎样拿到 |
| --- | --- |
| 经 ACP 的预设与自定义 Harness | `session/new`、`resume`、`load` 与分叉的 `mcpServers`，在 `latch-skills`、`latch-browser` 之后，每个服务器一个桥 |
| Codex 直连 | 线程的 `config.mcp_servers`（`thread/start` 与 `thread/resume`），每个服务器一个桥，加 `startup_timeout_sec: 60`（`npx` 首次下载常超过 Codex 默认的 10 秒）。Codex 可能把线程配置写进它自己的文件，那里只有路径。同名时线程覆盖 Codex 自己的服务器 |
| pi | 不接收（预设 `skillServer: false`） |
| 内置 Harness | 只有远程地址，见下 |

**内置 Harness**（`mcpTools`）

- 每次运行开始时，Host 列出这个会话「用在」的、与确认一致的远程服务器的工具。每次运行先写 `mcp.server.started`，写不进就不打开这个服务器。
- 每个工具注册为 `mcp__<服务器名称>__<工具>_<8 位哈希>`：哈希取服务器 ID 与工具原名，总在；不合模型协议的字符换成 `_`，最多 64 个字符。两个服务器或工具不会得到同一个名字。说明写明来自哪个服务器。
- **调用一律 R2**（`riskReason: 'mcp-tool'`）：每次询问，没有「始终允许」，服务器自报的只读提示不改变它。因为是 R2，调用过的会话之后的记忆提议都标「来自外部内容」。
- 执行前再核对服务器仍在、开着、与确认一致、仍「用在」这个会话、工具没关，先写 `mcp.tool.called`。
- 设了「可以使用」的 Agent 只拿到名单里写作 `mcp:<服务器 ID>` 的服务器。名单尚未提供这一项，所以这样的 Agent 在内置 Harness 上没有 MCP 工具。
- 本机命令尚未实现：要由 Host 自己运行这个命令，而内置 Harness 是 L1。

真实的 Codex（直连）、Claude Agent 与 OpenCode 启动并调用桥，由 `computer-guide.live.test.ts` 用假 Driver 核对（[给 Agent 的指引](#给-agent-的指引)）；其他 Harness 只在假 Agent 与回放上验证过。

## Harness 自己的 MCP

- **只显示 Harness 经协议报告的。** 从不读写任何 CLI 的配置（`~/.codex/config.toml`、`~/.claude.json`、`~/.cursor/mcp.json` 等），也不代它登录。
- 只有 Codex 直连报告：app-server 的 `mcpServerStatus/list` 与 `mcpServer/startupStatus/updated`（[HARNESSES.md](HARNESSES.md#codex-的-app-server)）。其他 Harness 写「这个 Harness 不报告自己的 MCP」。
- `HarnessInfo.ownMcp` 只在报告的 Harness 上有：`last`（服务器、时间、来自会话还是读取，读取只得到名字时 `namesOnly`）、`running`、`failed`。只在 Host 内存里，定义变了就作废。
- 每个服务器只有名字、状态、工具数与远程服务器的源，只读。
- Codex 报告需要登录时给出它自己的 `codex mcp login <名字>`（名字只有字母、数字、`-`、`_` 且不以 `-` 开头时才给）。Latch 不调用它的 OAuth。
- **会话里的状态**随 Codex 的启动通知更新，不启动任何东西。
- **「读取」**在空的私有文件夹里启动一次 `codex app-server`，不开 thread，整个读取共 60 秒。它可能启动 Codex 配置的服务器，所以只由人按下。读取只得到名字时，已有会话报告的状态不被它覆盖。
- 线程配置里 Latch 自己的服务器不算 Codex 的。与 Latch 的服务器同名的写「会话里用 Latch 的同名服务器」：线程配置覆盖 Codex 自己的。

## 从项目导入

只在这台 Mac 的桌面端（`host.sock`）。Host 读所选项目每个文件夹里的 `.mcp.json`（`mcp-import.ts`），只读这一个文件：其他工具自己的配置不读。什么都不运行，不经 Agent，也不随会话交给 Agent。

**读法**

- 不跟随链接（`O_NOFOLLOW`），必须是只有一个名字的普通文件（链接与硬链接都可能指向你的任何文件），最多 64 KiB，从检查过的同一个描述符读。否则整份拒绝（`not-file`、`too-large`）。
- JSON 必须恰好是 `{ "mcpServers": { … } }`（`not-json`、`invalid`）。最多列出 32 个。
- 每个服务器按 strict schema 单独判断：本机命令 `{ type?: "stdio", command, args?, env? }`，远程地址 `{ type?: "http" | "streamable-http", url, headers? }`。
- 按「格式不对」跳过：未知字段；`__proto__` 之类的键；`escapeSecurityText` 要写出来的字符（控制字符、改变方向的字符、行与段落分隔符、不可见字符）。`type: "sse"` 写「旧的 HTTP+SSE 传输尚未实现」。

**不展开，不带秘密**

- `${…}` 一律按原样显示，从不用 Host 的环境展开，标「含 ${…}」。`${workspaceFolder}` 是 Latch 自己的参数写法，不算。
- 请求头只给名字。
- 变量只给名字、作空的秘密字段等人填：值是 `${…}`；名字像凭据（`SECRET_NAME`）；值形如已知的密钥或一长串字母数字。其余作普通变量带值，会出现在确认里。
- 参数里像秘密的值（整个参数、`--x=值` 的值、`--token` 这类参数之后的那个）与地址里的账号、像秘密的查询都留空，标「像秘密的值已留空」。

**落在项目里的命令与参数**按[测试](#测试)的同一规则标出（相对路径从那个文件夹算起）：

- 命令在项目、工作树、会话文件夹或 Latch 自己的目录里：「命令在项目里：不能添加」（保存本来就拒绝）。
- 参数或普通变量指向那里、且那里真有这个文件：「参数指向项目里的文件：测试会拒绝」。`@scope/server` 这样的包名有分隔符，但不是路径。
- 只有文字上已在某个根目录下的路径才去查文件系统；`/net/…` 这类自动挂载或别处的路径从不触碰。

**添加。** 选一个后预填表单（名称在合规且没人用时才填），然后是正常的添加：本机确认，审计带 `importedFrom`。导入后是 Latch 自己的一份，仓库以后怎么改都不影响它。

## 操控这台 Mac

把 Cua Driver（MIT，人自己安装）加成一个本机命令。Latch 只把工具交给 Agent，不另做控制层：不代理、不分档、不按 App 授权、不管理它的守护进程、不把截图放进会话。

**检测**（`mcp-computer.ts`，只在启动脚本于 macOS 上给出 `computerDriver` 时；测试 Host 不给就不提供，也碰不到真的 Driver）

- 只看 `/Applications/CuaDriver.app`：本身是目录而不是链接，`Contents/MacOS/cua-driver` 是普通可执行文件、别人不能写；否则 `refused`（`bundle`）。
- `codesign --verify --strict` 按要求核对：标识 `com.trycua.driver`、Apple 签发、团队 `YCK386LBJ7`；否则 `refused`（`signature`），程序不运行。
- 再运行 `cua-driver --version`：不经 shell、空的工作目录、只带关遥测的变量与 `PATH`，最多 5 秒、4 KiB，然后结束进程组。读不出 `cua-driver <版本>` 是 `refused`（`version`）。
- 低于 0.10.0 是 `old`：`telemetry disable` 从 0.9.0 起有，`revoke --all` 从 0.10.0 起有。没有安装是 `absent`。
- 这是添加时的检查，不保证文件以后不变。

**添加**（`POST /mcp/servers` 带 `{ requestId, baseRevision, preset: 'computer', scope }`）

- Host 再检测一次，只有 `ok` 才添加；命令、参数、变量由 Host 写，请求体不能给。名称 `computer`，同一台 Host 只有一个。
- 然后与任何本机命令一样：`mcp.server.apply` 确认（命令的绝对路径、`mcp`、变量全文，加一句「以你的身份操作这台 Mac 上的 App，不是沙箱」），先写 `mcp.server.added`（`preset: 'computer'`）。
- 页面给的「用在」是空的：人在「用在」里选会话。
- 未安装或版本太旧时只给上游的安装命令（「在终端里打开」与复制，同 Harness 的安装行）（固定版本，带 `CUA_DRIVER_NO_CONNECT`、`NO_TEST`、`NO_MODIFY_PATH`，不改 Agent CLI 的配置与 shell 配置），由人在终端里运行。Latch 不下载、不安装、不升级它。

**默认**

- 普通变量 `DO_NOT_TRACK=1`、`CUA_DRIVER_RS_TELEMETRY_ENABLED=false`、`CUA_TELEMETRY_ENABLED=false`、`CUA_DRIVER_RS_UPDATE_CHECK=false`。它们只作用于 `mcp` 进程：macOS 上它把调用交给 CuaDriver.app 的守护进程，那是 LaunchServices 启动的，拿不到这些变量。守护进程的遥测要人自己在终端运行 `<程序路径> telemetry disable`：设置里这一行给「在终端里打开」与复制，添加前在「操控这台 Mac」里、添加后在服务器的页面上。
- 不用限制模式（bounded）：它属于守护进程的启动参数，`mcp` 不接受；要用时人按 Driver 自己的文档启动守护进程与授权清单。
- 关掉的工具（`COMPUTER_TOOLS_OFF`，名字取自 0.44.0 的文档，人可以逐个打开）：剪贴板；在 Driver 里运行别的工具的（`run_script`、`run_steps`、`replay_trajectory`、`escalate_session`），它们绕过 Latch 的逐个开关与逐次记录；启动或结束程序的 `launch_app`（收地址与额外参数）、`kill_app`；`start_recording`；能藏起 Agent 光标的 `set_agent_cursor_enabled`；`page` 与 `browser_*`；`check_for_update`、`install_ffmpeg`、`install_extension`、`set_config`。
- `get_window_state` 与 `get_desktop_state` 的 `screenshot_out_file` 参数能把截图写到任意文件；它不是单独的工具，Latch 按工具开关，关不掉一个参数。
- **新工具默认关。** 定义带 `knownTools`（0.44.0 文档列出的全部工具）：不在其中的工具是新的，不列给 Agent、调用被拒（`isMcpToolOn`，桥与 Host 各查一次），设置里标「新」。打开它就加入 `knownTools`，与重新打开工具一样算 `use`：先审计，不确认。

**限制**

- 不给无人值守的运行：自动化（我的 Agent 的定时运行）的会话拿不到它，从创建时起（`hub.unattended`）。
- 要立刻停下 Driver 正在做的一切：在终端运行 `cua-driver revoke --all`（重启守护进程前一直拒绝）；在 Latch 里停用这个服务器则结束各会话的桥。
- 它以你的身份操作这台 Mac，不是沙箱。完全访问（L3）的 Agent 本来就能直接运行 `cua-driver`，绕过 Latch 的开关与记录。
- 不要让它操作 Electron 与 Chromium 应用（含 Latch 与 VS Code）：上游 #7292（像素点击让渲染进程崩溃）、#6258（后台拖动或悬停发 SIGUSR1，没有调试开关的应用退出）还开着。所有版本都标为预发布。
- 谁能用它按「用在」与[各 Harness](#各-harness)：ACP 预设与 Codex 直连可以，pi 与内置 Harness 不能用本机命令。
- 辅助功能与屏幕录制由人在系统设置里授予 CuaDriver.app；「测试」会启动 Driver 的守护进程，只由人按。

### 给 Agent 的指引

Latch 自己写一段短指引（`computerGuide`，`mcp-computer.ts`，英文，同其他给 Agent 的文字），只讲 Latch 实际给出的工具与 Latch 的规则：何时用；先选一个窗口窄读；按元素令牌操作，坐标最后；在检查点验证；关掉的工具与替代；不操作 Latch 与其他 Electron、Chromium 应用，网页用 `latch-browser`；登录、密码、付款与系统权限对话框交还给人。不写进任何 CLI 的配置或技能目录，走三条路：

- **`instructions`。** 启动清单带上它，桥在 `initialize` 时**替换** Driver 自己的 `instructions`，不拼接：上游文字要 Agent 一律用 `run_steps`、需要逻辑时用 `run_script`、用 `launch_app` 开 App，而这些在 Latch 默认关闭；它随 Driver 版本变，按段删改会过时。指引列出这个服务器**此刻**关掉的工具（人打开的不再列），并说明 `get_guide` 仍返回上游指引、假定所有工具都开着，两者不同时以这段为准。
- **拒绝的话。** 关掉的工具被拒时，桥（与 Host 的复查）在「This tool is switched off in Latch.」后接几个词：`run_steps`、`run_script`、`replay_trajectory` 是一步一个调用；`launch_app`、`kill_app` 是请人打开或退出；剪贴板是从窗口读或用 `type_text`；`page`、`browser_*` 是用 `latch-browser`（`COMPUTER_OFF_HINTS`）。
- **`latch-skills` 的技能。** 会话有 `latch-skills` 时（带技能或能提议，见 [HARNESSES.md](HARNESSES.md)），同一段文字作为技能 `latch-operate-this-mac` 排在 Agent 自己的技能之后，`read_skill` 可读。每次打开、恢复、载入或分叉会话时写进会话私有目录的 `guides.json`（`writeSessionGuides`），只在 Latch 的数据目录里。会话中途才「用在」的服务器要等下次启动进程才进清单。

谁收得到：能用这个预设的只有收 `mcpServers` 的 Harness（ACP 预设、自定义 Harness 与 Codex 直连），它们都经桥拿到 `initialize`。pi 不收 MCP，内置 Harness 不跑本机命令，两者都用不了这个预设，也就不需要指引。因此设置里不提供「安装技能到某个 Harness」：没有 Harness 要靠自己技能目录里的文件才能看到它。

真实 CLI 的核对（`apps/host/test/computer-guide.live.test.ts`，只在设了 `LATCH_COMPUTER_GUIDE_LIVE` 时运行）：同一个假 Driver 分别作为这个预设与作为关掉同样工具的普通服务器，各跑同样两轮（改 TextEdit 并保存；最小化 Latch 窗口），记下 Agent 的工具行与到达假 Driver 的调用；不碰桌面。关掉的工具本来就不在 `tools/list` 里，两组都没有调用；指引的作用在于拒绝操作 Latch 窗口。

## 界面

- **设置 › MCP** 对 `admin` 设备可见。「添加…」与除停用以外的改动只在这台 Mac 的桌面端出现；其他设备只看、只能停用。
- 值从不显示：变量与请求头只列名字与「已设置」。
- 状态用词与颜色：失败是红色，原因在悬停里；要登录的远程服务器「未登录」「需要重新登录」是琥珀，「登录失败」是红色。
- `npx`、`uvx` 等没写版本时写琥珀色「每次启动可能下载新版本」。
- 「操控这台 Mac」只在这台 Mac 的桌面端、Host 给了位置且还没添加时出现：一行状态（未安装、版本太旧、不是签名的 Cua Driver、已找到），按状态给安装或升级命令（「在终端里打开」与复制）或「添加…」，找到后另有关遥测的命令；ⓘ 里是以你的身份、不是沙箱、先不要用于 Electron 应用、Latch 的变量到不了守护进程。
- **我的 Agent › 资料面板 › MCP** 列出这个 Agent 的会话拿到的服务器。桌面端的开关改的是服务器的「用在」，不要确认。

## 测试替身

HTTP 的两个只听 127.0.0.1。它们记下请求头与参数的名字，值只记测试点名的。

| 替身 | 是什么 | 可脚本的情形 |
| --- | --- | --- |
| `packages/testkit/src/fake-mcp-http.ts`（`startFakeMcpHttp`） | 进程内的 Streamable HTTP 服务器；工具 `echo`（可把指名的请求头说回来，用于检查遮盖）、`slow`、`big` | 要求登录；作受保护的资源（`protect`：元数据指向别处、别的 `resource`、不带指针的挑战、403 `insufficient_scope`）；重定向；忘掉会话；在回答前发自己的请求 |
| `packages/testkit/src/fake-oauth.ts`（`startFakeOAuth`） | 进程内的授权服务器：RFC 8414 元数据、动态注册、授权码加 PKCE、续期（轮换）、撤销。`authorize()` 代替人的浏览器，返回回调地址而不访问它 | 错的或缺的 `iss`；改写元数据；不提供注册；续期被拒；不发 refresh token；多给范围；撤销失败；令牌立刻作废（`expireAccess`） |
| `packages/testkit/fixtures/fake-mcp-stdio.mjs`（`FAKE_MCP_STDIO`） | stdio 服务器；工具 `echo`、`slow`、`env_names`、`where`，`FAKE_MCP_EXTRA_TOOLS` 再加几个；`FAKE_MCP_LOG` 只记环境变量的名字 | `FAKE_MCP_MODE`：`crash`、`silent`、`noisy`、`ask`、`changed` |
| `packages/testkit/src/fake-cua-driver.ts`（`writeFakeCuaDriver`） | 未签名的 `CuaDriver.app`：`--version` 回答指定版本，其余运行上面的 stdio 服务器 | 版本、版本行、多出的工具 |

假 ACP Agent 在 `FAKE_ACP_MCP=dsh` 下：提示 `mcp <服务器> <工具> [JSON 参数]` 调用一个工具，`mcp-list <服务器>` 列出工具。
