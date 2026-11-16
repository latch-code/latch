---
description: Harness 经 Host 使用模型服务的回环入口、凭据、协议与转换、各 Harness 的交付、调度（重试、备选、健康、并发），以及用量账本、花费与预算。
sources:
  - apps/host/src/model-gateway.ts
  - apps/host/src/model-gateway
  - apps/host/src/model-request-queue.ts
  - apps/host/src/model-scheduler.ts
  - apps/host/src/scheduled-provider.ts
  - apps/host/src/model-reply.ts
  - apps/host/src/model-usage.ts
  - apps/host/src/model-budgets.ts
  - apps/host/src/model-usage-routes.ts
  - packages/harness-acp/src/profiles
  - packages/harness-acp/src/runtime.ts
---
# 模型网关

Host 为经 Latch 使用模型服务的 Harness 提供一个单独的回环临时端口。它只有模型路径，不是设备 API。服务的真实密钥留在 Host，只发往已确认的服务源与路径，经与内置 Harness 相同的出站策略。

- 模型服务与路由保存在 Host 配置里。接线只用该次请求、进程级覆盖或 Latch 私有文件，不改用户原 CLI 的全局或项目配置，不注册全局 hooks（[不修改原 CLI 配置](HARNESSES.md#不修改原-cli-配置)）。
- Agent、插件和扩展是可信本机代码，网关不是 OS 隔离。
- 真实失败从不回退到演示模型，也不回退到 Harness 自己的登录。

## 凭据

- 每个 Agent 进程一个 `lmg1.` 凭据。Host 内存只存它的哈希。
- 凭据绑定会话、服务、入口协议、模型列表，以及每个候选签发时的服务指纹；只开放自己协议的路径。
- 凭据只由 runtime 注入 profile 允许的环境变量（`tokenEnv`，或按协议的 `tokenEnvByWire`），codex-acp 经 ACP 头字段。它不进参数、私有文件、URL、日志、审计、SSE、启动预览与持久化会话。
- 作废：进程退出、Host 关闭，或服务的协议、地址、密钥、可用性、模型清单、声明能力变化。下一轮重新准备进程与凭据；服务不能用了就明确失败。
- 会话不能换服务，同服务内只提供凭据允许的模型。
- Host 保存的 vision/thinking 声明随租约（`ModelGatewayLease.modelCapabilities`）交给 profile，不从模型名猜图片、思考、价格或容量。

工具网关的 `lbt1.` 令牌是另一套：每个 `latch-mcp` 桥一个，经 0600 的令牌文件交给桥，不进参数与环境，Host 只存哈希（[MCP.md](MCP.md#latch-mcp-桥)）。

## 协议与请求

三种入口（`MODEL_WIRES`），优先同协议透传：

| 入口 | 模型请求 | 模型列表 |
| --- | --- | --- |
| Responses | `POST /v1/responses` | `GET /v1/models`，OpenAI 形状 |
| Chat Completions | `POST /v1/chat/completions` | 同上 |
| Anthropic Messages | `POST /v1/messages`、`POST /v1/messages/count_tokens` | `GET /v1/models`，Anthropic 形状 |

已实现的转换（`TRANSLATED_PAIRS`，都标实验性）：Responses → Chat、Responses → Anthropic、Anthropic → Chat、Anthropic → Responses。Chat 入口到其他协议尚未实现。

**入站**

- 只接受预期的回环 Host。带 `Origin`、浏览器的 `Sec-Fetch-*` 标记的请求 403 `gateway-origin`；只有单独的 `Sec-Fetch-Mode: cors`（Node fetch 会发）可以通过。这不是身份验证，仍要有效凭据；不返回 CORS 头。
- 请求体最多 32 MiB，模型必须在凭据绑定的列表里，完全匹配，不去 `models/` 之类的前缀。
- 模型列表只返回绑定的模型，不访问上游。
- Chat 流式请求没写 `stream_options.include_usage` 时补为 true，写了的不覆盖；其他正文原样。

**出站**

- 入站认证、Cookie 与未列出的头不转发。Chat、Responses 只转发 `accept`、`openai-beta`；Anthropic 同协议透传另保留 `anthropic-version`、`anthropic-beta`。
- 读完请求体后、发出前再核对一次凭据与服务指纹：上传期间被撤销或变更的请求不转发。
- 上游不跟随重定向。下游断开时中止上游。
- 回复只保留 `content-type`、`retry-after`、`x-request-id`、`request-id`，值也脱敏。

**脱敏与错误**

- 错误正文最多读 64 KiB，去掉真实密钥的原文、JSON 转义、URL 编码与截断尾部后返回。
- 成功状态的 JSON 与 SSE 也沿流跨字节块脱敏，只暂存可能的密钥前缀。日志经 Host 秘密脱敏。
- 回复开始后断流记为未完成，不重发、不换服务。同协议透传以入口协议的流内错误结束：Responses 的 `response.failed`、Anthropic 的 `error` 事件、Chat 的 `error` 数据。

### 转换的共同规则

入口与上游分别绑定在凭据上：`ModelRoute.wire` 是 Harness 的入口，可选的 `upstream` 是服务的协议，缺省与入口相同。Host 用 `pairRoute` 重算路线，网关再核对 `TRANSLATED_PAIRS`、服务协议与来源；一个入口的凭据不会开放给另一个入口。

转换用网关自己的类型化条目（`model-gateway/ir.ts`），不改内置 Harness 的 `ModelMessage`。网关不执行工具，不下载图片 URL。

- **拒绝，而不是悄悄删掉。** 不能转换的内容在出站前 400：文件与 PDF、未知内容块、未支持的执行型历史条目、缺少对应调用或结果的历史。Responses 入口另拒绝服务端会话引用、`store: true` 与多个候选。
- **损耗是闭合枚举**（`GATEWAY_LOSSES`）。菜单的「协议转换」给出可能受限的能力；每轮 `routed.dropped` 只记这一轮实际遇到的枚举，不含正文。
- **服务端工具**不由 Host 代执行。Responses 入口略去它们的定义并记 `hosted-tools`；Anthropic 入口直接拒绝。Responses 的 `tool_search`（含 `execution:client` 的本机工具发现）按服务端工具略去，所以转换路线上 Codex 延迟提供的 MCP 工具可能发现不了；同协议 Responses 透传保留原生发现。
- **工具身份。** 命名空间与长工具名编码为稳定名称，回来时恢复；custom 工具改成只含 `content: string` 的函数再恢复。语法约束只作为说明传给服务（`tool-grammar`）。
- **数字词元保真。** 工具参数与 schema 里的有限数字用 Node 24 的 JSON source/rawJSON 保留原始词元（大整数、长小数、-0）；嵌套上限、非有限数值与脱敏后的键冲突仍然拒绝。
- **工具只在全部核对后发布。** 所有调用的身份与参数都验证后才给可执行的 done 或 `tool_use`。输出截断、被过滤、畸形调用或断流时一个都不发布。Chat 流里同一工具索引的 ID 与名称报告后不能变（重复相同值可以）。脱敏会改变工具 ID 或名称时整组拒绝。
- **工具选择约束**在发布前核对：`none` 不得调用；指定工具按名称、命名空间与 function/custom 身份精确匹配；`parallel=false` 至多一个；正常完成却没满足 required 或指定工具时拒绝。
- **失败不变成空成功。** 断流、畸形输出或流内错误按入口协议报错，不重试、不回退。429 与 `retry-after` 保留；上游 5xx 改为 503；上下文超长保留 `context_length_exceeded`。
- **用量只取上游证据**，不计暂存值；各方向对缺失用量的处理见下。
- **取消。** 下游取消中止上游。

**思考的来源封装。** 另一协议的思考以 `latch2.` 封装带回（Responses 的 `encrypted_content`、Anthropic 的 `signature`）。

- 它是带 HMAC 的来源封装，不是加密。签名 key 只在当前 Host 内存，绑定同一上游协议、服务与模型。
- 跨协议、跨服务、跨模型、被篡改、外来的或 Host 重启前的封装一律剥离并记 `reasoning-state`。要求完整旧思考的服务在重启后可能拒绝旧上下文，须清空上下文或重新开始。
- 封装前先脱敏。不透明内容（原生密文、Anthropic 签名覆盖的思考）命中脱敏规则时拒绝封装，不改写成无效密文。
- 因为不是加密，Anthropic 入口的 `thinking.display: omitted` 在出站前拒绝。
- IR 分开表示 Chat 的可读思考、Responses 的原生推理项与 Anthropic 的 thinking/signature、redacted_thinking/data；原生状态不转换成 Chat 的文字思考。

### Responses 转 Chat

- 入站先核对完整调用图：`call_id` 不得复用；每个 function/custom 调用有且只有一个同种类结果；结果未齐前不得开始用户或系统消息。
- 保留系统说明、消息、图片、函数定义、调用与结果、并行与指定工具选择、明确的思考档位和输出上限。
- Chat 的工具结果只发文字。工具图片排在同批全部工具结果之后的一条 user 消息里，逐组注明对应调用与「不是用户发送的」，记 `tool-image-location`。
- Chat 的 `reasoning_content` 用来源封装放进 `encrypted_content`，合法回放覆盖历史中的各个助手步骤。
- Chat 流强制请求末尾用量；每条流独立维护有界状态，处理 UTF-8 分块、交错的并行调用与结束后的 usage。

### Anthropic Messages 转 Chat

- 保留系统与会话中途的系统文字、用户图片、工具调用与结果、错误结果标记、工具选择、并行开关、输出上限、stop sequences 与明确的 effort（仍须在服务的声明中）。
- 服务端工具、服务端容器与压缩状态拒绝。固定的 thinking token 预算不能变成 Chat 的离散 effort，记 `unsupported-options`。
- Claude Agent 走这条转换时启用 `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`，不发送服务端工具搜索、context management 等尚未转换的功能。其他来源仍按收到的内容严格检查。
- 回复按 Anthropic SSE 的 message/content-block 顺序发送。`message_start` 的零用量只是暂存，最终 `message_delta` 必须用上游实际 usage；缺少时报错且不发 `message_stop`。
- 转换不表示模型是 Claude，也不按协议猜模型厂商。

### Anthropic Messages 转 Responses

- 发送完整历史，`store: false`，不用服务端会话、之前的 response ID 或压缩状态。
- 系统消息保留原位置；工具结果里的图片留在对应的 `function_call_output`，没有位置损耗。
- 没指定严格模式的工具显式发 `strict: false`（否则 Responses 会重写调用方的 schema）；JSON Schema 输出发 `strict: true`。
- 停止序列没有对应字段，出站前拒绝。
- 原生推理项（id、`encrypted_content`、summary、可选 content 与状态）经来源封装放进 Anthropic 的 signature；没有可读文字时用 `redacted_thinking.data`。密文迟至 `response.completed` 才到时，有界暂存其后的输出以保持顺序；正常完成却没有原生状态时拒绝。
- 未完成、被过滤、缺少用量或自相矛盾的输出都不释放可执行工具。到达完成事件后结束读取，并取消仍保持连接的上游。
- 服务端工具、异步或程序触发的调用与未请求的命名空间不当作本地工具。

### Responses 转 Anthropic Messages

- 出站用 `anthropic-version: 2023-06-01`。开头的系统说明放进 `system`，中途的保留原位置，目标模型不支持时由上游拒绝。
- 相邻助手条目合成一个有序内容块列表，保留空文字块、原生思考与调用顺序；工具结果的文字与图片留在对应 `tool_result`。
- `max_output_tokens` 转为 `max_tokens`，没给时用 8192。
- `none` 思考转为 disabled，其余已声明的 effort 转为 adaptive 加 `output_config.effort`；不猜固定思考预算。
- temperature 大于 1、`json_object` 输出格式在出站前拒绝；JSON Schema 转为原生结构化输出。图片的明确精度选项记 `unsupported-options`。
- 流按 message_start、逐块 start/delta/stop、message_delta、message_stop 核对身份、索引、类型与顺序。服务端执行块、`pause_turn` 与未知事件拒绝。
- 原生思考等签名完整才封装。正常完成缺少签名时拒绝；截断时记思考状态损耗，不伪造签名。输出上限、上下文耗尽或过滤保留 incomplete，工具都不发布。
- 完成必须有上游最终累计用量：输入是 `input_tokens`、`cache_read_input_tokens`、`cache_creation_input_tokens` 之和，缓存读写仍分别保留。用量倒退、溢出或缺失时不发布可执行工具。`message_stop` 后取消仍保持连接的上游。

## Harness 交付

各 Harness 说的协议、最低版本与限制在 [HARNESSES.md](HARNESSES.md#经-latch-使用模型服务) 的表里（来自 profile 的 `gateway`）。这里是接线：凭据放在哪、工具子进程怎样拿不到它。

| Harness | 接线 | 凭据 | 工具子进程 |
| --- | --- | --- | --- |
| Codex 直连 | 启动参数里的自定义 provider `latch`，只有地址、变量名与公开选项 | `LMG_TOKEN` | 线程 config 的环境过滤规则排除它 |
| codex-acp | ACP `providers/set`，只在适配器声明并列出该 provider 与 API 类型时 | ACP 头字段 | — |
| OpenCode | `OPENCODE_CONFIG_CONTENT` 里的私有 provider `latch` 与会话私有插件 | `LMG_TOKEN` | 插件清空它的值 |
| DeepSeek Harness | 私有 `--patch`：provider `latch-gateway`、ACP 与默认模型 | `LMG_TOKEN` | dsh 自己清除敏感变量 |
| Claude Agent | 官方环境变量与会话的 `modelPicker` | `ANTHROPIC_AUTH_TOKEN` | `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` |
| pi | 私有扩展调用 `registerProvider`，只在当前进程 | `LMG_TOKEN`，扩展读入内存 | 从继承环境删除 |
| Qwen Code | `QWEN_CODE_SYSTEM_SETTINGS_PATH` 指向会话私有系统设置，条目 `envKey: LMG_TOKEN` | `LMG_TOKEN` | 继承 |
| goose | 只有环境变量 | `OPENAI_API_KEY` 或 `ANTHROPIC_API_KEY`（它的 provider 规定） | 继承 |
| Grok Build | `GROK_HOME` 指向会话私有的家，`config.toml` 里 `env_key = "LMG_TOKEN"` | `LMG_TOKEN` | 继承 |

Antigravity 与 Cursor 不接受别人的模型服务地址（`ownModelsOnly`）；未知的自定义命令同样。订阅登录不进入网关。凭据被继承的后果见 [HARNESSES.md](HARNESSES.md#经-latch-使用模型服务)。

**launch 交付的共同规则**（`profiles/types.ts`、`runtime.ts`）

- profile 返回环境变量、参数、私有文件与公开的会话 metadata。文件 0600 原子替换，只写地址、模型、公开配置与变量名，不含凭据。
- profile 写出没列在 `envNames` 里的变量时拒绝启动。
- 写网关文件前，Host 检查受管临时根、会话目录与网关子目录：有链接、属主或权限不对时拒绝写入与启动，已申请的租约随之释放。会话移除与临时探测的清理也先查受管根，不沿已有链接删到外面。
- 启动指纹覆盖 profile 版本、交法、变量名与参数、文件、会话模板的版本，不含临时端口或凭据。
- 全部异步准备之后仍复查命令、项目与授权；准备失败撤销已创建的凭据。
- **版本门。** 网关声明最低版本时，初始化后核对 Agent 报告的版本；没有协议版本报告时取官方命令的版本读数；两者都无法确认就拒绝开始。dsh 的 ACP 固定报告内部版本 0.0.1，所以它只认官方命令的版本读数。自定义包装命令不能靠跳过版本查询绕过。用 Harness 自己的模型时不受这条门槛影响。

不带登录的真实核对（`gateway-no-login.live.test.ts`）怎样运行见 [TESTING.md](TESTING.md#需要显式开启的用例)。

### Codex 直连

- 开线程与恢复线程前，以相同 cwd 调用官方 `config/read`，只投影有效的命令环境过滤规则：旧的 exclude/include_only 与新的 filters 保持原表示，只额外排除 `LMG_TOKEN`。大小写冲突、混合表示、畸形或读取失败都拒绝开线程。规则经线程 config 覆盖，既有规则不被启动参数的数组替换。不复制其他配置值，不读写 Codex 私有文件。
- 导入历史仍经 `thread/list` 与 `thread/read`，包含自定义 provider 的线程。
- 模型列表取服务声明，允许 Codex 原生目录之外的模型。目录外模型用 Codex 自己的后备描述；Latch 不改模型 ID 去套另一个型号的能力，也不把后备描述里的容量当作服务声明。
- **思考。** 「默认」指模型服务的默认。wire 用租约的 `setThinking(model, effort)` 登记当前模型的意图：`null` 时出站只删这个模型请求的 `reasoning.effort`（Codex 自己的 `model_reasoning_effort` 可能补上一个值），其余字段不动；显式选择只允许服务声明的档位，实际请求必须相符。没登记意图的模型按原规则校验。
- 显式选择随会话 config 持久化，恢复后优先于 Codex 的旧配置。运行中的选择只保存下一轮意图；换模型清掉原选择。尚未应用的改档不能用 compact 绕过上下文核对。
- 原生委派的成员继承父轮的 provider 与进程内凭据；角色改用的模型超出会话的服务模型名单时网关拒绝。成员请求与父轮共享会话用量，账本没有成员 ID（[Codex 的 Agent 团队](HARNESSES.md#codex-的-agent-团队)）。

### OpenCode

- 模型值是 `latch/<模型>`，启动配置同时设主模型与小模型，保留原权限与 Agent 档位。
- 会话私有插件用官方的 shell `create.before` hook 把工具子进程里 `LMG_TOKEN` 的值清空。OpenCode 的环境合并保留空变量名，所以不说成变量不存在。
- 插件目录与源码计入启动指纹。

### DeepSeek Harness

- 网关 patch 与权限服务 patch 一起交付。这条路线关掉它的会话日志与包清单遥测插件。
- 配置值严格解码为该协议指定的 provider 与模型二元组；恢复不接受其他 provider 的同名模型。
- 它的 ACP `initialize` 不声明图片输入：模型支持图片也不能经这个入口发图片。

### Claude Agent

- **版本门**运行适配器自己的 `--cli --version`，只认它实际启动的 Claude Code 版本，不用 ACP 报告的适配器版本或 PATH 上另一个 `claude` 代替。每个新进程重读；无法确认或低于最低版本时在发凭据之前拒绝。
- `ANTHROPIC_BASE_URL` 指向会话网关，凭据在 `ANTHROPIC_AUTH_TOKEN`。其他 provider 开关、API key、OAuth token 与自定义头清空。`CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` 让 Claude Code 忽略设置文件里的 provider 地址与认证覆盖。
- 模型经适配器的 `_meta.claudeCode.options.settings` 交付（新建、载入、恢复、分叉）：`availableModels` 与 `modelPicker`，模型 ID 原样，不给 `behavesAs`、价格或推测容量。原生发现只留 ID 含 `claude` 或 `anthropic` 的模型，所以要显式 picker；Host 仍只保留 Agent 实际报告的精确值。
- 会话设置只有公开模型字段与禁用的 `apiKeyHelper`，不写用户的 CLI 设置。主模型、自定义模型项、自动模式分类器与子 Agent 默认值指向所选模型，其他默认别名清空。网关仍拒绝列表外的请求；不承诺未知的辅助调用都遵守配置。
- `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` 让 Bash、SessionStart hook 与 stdio MCP 子进程不继承凭据。泛化的 scrub 可被设置文件覆盖，不能据此说用户自己配置的秘密都被清除。
- Claude 对自定义模型假定的上下文容量与价格不作为服务事实显示，只保留它报告的已用上下文 token。

### Qwen Code

依据是 Qwen Code 的公开源码与文档，在 0.26.8 与 0.27.3 两个版本里核对过（括号里是它仓库里的路径，不是本仓库的）。

- **系统设置最后合并。** 路径由 `QWEN_CODE_SYSTEM_SETTINGS_PATH` 指定；合并顺序是系统默认、用户、项目、系统设置，后者覆盖前者（`packages/cli/src/config/settings.ts` 的 `mergeSettings`）。Latch 每次启动在会话私有目录原子写入 0600 的设置文件，不含凭据。
- **列表整体替换，空列表也是。** 数组只有声明了 `CONCAT`、`UNION` 的才拼接（`deepMerge.ts`），`modelProviders` 以下没有声明。所以文件写出每个内置协议键：`openai`、`anthropic`、`gemini`、`vertex-ai` 与旧键 `openai-responses`。所选协议的列表是这个服务的模型（`id`、`baseUrl`、`envKey: "LMG_TOKEN"`；OpenAI 的两种协议用逐项 `wireApi` 区分；能看图的带 `generationConfig.modalities.image`），其余是空列表。
- **`.env` 改不了条目的地址与密钥。** 逐字段的顺序是所选 `modelProviders` 条目、命令行、环境变量、设置（`modelConfigResolver.ts`）。`model.name` 与 `model.baseUrl` 也写在系统设置里。
- **辅助模型与档位。** `fastModel`、`visionModel`、`compactionModel`、`advisorModel`、`imageModel`、`voiceModel`、`modelFallbacks` 写成空串，`agents.builtin.exploreModel` 写 `inherit`。`agents.modelGrades` 是浅合并、删不掉用户的键，所以写 `agents.allowedGrades: []`：空白名单下没有可用档位。
- **关掉子 Agent。** 用户自己起名的服务 ID（按键合并，只能加不能删）与内置的 Qwen OAuth 模型没有官方办法去掉，而子 Agent 的定义文件可以用 `model:` 点名任何模型并另建请求通道（`subagent-manager.ts` 的 `resolveModelRoute`）。所以文件写 `permissions.deny: ["Agent"]`：各层的拒绝规则取并集，用户设置拿不回去。内置的 Explore 也没有。
- **主模型。** 模型值是它的 ACP 写法 `<模型>(<协议>)`；`wireApi: "responses"` 的条目虽写在 `openai` 列表里，却列成 `<模型>(openai-responses)`。只提供它实际报告的精确值；同 ID 多条目时它改用不透明的 route ID，那样的模型不提供。
- **换模型**只走 `session/set_config_option`，带 `_meta["qwen.session.modelPersistDefault"]: false`。只报告旧式 `models` 的版本在经 Latch 的会话里不能换模型（501）：`session/set_model` 会写用户的设置。Latch 不调用 `authenticate`。
- **没有改动的。** 用户的钩子（`prompt` 钩子可以带 `model`）、`tools.webSearch.model`、`batch.model`、实验性的 `experimental.liveVoice` 与 `omni` 各有自己的条目或地址，不是这个会话的模型路线。钩子不关：其中可能有用户自己的防护。

### goose

依据是 goose 的公开源码与文档，在 1.57.0 与 1.59.0 两个版本里核对过（括号里是它仓库里的路径）。这两个版本的源码里没有 lead/worker 与 planner 的模型设置。

- **只用环境变量。** goose 先读环境变量、再读配置文件；密钥先读环境变量、再读钥匙串（`crates/goose/src/config/base.rs` 的 `get_param`）。Latch 设 `GOOSE_PROVIDER` 与 `GOOSE_SUBAGENT_PROVIDER`（`openai` 或 `anthropic`）、`GOOSE_MODEL` 与 `GOOSE_SUBAGENT_MODEL`、`GOOSE_TOOLSHIM=false`（工具垫片会把回复发给用户本机的解释模型）、`OPENAI_HOST`（不带版本的地址）与 `OPENAI_BASE_PATH`，或 `ANTHROPIC_HOST`。没有私有文件，参数不变。
- **路径。** `OPENAI_BASE_PATH` 对 Responses 写 `v1/responses`，对 Chat 写 `/v1/chat/completions`。goose 把恰好等于默认值 `v1/chat/completions` 的路径当作未指定，再按模型名决定是否改走 Responses；带前导斜杠的算显式路径，固定为 Chat（`crates/goose-providers/src/openai.rs` 的 `should_use_responses_api`）。
- **不传 `_meta.provider`。** `session/new` 带上它时，goose 用该服务的默认模型而不是 `GOOSE_MODEL`，请求会被网关拒绝。模型经 `model` 选项按会话设置；`provider` 选项在经 Latch 的会话里隐藏并拒绝设置。Latch 不调用 goose 的 `_goose/*` 配置方法。
- **为什么是实验性。** `delegate` 启动子 Agent 时，服务按「配方的 `settings.goose_provider`、环境变量 `GOOSE_SUBAGENT_PROVIDER`、调用参数 `provider`」的顺序取（`crates/goose/src/agents/platform_extensions/summon.rs`）；带 `model` 的 agent 来源还会把模型自己传的 `provider` 写进配方设置。配方来自项目的 `.goose/recipes`、`.agents/recipes`、`GOOSE_RECIPE_PATH` 与家目录。没有文档化的设置能固定或关掉这一点：这样的子 Agent 用用户在 goose 里另配的服务，按轮的核对发现不了。

### Grok Build

依据是官方文档 [docs.x.ai/build/settings](https://docs.x.ai/build/settings) 与 1.0.77 的实际行为，没有读它的源码。

- **自定义模型只在用户配置里。** `[model."<id>"]` 写 `model`、`base_url`、`env_key` 与 `api_backend`（`chat_completions`、`responses`、`messages`）；`[models]` 的 `default` 是会话模型，`web_search` 也指向它。配置在 `$GROK_HOME/config.toml`，没有另指配置文件的参数；项目的 `.grok/config.toml` 只管 MCP、插件与权限规则。
- **会话私有的家。** `GROK_HOME` 指向会话私有目录，里面只有 Latch 写的 0600 `config.toml`（模型 ID 与地址按 TOML 字符串转义，凭据只写变量名）。用户自己的 Grok 登录、钩子、插件、MCP 与托管配置都不在这里；没有登录，xAI 自己的模型答不了，不经网关的请求没有去处。
- Grok 的会话记录也写在这个目录，进程重启后凭它恢复，随 Latch 会话删除。
- 它起标题时用内置模型向同一地址发请求，网关拒绝（403），它改用截断的用户文字。启动时拉取 xAI 模型目录因没有登录而失败，不影响会话。
- 它对流的字段更严：Chat 的块要有 `created`，Responses 的 `response` 要有 `created_at`。

### pi 运行预算

pi 的模型注册 API 必须有输入上下文与输出上限。

- 私有扩展优先用已安装 pi 的公开目录里模型 ID 与协议都精确匹配、且边界一致的数值；没有精确值时不推测。
- 可以在这个 Harness 的高级环境里写 `PI_GATEWAY_CONTEXT_TOKENS`（1–16777216）与 `PI_GATEWAY_OUTPUT_TOKENS`（1–1048576）：两个都要，都是正整数，输出不大于上下文，否则 400 `invalid-gateway-budget`。改动后启动指纹变化。
- 缺少有效预算的未选模型不注册；所选模型缺少预算时拒绝开始。
- 这是适配器的运行预算，不是模型的标称容量，不产生价格或余额。pi 强制要求的价格字段只是内部占位；经服务的会话不把它们或运行预算变成 Agent 报告的费用与上下文容量。

扩展的其余规则：

- 凭据只留在进程内存，并从子进程继承的环境里删除。pi 恢复会话时重新加载扩展，同一进程的扩展实例从自己的私有槽取回凭据；新进程总由 Host 重新发放。扩展数据文件不含凭据。
- 只为私有 provider 注册官方 streamSimple 委托，沿用官方 SDK 的消息、工具、推理回放与取消转换，覆盖普通回复、压缩与分支摘要。
- 每次请求以 `options.reasoning` 为准；在原 `onPayload` 回调之后核对模型并限制输出上限，回调删掉上限也消除不了运行预算。payload 失配在发网前失败。
- 服务可以用自己的模型别名，不靠改模型 ID 触发 SDK 的型号判断。

## 调度

网关与内置 Harness 共用一个调度器（`model-scheduler.ts`）：同一份候选规则、错误分类、重试、健康与并发上限。内置 Harness 不经回环端口，它的每个服务 Provider 在注册时被包一层（`scheduled-provider.ts`）直接调用调度器。调度器从不自己发请求，健康只来自真实请求。时限与阈值在 `SCHEDULE`。

新会话用哪个模型见 [MODEL-CONFIGURATION.md](MODEL-CONFIGURATION.md#默认模型)。

### 候选

每个模型可以有「出错时改用」：至多 4 个已保存服务的模型，按顺序，可以是别的服务的同名模型、别的模型或本服务的另一个模型。没有设置的模型只有自己一个候选。

**保存**

- 要 `admin`，不弹本机确认：每个候选都是已确认地址的服务。
- 只核对这次请求送来的列表里每一项都指向已保存的模型。已保存的列表里指向已删除服务或模型的项在下次保存时丢掉；删除服务或移除模型时也从别的服务的列表里清掉。悬空的项从不妨碍改名、停用或清除密钥。
- 审计 `provider.fallbacks.changed`（服务 ID、变动的模型数、新列表指向的服务 ID、是否放宽；没有模型名）。新增或调整顺序是放宽，审计写不进就不保存；只移除是收紧，照常保存并带 `x-latch-audit: failed`。
- 列表与「同时请求」上限不计入服务的执行修订：保存它们不替换插件，也不使已批准的定时任务失效。

**使用**

- **经 Latch 的会话**在开始时把所选服务每个模型的备选写进 `ModelRoute.fallbacks`（服务 ID、模型、上游协议、来源），随会话持久化，计入 `routeHash` 与启动指纹；没有备选时指纹不变。入口协议不能直接说、也没有已实现转换的备选在这一步略去。之后改设置只影响新会话。
- 凭据签发时绑定每个候选当时的服务指纹。之后被停用、删除或改了地址、密钥、模型的备选只让那个候选失效并被跳过，不作废会话。
- **内置 Harness** 每轮可以换模型，它的候选在这一轮第一次请求时按当时的设置定下，这一轮内不变。
- 透传给备选时只把请求体的 `model` 改成那个服务里的名字。协议不同的备选走同一套转换；思考档位在那个模型没有声明时改用它的默认值。推理封装仍只回放给签发它的服务与模型。token 计数请求只发给会话自己的服务。

### 错误分类与故障切换

重试与切换只发生在回复的第一批字节到达之前；之后断了就是这一轮失败，从不再发一次。

分类由 `classifyStatus` 决定：正文写明余额或额度用完的先算 `quota`，其余按状态码。

| 上游的结果 | 做法 | 计入熔断 |
| --- | --- | --- |
| 请求自身的问题：其余 4xx、501、505 | 会话自己的服务：原样返回，不换候选。备选：跳过它，最后返回前一个候选的真实失败 | 否 |
| 401，或写明是密钥问题的 403 | 换下一个候选；服务标「密钥无效」一分钟，之后由真实请求再问它 | 是 |
| 其他 403（地区、账户不能用这个模型等） | 换下一个候选；不说密钥无效 | 是 |
| 服务在 Latch 里的每月预算用完（见[预算](#预算)） | 换下一个候选，没有时 402 `budget-exceeded`；没有向服务发任何请求 | 否 |
| 402，或写明余额、额度用完 | 换下一个候选；服务休息 30 分钟，休息结束后再遇到时 2 小时、8 小时、1 天。在途的请求一起遇到只算一步，休息期间再被拒不加长；成功一次回到 30 分钟 | 否 |
| 429 | 有下一个候选就换。没有时，`retry-after` 不超过 10 秒的等一次再试，否则带着 `retry-after` 原样返回。服务标「请求过多」到它要求的时间（最多一分钟） | 否 |
| 408、其余 5xx、连不上、回复开始前连接断开 | 同一服务再试两次，间隔 1 秒与 3 秒，各 ±30%；还不行换下一个候选 | 是 |
| 流式请求 60 秒内没有开始回复 | 有下一个候选就立刻换；没有就按入口协议返回超时（504 `gateway-timeout`）。超时后从不向同一服务再发：它可能还在处理第一份 | 是 |
| 已开始回复后断开 | 不换，按入口协议发流内错误 | 是 |

内置 Harness 的路径按 Provider 的错误分类：`http-error` 走上表；Provider 自己的超时算超时；`empty-response`、`invalid-content-type`、`stream-incomplete` 算服务端失败；其余算请求自身的问题。

- **首字节时限只给流式请求。** 量的是到响应头或流的任何字节（含注释与保活）的时间，不是到第一段正文。非流式请求（`stream` 不为 true、token 计数）没有首字节时限，耗时也不计入健康。
- **总时限。** 一个请求在回复开始前最多 90 秒，等位置与等名额的时间不算，到时返回最后一个错误。
- **带服务端状态的请求**（`previous_response_id`、`store: true`、`conversation`、`container`）从不发给另一个服务，只在同一服务的候选之间切换，否则返回第一个失败。
- **可能已在服务端执行过的请求不发第二次。** 请求带服务端自己执行的工具（网页搜索、代码执行、`mcp_servers` 等）或服务端状态时，只有能证明没执行的失败才允许重试或换候选：连接根本没建立、401/403、402、429。5xx、超时、发出后连接断开（含 200 之后正文一个字节都没到）原样返回。
- **会话自己的服务在运行中被改了**（第一个候选的指纹不再是服务当前的）：网关作废凭据，内置 Harness 报 `model-route-changed`。不悄悄换到下一个候选，也不写切换记录。
- **后面的候选满了**（位置或全 Host 名额等不到）：返回前一个候选的真实失败，不用 `gateway-busy` 盖住它。
- **先审计再切换。** 把请求交给另一个候选之前写 `task.model.fallback`（会话、离开的服务 ID、去往的候选序号、错误分类；没有模型名与正文）。写不进就不切换，返回当时的错误。因第一个候选被暂缓而从备选开始的请求同样先写一条。
- **会话亲和。** 一轮里换到备选后，这一轮余下的请求直接去那个备选；下一轮从第一个候选开始，除非它正被暂缓。
- **暂缓的服务排到候选末尾。** 密钥无效、休息中、请求过多的在别无选择时仍会收到真实请求；熔断中的不发。一个都不能试时 503 `gateway-circuit-open` 加 `retry-after`。
- 指纹不是服务当前值的候选不会被尝试，也不会清掉这个服务已有的记录。

### 健康与熔断

每个服务一个状态，只在不正常时出现在 `ProviderSummary.health` 与 `ProviderSettings.health`，所有设备可见，里面没有请求、回复或密钥。

| 状态 | 含义 |
| --- | --- |
| `slow` | 最近 5 次首字节的中位数是此前的 3 倍以上（至少 15 次记录） |
| `failing` | 熔断打开或正在试 |
| `quota` | 余额或额度用完，休息中 |
| `rate` | 429 |
| `key-invalid` | 密钥被拒 |

除 `slow` 外都附最近一次失败的分类与时间，并带 `until`（试探请求进行中的 `failing` 没有）：到时自己结束，由下一个真实请求重新判断。

- 熔断在连续 4 次可计失败，或 2 分钟内至少 10 个请求里一半失败时打开；60 秒内不向它发请求。429 与余额用完是账户的状态，不计入。
- 60 秒后放一个真实请求去试。它一开始回复就算成功，熔断立即关闭（回复怎么结束照常计入）；失败再开 60 秒。回复开始前客户端断开只归还名额、不改变状态。
- 服务的密钥、地址或模型变了（指纹变化）就清空它的记录。状态只在 Host 内存，重启后从空白开始。
- 「检测连接」只列模型，不影响这里的状态。

### 并发与排队

两层，先取服务的位置，再取全 Host 的名额；换候选时先归还名额。所以一个满了的服务不占别的服务要用的名额。

| | 服务的位置 | 全 Host 的名额（`model-request-queue.ts`） |
| --- | --- | --- |
| 上限 | 每个服务的「同时请求」，1–32，默认不设 | 32，内置 Harness 与网关共用 |
| 等待 | 按到达顺序，最多 30 秒 | 按到达顺序，最多 30 秒；等待队列最多 128 个请求、正文合计 64 MiB |
| 等不到 | 429 `gateway-busy`，`retry-after: 1` | 同左；队列已满时立即拒绝 |

- 名额持有到响应读完或取消结算，收到响应头不归还。取消等待立即移除；停止 Host 拒绝全部等待。
- 排队不是授权：取得名额后重新核对当前服务、地址、密钥与模型声明，凭据失效或配置变了的请求不发送旧密钥。
- 连接检测与模型列表不占名额。
- 等待时会话摘要带 `live.queued`；等某个服务自己的位置时另带 `live.queuedFor`（服务名），界面写「排队：<服务>」，等全 Host 名额时只写「排队」。这两个字段只由 Host 设置。

## 用量、花费与预算

这里说的是经 Latch 发给模型服务的请求。它与输入框旁的「额度」不是一回事：「额度」是各 Harness 自己的订阅窗口，由 Harness 报告，Latch 只显示（`packages/protocol/src/quota.ts`）。

### 用量账本

Host 每发出或拒绝一个模型请求，就在数据目录的 `gateway/usage-YYYY-MM.jsonl` 追加一行（`model-usage.ts`）。网关与内置 Harness 经同一个计量器（`model-budgets.ts` 的 `createModelMeter`）写同一份账本。

- 文件 0600，目录 0700，只追加。按 Host 电脑自己的时间分月；整月结束超过 90 天的文件在启动和换月时删除，读取时也不取 90 天之前的行。
- 上次崩溃留下的半行在下一次写入前补上换行。
- 一个 Harness 请求在上游重试或换候选仍是一行；只有最终回答的那次回复的 token 计入。
- 回复开始后中断或被放弃的请求，已读到的用量照样记下。超过读取预算的事件继续透传，用量记为未知。
- 不写：token 计数请求、模型列表、凭据或模型名不对而没到调度的请求。
- **从不记**：提示与回复的正文、工具参数与结果、推理、图片、服务密钥、`lmg1.` 凭据、任何请求头或回复头、查询串。模型名先经 `withoutKey` 与 `redactKnownSecrets` 并截到 200 字。
- 账本是用量元数据，不是审计。写不进只记一行日志，不让请求失败；读不出的行跳过并计数，汇总里如实给出。

每行的字段是 `usageLineSchema`（strict，多一个字段的行不写也不读）：

| 字段 | 含义 |
| --- | --- |
| `at` | 请求到达的时间；跨月的请求算在到达的那个月 |
| `sessionId`、`agentId`、`harness` | 会话、所属的 Agent（没有就不写）、运行它的 Harness；都来自 Host 自己的记录 |
| `providerId`、`model`、`used` | 回答的服务（没有回答时是最后问的那个，一个都没问时是会话自己的服务）、问它时用的模型名、它在回复里说的模型名 |
| `outcome`、`attempts`、`fallback` | 结果（`USAGE_OUTCOMES`）、真正发给服务的次数、是否由备选回答 |
| `firstByteMs`、`totalMs` | 到回复开始与到结束的时长 |
| `inputTokens`、`outputTokens`、`cacheReadTokens`、`cacheWriteTokens`、`reasoningTokens` | 服务报告的用量；输入含缓存、输出含推理，后三项只在服务报告时存在 |
| `cost` | 花费（百万分之一货币单位 `micros`、`currency`、`source`），只在已知时存在 |

`outcome` 是 `ok`、调度的错误分类，或 `busy`（排队超时）、`budget`（预算用完，没有发出）、`aborted`（Harness 或人放弃）。

**本月合计。** 每个月的账本旁有 `gateway/totals-YYYY-MM.json`（0600，strict）：按服务与按 Agent 的合计，只有键与数字，每写一行原子替换一次，随账本文件一起删除。

- 它记着自己覆盖的账本文件大小，只统计已写入的前缀。大小对不上、文件缺失、格式或版本不对时，从账本整月重数再写回，不设行数上限。
- 预算在运行中立即计入刚结算的请求。账本行没写成的请求只在本进程保留预算计数，重启后按账本里实际可读的行恢复。
- Host 的时钟回到本进程没读过的旧月份时异步载入那个月的合计，载入完成前的预算检查可能少计。

**每轮的记录。** 会话每轮只保存模型 ID（最多 16 个）、请求、失败与未结束数、由备选回答的请求数与那个服务的 ID、转换损耗枚举、服务报告的 token 用量，以及已知的花费与预算状态（`spend`）。账本不依赖它：一轮点名超过 16 个模型时，之后的请求照样各有一行、照样计入预算。

**整轮绕过。** 一轮有回复而没有任何请求到网关时，会话标 bypassed 并写 `task.model.bypassed`。这只能发现整轮绕过，不能证明每个辅助调用都经过网关。

### 汇总

`POST /link/api/model-usage`（`view`）按 `period`（`month`、`7`、`30`、`90`）与 `group`（`session`、`agent`、`service`、`model`）汇总：请求数、失败数（放弃的不算）、备选次数、报告了用量的请求数与它们的和、花费。

- 只加服务真实报告的数。一行里没有任何请求报告用量时没有 `usage`（界面写「未报告」而不是 0）；有的请求没报告某一项（缓存读写、推理）时，这一项整行不给。
- 一次最多读 40 万行，超过时结果带 `truncated`。预算用的合计没有这个上限。
- **会话按允许名单给。** 只有这台设备现在读得到的会话保留会话 ID；其余请求（读不了的、已删除的、没有会话的）照常计入合计，但并成一行、不带会话 ID。
- 数据范围不是 `all` 的设备拿不到任何请求的 Agent ID，也看不到 Agent 的预算。
- Host 读完账本才取当前会话名单，答复前复核设备权限、会话归属与私有状态。Web 收到权限变化的快照时立即撤下旧汇总与预算，取消在读的请求，再按当前权限重读。

### 花费

Latch 没有内置价格表，也不从 token 猜费用。花费只在两种情况下存在：

- **你给这个模型填了单价**（`source: prices`）：输入、缓存输入、缓存写入、输出四项，每百万 tokens，币种美元或人民币；缓存两项留空时按输入单价算。
- **服务在回复里报告**（`source: reported`）：Chat Completions 与 Responses 回复的 `usage.cost`，按美元记。内置 Harness 的同两种连接器读同一个字段。

规则：

- 两者都有时以你填的单价为准。服务报告的数必须是 0 到 100 美元之间的普通数字，否则不采信，这次请求的花费记为未知（tokens 照记）。
- 转换或由备选回答的请求，用回答的那个服务的模型的单价。
- 花费在写账本行时算好，之后改单价不改旧行。不同币种分开加，不换算。

### 预算

可选。每个服务、每个 Agent 至多一个每月预算：tokens（输入加输出），或某一币种的花费。月份按 Host 电脑自己的时间；没有账本的新月份从零开始。

**检查**

- **没有预留。** Agent 预算在进入调度前检查，服务预算在各候选取得服务位置后检查。预算按已结算的用量检查，所以已通过检查的请求合计可能超过预算。
- **80%**：这一轮的记录带 `spend.budget: 'near'`（经 Latch 的会话在 `turn.routed.spend`，内置 Harness 在 `turn.spend`）。会话照常继续。
- **Agent 的预算用完**：这个 Agent 的会话的请求直接拒绝，不换到别的服务。内置 Harness 的首轮归属取自 Host 校验后的创建上下文。
- **服务的预算用完**：和服务端 402 一样对待这个候选，换下一个候选前先写 `task.model.fallback`（`errorClass: budget`）；没有可用候选时拒绝。别的候选只是被熔断暂缓时回答 503 `gateway-circuit-open`，不是预算拒绝。
- **拒绝**是 402 `budget-exceeded`「本月预算已用完」，用入口协议的形状：OpenAI 形状 `error.code`；Anthropic `type: billing_error` 并带 `code`。内置 Harness 的这一轮以同一句话失败。
- **按花费的预算要算得出花费。** 设置时它覆盖的每个模型都得有这个币种的单价，否则 400 `budget-cost-unknown`。服务：它的全部模型。Agent：设定使用的服务模型及当时配置的全部备选；没有设定服务模型的 Agent 与「通用」只能按 tokens。
- 之后仍可能出现花费未知的请求（后来选用的模型、新增备选、删改了单价、服务没报告用量）：它们不计入已用，`BudgetProgress.uncounted` 给出本月次数。按 tokens 的预算不受影响。

**存储与写入**

- 单价、预算与完成回执在 `gateway/budgets.json`（0600，strict，整份原子替换）；旧文件缺修订号时按 0、缺回执时按空；不认识的字段使 Host 拒绝启动。
- `GET /link/api/model-spend`（`view`）给出当前 `revision`、单价、预算与本月已用。`PUT /link/api/model-prices` 与 `PUT /link/api/model-budgets` 要 `admin`，不弹本机确认。Agent 预算（含「通用」）还要完整数据范围 `all`，在读取目标与价格、答复已结算回执以及写入前都复核。
- **回执与冲突。** 写入带 `requestId`、`baseRevision`、目标键与完整值，`null` 清除。同一设备的同一请求回答原修订号与 `replayed: true`；同 ID 不同语义 409 `request-conflict`。新请求以上个修订为条件；写成功连同回执原子保存并推进修订号。相同值也推进修订号、留回执，但不写改动审计。
- 只留最近 256 条完成回执（身份与语义的哈希、原修订号、是否有审计失败）。回执被淘汰后，旧修订仍使同一请求被 409 `model-spend-conflict` 拒绝，不会再次应用。
- **结果未知。** 原子写未确认时 503 `model-spend-write-unknown`，留存已审核的原写入，重试须复用原请求 ID、修订与完整内容；这期间另一项写入 503 `model-spend-write-pending`，没有受理。
- **先审计再写。** `model.prices.changed`（服务 ID、模型名的哈希、变了哪几项、是否清除）与 `model.budget.changed`（服务或 Agent 的 ID、变了哪几项、是否取消、`widening`），都没有金额，actor 是发起的设备。审计后再核对一次设备权限才写入。
- **放宽与收紧。** 让人能花更多的改动（取消预算、调高上限、换单位或币种，以及任何单价改动）在审计写不进时不执行，503 `model-spend-audit-unavailable`。只会让人花得更少的（第一次设预算、调低上限）照常执行，回复带 `x-latch-audit: failed`。
- 删除服务时一并删它的单价与预算，删除 Agent 时一并删它的预算；这一步失败只记日志，不撤销删除。

## 尚未实现与没有核对的

- Chat Completions 入口到其他协议的转换尚未实现。
- Responses 的 `tool_search` 尚未转换（见「转换的共同规则」）。
- 预算拒绝（402 `budget-exceeded`）没有对着真实的 Harness 看它是否停下而不是重试。
- 真实服务的 `usage.cost` 字段与币种只用本地假服务核对过。
- Qwen Code、goose 与 Grok Build 只在没有登录的临时 HOME 下对本地假服务跑通过，没有对真实服务、带工具与多轮跑过。
- 测试确认后端与本地假模型不等于本人的系统确认或真实服务成功。测试的运行与选择见 [TESTING.md](TESTING.md)。
