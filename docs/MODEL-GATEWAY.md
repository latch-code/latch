---
description: Harness 经 Host 使用模型服务的回环入口、凭据、协议、启动交付、环境过滤，以及用量账本、花费与预算。
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

模型服务与路由保存在 Latch 的 Host 配置中。接线只使用该次请求、进程级覆盖或 Latch 私有文件，不改用户原 CLI 全局/项目配置，不注册全局 hooks。上游 setter 的持久化副作用也属于接入核对范围，见 [不修改原 CLI 配置](HARNESSES.md#不修改原-cli-配置)。

生成网关文件时，Host 检查受管临时根、会话目录和网关子目录本身。若发现链接、属主或权限无效，先拒绝写入和启动，已申请的网关租约随拒绝释放。会话移除及临时探测清理也检查受管根，避免沿已有目录链接删到外部路径。这项检查针对已有重定向，运行中的本机 CLI 仍按自己的权限执行。

Host 为经 Latch 使用模型服务的 Harness 提供单独的回环临时端口。它只有模型路径，不是设备 API；每个 Agent 进程拿一个 `lmg1.` 凭据，Host 内存只保存其哈希，凭据绑定会话、服务、协议和模型列表。服务的真实密钥留在 Host，只发往已确认的服务源与路径，经与内置 Harness 相同的出站策略。

## 协议与请求

四种入口优先同协议透传；Responses 与 Anthropic Messages 入口另可转换到 Chat Completions，两者之间也可互转。其他跨协议方向尚未实现；候选、故障切换与健康见「调度」，账本、花费与预算见「用量、花费与预算」：

| 入口 | 模型请求 | 模型列表 |
| --- | --- | --- |
| Responses | `POST /v1/responses` | `GET /v1/models`，OpenAI 形状 |
| Chat Completions | `POST /v1/chat/completions` | 同上 |
| Anthropic Messages | `POST /v1/messages`、`POST /v1/messages/count_tokens` | `GET /v1/models`，Anthropic 形状 |

凭据只开放自己协议的路径。模型列表只返回绑定的服务模型，不访问上游；请求体最多 32 MiB，模型必须在绑定列表里。Chat 流式请求未指定 `stream_options.include_usage` 时补为 true，明确给出的值不覆盖；其他正文保持原样。

只接受预期回环 Host，不接受 Origin、浏览器的 Sec-Fetch-Site/Dest/User 等标记或未知 Sec-Fetch 字段；兼容 Node fetch 单独发送的 `Sec-Fetch-Mode: cors`。这个传输标记不构成身份验证，仍须有效进程凭据，不返回 CORS 头。入站认证、Cookie 和未列出的头不转发。Chat/Responses 只转发 accept、openai-beta；Anthropic 同协议透传另外保留 anthropic-version、anthropic-beta。回复只保留 content-type、retry-after、x-request-id、request-id，保留的值也脱敏。

读取完整请求体后，发出请求前再次核对进程凭据和服务指纹；上传期间撤销或变更的请求不转发。上游不跟随重定向。错误正文最多读取 64 KiB，去掉真实密钥的原文、JSON 转义、URL 编码和截断尾部等形式后返回；成功状态的 JSON 与 SSE 也可能包含错误，沿流跨字节块脱敏，只暂存可能的密钥前缀。日志经过 Host 秘密脱敏。下游断开时中止上游请求。开始回复后断流记录为未完成，不重发、不回退到其他服务或演示模型；同协议透传的事件流以入口协议的流内错误结束（Responses 的 `response.failed`、Anthropic 的 `error` 事件、Chat 的 `error` 数据），不再安静地收尾。

### Responses 转 Chat

Responses 入站先核对完整调用图：call_id 不得复用，每个 function/custom 调用必须有且只有一个同种类结果，结果未齐前不得开始用户或系统消息。孤儿结果、漏结果、错配种类、畸形或非有限参数在出站前以 400 拒绝。函数参数以及工具和输出 schema 的有限数字保留原始 JSON 词元，不改写大整数、长小数或 -0。

入口和上游分别绑定在凭据上。`ModelRoute.wire` 是 Harness 入口；可选的 `upstream` 是服务协议，旧记录缺省时与入口相同。Host 通过 `pairRoute` 重算，网关再次核对已实现的 `TRANSLATED_PAIRS` 与服务协议、来源；不会把一个入口的凭据开放给另一个入口。转换路线始终标记实验性。

转换使用网关自己的类型化条目，不改变 Standard 的 `ModelMessage`。保留系统说明、消息、图片、函数定义、工具调用与结果、并行与指定工具选择、明确的思考档位和输出上限。命名空间与长工具名在 Chat 中编码为稳定名称，回来时恢复原名称和 namespace；自定义工具改成只含 `content: string` 的函数，再恢复原始 `custom_tool_call.input`。语法约束只作为说明传给服务，不能声称仍被强制执行。网关自己不执行工具。

图片 data URL 与 HTTP(S) URL 直接作为内容交给模型服务，网关不下载 URL。Chat 的工具结果只发文字；工具图片排在同批全部工具结果之后的 user 消息中，逐组注明对应调用及「不是用户发送的」，并记录 tool-image-location 损耗，不能声称原始消息位置仍保留。文件、PDF、服务端会话引用、`store: true` 与多个候选明确拒绝；未支持的执行型历史条目也拒绝，不能悄悄删除后继续。服务端工具不由 Host 代执行，当前 Chat 转换略去其定义；概率详情、引用标注等不转换的内容计入闭合损耗枚举。菜单的转换说明给出可能受限的能力，每轮 `routed.dropped` 只记录本轮实际遇到的枚举，不含正文。

Chat 流强制请求末尾用量。每条流独立维护有界状态，处理 UTF-8 分块、交错并行调用与结束后的 usage，输出完整的 `response.output_item.done`。工具参数与所有工具身份都核对后才给可执行的 done；同一工具索引的 ID 与名称一旦报告就不能变化，重复相同值兼容；达到输出上限或内容过滤时不发布未完成工具的 done。模型断流、畸形输出或流内错误返回 `response.failed`，不能变成空成功，也不重试或回退。429 与 retry-after 保留；上游过载改为 503，上下文超长保留 `context_length_exceeded`。

Chat 的 `reasoning_content` 以 `latch2.` 封装在 Responses 的 `encrypted_content` 中。它是带 HMAC 的来源封装，不是加密；签名 key 只在当前 Host 内存，签名绑定同一上游协议、服务和模型。合法回放覆盖历史中的各个助手步骤，跨协议、跨服务、跨模型、篡改、外来封装与 Host 重启前的封装都剥离并记录损耗。重启后不能承诺仍满足要求完整旧思考的服务；这样的服务可能拒绝旧上下文，须重新开始或清空上下文。封装前先脱敏，函数参数先核对对象、嵌套上限和有限数值，再逐个解码并脱敏 JSON 字符串词元；数字与未修改的词元保留原样。错误也在增加 JSON 转义层之前脱敏，避免编码隐藏密钥。不会持久化签名 key 或正文账本来恢复封装。

网关 IR 分开表示 Chat 可读思考、Responses 原生推理项（原生 ID、加密内容、摘要、可读思考与完成状态）和 Anthropic 原生 thinking/signature、redacted_thinking/data。原生状态不能转换成 Chat 的文字思考。不透明内容命中脱敏规则时拒绝封装，不通过改写生成无效密文；Anthropic 的可读思考也在原生签名覆盖范围内，命中脱敏时同样拒绝。封装版本只在当前 Host 生命周期内有效，重启前的旧版本同样剥离。

Responses 的 `tool_search` 尚未转换，包括 `execution:client` 的本机工具发现；当前与服务端工具一样略去定义并记录 `hosted-tools` 损耗，不能据此声称 MCP 工具可用。Codex 0.167.0 可把 MCP 工具延迟到这一步才提供，所以即使服务已连接，Responses 转 Chat 或 Anthropic 的路线也可能无法发现这些工具；同协议 Responses 透传保留原生发现调用与目录，仍需上游支持这个协议。命令工具可用不等于提议、技能或浏览器 MCP 已验证。

### Anthropic Messages 转 Chat

入口使用同一份网关类型化条目与 Chat 编解码器。保留系统和会话中途的系统文字、用户图片、完整的工具调用与结果、错误结果标记、工具选择、并行开关、输出上限、stop sequences 与明确的 effort；effort 仍须在服务的声明中。工具结果图片沿用有归属说明的移动规则。PDF、未知内容块、服务端工具、缺少对应调用或结果的历史、服务端容器和压缩状态明确拒绝。缓存、引用和协议专用选项的实际损耗沿用闭合枚举；固定 thinking token 预算不能变成 Chat 的离散 effort，计入协议专用选项损耗。

CLI 使用这条转换时启用官方 `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`，不把服务端工具搜索、context management 等尚未转换的功能发送给 Chat。其他来源仍按收到的内容严格检查，不能通过略去执行型历史条目继续。转换不表示模型是 Claude，也不按 Chat 协议猜测模型厂商。

回复按 Anthropic SSE 的 message/content-block 顺序发送文字和思考。思考的 signature 使用同协议、同服务、同模型的 `latch2.` 来源封装；外来或重启前的 signature 不重放。封装不是加密，所以显式 `thinking.display: omitted` 请求在出站前拒绝，不能只藏文字却仍在 signature 里返回明文。两种转换输出都在发布前核对本次工具约束：none 不得调用、指定工具按名称/命名空间/function或custom身份精确匹配、parallel=false 至多一个调用；正常完成却未满足 required 或指定工具时拒绝，截断/过滤仍保持原本的不完整状态。全部工具身份与参数都验证后才发布任何可执行的 tool_use 块；输出截断、过滤、畸形调用或断流不发布未完成工具。脱敏会改变工具 ID 或名称时整组拒绝，避免把不同调用变成同一身份；此规则也适用于 Responses 输出。

工具参数的对象与 JSON 字符串互换时，用 Node 24 标准 JSON source/rawJSON 保留有限数值的原始词元，包括大整数、长小数和 -0；共用的参数检查仍限制嵌套、非有限数值与脱敏后的键冲突，只改动字符串词元。Anthropic 回复要求用量字段：message_start 的零值仅作流开始时的暂存，最终 message_delta 必须使用上游实际 usage；缺少 usage 时返回错误且不发布工具或 message_stop。Host 的用量始终取上游证据，不计暂存值。429 与 retry-after 保留，错误使用 Anthropic 形状；取消中止上游，不重试或回退。

模型 ID 完全匹配服务清单，不去掉 `models/` 之类的前缀。

### Anthropic Messages 转 Responses

使用同一有界 IR 发送完整历史，`store: false`，不采用服务端会话、之前的 response ID 或压缩状态。系统消息保留原来的位置，工具调用按 call_id 配对；工具结果里的图片直接保留在对应 function_call_output 中，不标记图片位置损耗。未指定严格模式的工具显式发送 strict=false，避免 Responses 自动重写调用 schema；Anthropic 的 JSON Schema 输出发送 strict=true。停止序列没有对应字段，在出站前拒绝。

Responses 的文字增量与最终内容前缀、输出项身份和索引逐项核对；未完成、被过滤、缺少用量或矛盾的输出都不能释放可执行工具。原生思考保留 id、encrypted_content、summary、可选 content 和状态，经同协议的来源封装放进 Anthropic signature；没有可读文字时用 redacted_thinking.data。封装只验证来源，不把摘要当作原生思考状态，也不伪造加密。密文迟至 response.completed 才到时，有界暂存其后的输出以保留顺序；正常完成却没有原生状态时拒绝，不能悄悄丢掉工具循环依赖的思考。到达完成事件后结束读取并取消仍保持连接的上游；下游取消也中止上游，不重试。

服务端工具、异步/程序触发的调用与未请求的命名空间不会被误认为本地工具。回复和入站历史继续使用共用的工具身份、参数、选择约束、数字词元保真与秘密脱敏规则。

### Responses 转 Anthropic Messages

出站使用与内置 Provider 相同的 `anthropic-version: 2023-06-01`。完整历史转换成 Messages：开头的系统说明放入 `system`，中途的系统说明保留原来位置，不挪到开头；目标模型不支持时由上游拒绝。相邻助手条目合成一个有序内容块列表，保留空文字块、原生思考、调用顺序；工具结果中的文字和图片留在对应 `tool_result`。命名空间与 custom 工具沿用同一个确定性名称映射和 JSON content 包装，数字词元保留原样。

明确的 `max_output_tokens` 转为 `max_tokens`，没给时采用有界的 8192 默认值。`none` 思考转为 disabled，其余已由服务声明的 effort 转为 adaptive 与 output_config.effort；不猜测固定思考预算，也不因强制工具和思考组合被模型拒绝而放宽约束。temperature 大于 1、json_object 输出格式在出站前拒绝；JSON Schema 转为原生结构化输出。图片的明确精度选项没有对应字段，计入协议专用选项损耗，不移动图片。

流按 message_start、逐块 start/delta/stop、message_delta 和 message_stop 验证身份、索引、类型与完成顺序。原生思考直到签名完整才封装进 Responses encrypted_content；它仍是来源封装而不是加密，完整 thinking/signature 和 redacted_thinking/data 在同服务、同模型、同 Host 生命周期中原样回放。正常完成缺少签名时拒绝；截断时记录思考状态损耗，不伪造签名。输出上限、上下文窗口耗尽或过滤保留 incomplete，全部工具都不发布；服务端执行块、pause_turn 与未知事件拒绝。

完成必须有上游最终累计用量：输入总数是 input_tokens、cache_read_input_tokens 与 cache_creation_input_tokens 之和，缓存读写仍分别保留，输出使用最终 output_tokens。用量倒退、溢出、缺失、断流或任何工具身份/参数/选择约束失败时，不发布可执行的工具 done。message_stop 后取消仍保持连接的上游；下游取消同样中止上游，不重试或回退。

## Harness 交付

| Harness | 当前网关路线 |
| --- | --- |
| Codex 直连 | 至少 0.167.0；自定义 `latch` provider 使用 Responses 入口，可接同协议服务或转换到 Chat、Anthropic；凭据从 `LMG_TOKEN` 读取，参数只有地址、变量名和公开选项 |
| codex-acp | `providers/set`，仅在适配器声明并列出对应 provider/API 类型时使用；凭据经 ACP 头字段 |
| OpenCode | 经网关至少 2.2.6；私有 `providers.latch` 配置与 shell hook；四种同协议服务 |
| DeepSeek Harness | 至少 0.2.2-rc.1；私有 Cordis patch 配置 llm provider、ACP 与默认模型；四种同协议服务 |
| Claude Agent | 适配器实际运行的 Claude Code 至少 2.1.318；Anthropic 同协议服务与实验性 Chat、Responses 转换；官方环境变量控制路由、模型发现与子进程凭据清理 |
| pi | 经网关至少 1.5.0；私有扩展调用官方 `registerProvider`，只在当前进程注册模型；四种同协议服务 |
| Qwen Code | 实验性，经网关至少 0.26.8；`QWEN_CODE_SYSTEM_SETTINGS_PATH` 指向会话私有系统设置，`modelProviders` 条目用 `envKey: LMG_TOKEN`；Chat、Responses、Anthropic 同协议服务；没有子 Agent |
| goose | 实验性，经网关至少 1.57.0；只用它文档里的环境变量，凭据在它的 provider 规定的 `OPENAI_API_KEY` 或 `ANTHROPIC_API_KEY`；Chat、Responses、Anthropic 同协议服务 |
| Grok Build | 实验性，至少 1.0.77；`GROK_HOME` 指向会话私有的家目录，`config.toml` 里每个服务模型一个自定义模型，`env_key = "LMG_TOKEN"`；Chat、Responses、Anthropic 同协议服务 |

Antigravity 与 Cursor 不接受别人的模型服务地址，只用自己的模型；未知的自定义命令同样。订阅登录不进入网关。**经 Latch 的会话不需要 Harness 自己的登录**：上表每一行都在空的临时 HOME 下、不带任何登录，对本地假服务真实跑通过一轮（Codex 0.167.0、pi 1.5.0、OpenCode 2.2.6、DeepSeek Harness 0.2.2-rc.1 各一种协议，Qwen Code 0.26.8、goose 1.57.0、Grok Build 1.0.77 各三种协议；`apps/host/test/gateway-no-login.live.test.ts`，按 `LATCH_NO_LOGIN_<ID>` 指名程序才运行）；Claude Agent 见它自己的一节。使用 Harness 自己的模型时仍由它原生处理，要它自己的登录。

Profile 的 launch 交付统一返回环境变量、参数、私有文件与公开的会话 metadata；文件以 0600 原子替换，只能写地址、模型、公开配置和变量名，不能含网关令牌。令牌只由 runtime 注入允许的环境变量（profile 的 `tokenEnv`，或按协议的 `tokenEnvByWire`：goose 的 provider 规定了变量名）；profile 写出没有列在 `envNames` 里的变量时拒绝启动。启动指纹覆盖 profile 版本、交法、变量名及参数/文件/会话模板版本，不含临时端口或令牌。新进程仍在全部异步准备后复查命令、项目与授权；准备失败会撤销已经创建的凭据。模式换档参数、权限插件与网关参数共同传入。网关声明最低版本时，初始化后还核对 Agent 报告的版本；没有协议版本报告时取官方命令的版本读数，两者都无法确认就拒绝开始。dsh 的 ACP 固定报告应用内部版本 0.0.1，与发行版本无关，所以它只接受已核对的官方命令版本证据。自定义包装命令不能靠跳过官方版本查询绕过网关门槛；普通原生模型路线保持原有版本策略。

Codex 在开线程和恢复线程前，以相同 cwd 调用官方 `config/read`，只投影有效的命令环境过滤规则。旧 exclude/include_only 与新 filters 保持原表示，只额外排除 LMG_TOKEN；大小写冲突、混合表示、畸形或读取失败均拒绝开线程。不复制 set 或其他配置值，不读写 Codex 私有文件。规则通过线程 config 覆盖，既有规则不会被启动参数的数组替换。每次 turn/start 仍给出当前模型与权限。经网关的模型列表取服务声明，允许 Codex 原生目录之外的模型；导入历史仍经 thread/list/read，并包含自定义 provider 的线程。


OpenCode 的公开启动配置同时设置主模型与小模型，保留原权限与 Agent 档位。模型值采用 `latch/<模型>`；它自己的原生模型路线保持兼容 1.x。会话私有插件使用官方 `shell.create.before` hook 清空工具子进程的 LMG_TOKEN 值；2.2.6 的环境合并会保留空变量名，因此不把它说成变量不存在。插件目录与源码属于 profile 的启动行为和版本指纹。

DeepSeek Harness 的网关 patch 与权限服务 patch 同时交付。Chat、Responses、Anthropic 使用私有 `latch-gateway` provider；会话日志与包清单遥测插件在这条路线关闭；工具子进程的敏感变量清除由 dsh 自身提供。配置值严格解码为该协议指定的 provider 与模型二元组，恢复不接受其他 provider 的同名模型。该版本 ACP initialize 不声明图片输入，所以模型支持图片也不等于可以经这个 ACP 入口发送图片。

Codex 经网关时，思考的「默认」指模型服务默认；它自己的 `model_reasoning_effort` 可能仍被原生请求补成 medium 等值，不代表人在 Latch 选了该档位。wire 用 Host 内部租约的 `setThinking(model, effort)` 明确登记当前模型意图：null 为默认，出站只删除该模型请求的 `reasoning.effort`，保留 summary、其他字段和数字词元；显式选择只允许服务声明的档位，实际请求必须匹配。其他模型及未登记意图的租约仍按原规则校验，不能借此放宽整个服务。菜单只列默认和该模型已声明的档位，不读取 Codex 原生模型的档位来猜网关模型。

明确选择随已有会话 config 持久化，恢复后优先于 Codex 的旧配置，并在实际下一轮传入。运行中选择只保存下一轮意图，不能改当前工具循环的绑定；普通提示或原生命令真正开始时才更新。换模型清掉原模型选择。原生命令的上下文核对仍比较 Codex 实际设置，尚未应用的显式改档不能用 compact 绕过。

工具与原生能力仍由 Codex 决定。0.167 的目录外模型使用它自己的后备描述，不提供独立的 custom apply_patch；它仍可沿原生命令工具执行 apply_patch。Latch 不改模型 ID 来套用另一个型号的能力，不把后备描述中的容量当作服务声明。可直接使用 Responses 的服务优先透传，不能把某一家服务固定视为必须转换。

### Qwen Code

以下每一条都出自 Qwen Code 的公开源码与文档（0.26.8 与 0.27.3 两个版本里都核对过）；0.26.8 在没有登录的临时 HOME 下经三种协议各跑通一轮。没有对真实服务、带工具跑过，所以仍标「实验性」。

- **系统设置最后合并。** 路径由官方的 `QWEN_CODE_SYSTEM_SETTINGS_PATH` 指定（`docs/users/configuration/settings.md`）；合并顺序是系统默认、用户、项目、系统设置，后者覆盖前者（`packages/cli/src/config/settings.ts` 的 `mergeSettings`）。Latch 每次启动在会话私有目录原子写入 0600 的设置文件，文件不含凭据。
- **列表整体替换，空列表也是。** 合并按键递归，数组只有声明了 `CONCAT`、`UNION` 的才拼接，其余由后者替换（`packages/cli/src/utils/deepMerge.ts`）；`modelProviders` 以下没有声明合并策略（`settingsSchema.ts`，`getMergeStrategyForPath` 对它的子键返回空）。所以文件写出每个内置协议键：`openai`、`anthropic`、`gemini`、`vertex-ai` 与仍可读的旧键 `openai-responses`。所选协议的列表是这个服务的模型（`id`、`baseUrl`、`envKey: "LMG_TOKEN"`，OpenAI 的两种协议用逐项 `wireApi` 区分，服务声明能看图的带 `generationConfig.modalities.image`），其余是空列表，这个人在这些键下的条目在这个进程里都不存在。
- **`.env` 改不了条目的地址与密钥。** 逐字段的顺序是所选 `modelProviders` 条目、命令行、环境变量、设置（`packages/core/src/models/modelConfigResolver.ts`）：条目自己的 `baseUrl` 与 `envKey` 排在 `OPENAI_BASE_URL` 这类变量之前，项目或家目录的 `.env` 也只补没设的变量。`model.name` 与 `model.baseUrl` 同样写在系统设置里。
- **辅助模型与档位。** `fastModel`、`visionModel`、`compactionModel`、`advisorModel`、`imageModel`、`voiceModel`、`modelFallbacks` 写成空串（它们的默认值，`settingsSchema.ts`），`agents.builtin.exploreModel` 写 `inherit`（默认值）。`agents.modelGrades` 是浅合并，删不掉这个人的键，所以写 `agents.allowedGrades: []`：它是文档化的白名单，空白名单下没有可用档位（`packages/core/src/subagents/subagent-manager.ts` 的 `getAvailableModelGrades`）。
- **删不掉的两条路，和因此关掉的子 Agent。** 这个人自己起名的服务 ID（经 `providerProtocol` 映射，按键合并，系统设置只能加不能删）和内置的 Qwen OAuth 模型（文档写明不能覆盖）没有官方办法从这个进程里去掉。会话的主模型选不到它们（见下一条），但子 Agent 的定义文件可以用 `model:` 点名任何模型并为它另建请求通道（`subagent-manager.ts` 的 `resolveModelRoute`）。所以文件写 `permissions.deny: ["Agent"]`：规则名是 Agent 工具在权限规则里的名字（`packages/core/src/permissions/rule-parser.ts`），各层的拒绝规则取并集（`settingsSchema.ts`），这个人的设置不能把它拿回去。经 Latch 的 Qwen Code 会话因此没有子 Agent，内置的 Explore 也没有。
- **主模型。** 模型值是 Qwen Code 的 ACP 自己的写法 `<模型>(<协议>)`（`packages/cli/src/utils/acpModelUtils.ts`）；`wireApi: "responses"` 的条目虽然写在 `openai` 列表里，却按它的实际协议列成 `<模型>(openai-responses)`（文档 `model-providers.md`；真实运行里见到，起初因此一个模型都选不到）；只有它实际报告的精确值才提供，同 ID 多条目时它改用不透明的 route ID，那样的模型不提供。换模型只走 `session/set_config_option`（`acpAgent.ts` 里它以 `persistDefault: false` 调用），并带 `_meta["qwen.session.modelPersistDefault"]: false`；报告旧式 `models` 的版本在经 Latch 的会话里不能换模型（501），因为 `session/set_model` 会写这个人的设置。Latch 不调用 `authenticate`。
- **没有改动的。** 这个人的钩子（`prompt` 钩子可以带 `model`）、`tools.webSearch.model`、`batch.model`、实验性的 `experimental.liveVoice` 与 `omni` 各有自己的条目或地址，是这个人另外配置的功能，不是这个会话的模型路线；Latch 没有关掉钩子，因为其中可能有这个人自己的防护。
- **凭据。** 只在环境变量 `LMG_TOKEN`，发请求时按 `envKey` 读取；工具子进程继承它，见 [HARNESSES.md](HARNESSES.md#经-latch-使用模型服务)。

### goose

出自 goose 的公开源码与文档（1.57.0 与 1.59.0 两个版本里都核对过）；1.57.0 在没有登录的临时 HOME 下经三种协议各跑通一轮。

- **只用环境变量，不需要登录。** goose 先读环境变量、再读配置文件；密钥先读环境变量、再读钥匙串（`crates/goose/src/config/base.rs` 的 `get_param`）。Latch 设 `GOOSE_PROVIDER` 与 `GOOSE_SUBAGENT_PROVIDER`（`openai` 或 `anthropic`）、`GOOSE_MODEL` 与 `GOOSE_SUBAGENT_MODEL`、`GOOSE_TOOLSHIM=false`（工具垫片会把回复发给这个人本机的解释模型）、`OPENAI_HOST`（不带版本的地址）与 `OPENAI_BASE_PATH`，或 `ANTHROPIC_HOST`；凭据由 runtime 放进 `OPENAI_API_KEY` 或 `ANTHROPIC_API_KEY`。没有私有文件，参数不变。
- **路径。** `OPENAI_BASE_PATH` 对 Responses 写 `v1/responses`，对 Chat 写 `/v1/chat/completions`：goose 把恰好等于默认值 `v1/chat/completions` 的路径当作「未指定」，再按模型名决定是否改走 Responses；带前导斜杠的同一地址算显式路径，固定为 Chat（`crates/goose-providers/src/openai.rs` 的 `should_use_responses_api`）。
- **不传 `_meta.provider`。** `session/new` 带上它时，goose 用该服务的默认模型而不是 `GOOSE_MODEL`（`crates/goose/src/model_config.rs` 的 `resolve_provider_and_model_config`）：第一次真实运行里它因此去请求自己的默认模型，被网关拒绝。模型经 `model` 选项按会话设置；`provider` 选项在经 Latch 的会话里隐藏并拒绝设置。Latch 不调用 goose 的 `_goose/*` 配置方法。
- **为什么是实验性。** `delegate` 工具启动子 Agent 时，服务按「配方的 `settings.goose_provider`、环境变量 `GOOSE_SUBAGENT_PROVIDER`、调用参数 `provider`」的顺序取（`crates/goose/src/agents/platform_extensions/summon.rs` 的 `resolve_provider_config`），带 `model` 的 agent 来源会把模型自己传的 `provider` 写进配方设置（同文件 `build_recipe_from_agent`），于是也排在环境变量之前；配方来自项目的 `.goose/recipes`、`.agents/recipes`、`GOOSE_RECIPE_PATH` 与家目录。没有文档化的设置能固定或关掉这一点：这样的子 Agent 用这个人在 goose 里另外配置的服务，按轮的核对发现不了。1.57.0 与 1.59.0 的源码里没有 lead/worker 与 planner 的设置（`GOOSE_LEAD_*`、`GOOSE_PLANNER_*` 在 1.59.0 全树无匹配）。
- **凭据。** 变量名是 goose 规定的，工具子进程继承它，会读这些变量的工具可能把它发给真实厂商，见 [HARNESSES.md](HARNESSES.md#经-latch-使用模型服务)。

### Grok Build

出自官方文档 [docs.x.ai/build/settings](https://docs.x.ai/build/settings) 与 1.0.77 的一次真实运行，没有读它的源码。

- **自定义模型只在用户配置里。** `[model."<id>"]` 写 `model`、`base_url`、`env_key` 与 `api_backend`（`chat_completions`、`responses`、`messages`），`[models]` 的 `default` 是会话模型，`web_search` 是它自己的网页搜索工具用的模型，也指向会话模型。配置在 `$GROK_HOME/config.toml`，`--help` 里没有另指配置文件的参数；项目的 `.grok/config.toml` 只管 MCP、插件与权限规则。
- **会话私有的家。** Latch 把 `GROK_HOME` 指向会话私有目录，里面只有它写的 0600 `config.toml`（模型 ID 与地址按 TOML 字符串转义，凭据只写变量名 `LMG_TOKEN`）。这个人自己的 Grok 登录、钩子、插件、MCP 与托管配置都不在这个家里：没有登录，xAI 自己的模型在这里答不了，所以不经过网关的请求没有去处。Grok 的会话记录也写在这个目录，进程重启后凭它恢复，随 Latch 会话删除。
- **真实运行里见到的。** Chat、Responses 与 Anthropic 各跑通一轮。它给会话起标题时用内置的 `grok-4.6` 向同一个地址发请求，网关拒绝（403），它改用截断的用户文字；启动时拉取 xAI 的模型目录因为没有登录而失败并重试，不影响会话。它对流的字段比别的客户端严：Chat 的块要有 `created`，Responses 的 `response` 要有 `created_at`（测试用的假服务原先没有，已补上；真实服务都有）。

### Claude Agent

版本门运行适配器自己的 `--cli --version`，只接受它所启动的 Claude Code 版本；不以 ACP 报告的适配器版本或 PATH 上另一个 `claude` 代替。每次新进程都重新读取，无法确认或低于 2.1.318 时在发放凭据之前拒绝；使用它自己的模型不受这条网关门槛影响。

`ANTHROPIC_BASE_URL` 指向会话网关，runtime 单独将令牌放进 `ANTHROPIC_AUTH_TOKEN`，不写参数、私有文件或 CLI 设置。清空其他 provider 开关、API key、OAuth token 与自定义头；设置官方 `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`，使 Claude Code 忽略设置文件中的 provider 地址与认证覆盖。通过适配器官方 `_meta.claudeCode.options.settings` 为新建、载入、恢复及分叉请求交付 `availableModels` 与 `modelPicker`，每个模型 ID 原样传入，不提供 `behavesAs`、价格或推测容量。原生发现只保留 ID 含 `claude` 或 `anthropic` 的模型，因此不能单靠发现来列服务模型；显式 picker 支持服务自己的 ID，Host 仍只保留 Agent 实际报告的精确值。会话设置含公开模型字段与禁用的 `apiKeyHelper`，不含令牌，不写用户 CLI 设置。主模型、自定义模型项、自动模式分类器与子 Agent 默认值在启动时指向所选模型；其他默认别名清空，避免恢复时把精确 ID 报成某个别名；网关仍拒绝列表之外的请求，不承诺未知辅助调用都遵守配置。

同时开启官方 `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`；2.1.318 的实际 Bash、SessionStart hook 和 stdio MCP 子进程均不继承 `ANTHROPIC_AUTH_TOKEN`，即使用户设置覆盖了泛化 scrub 开关。泛化 scrub 可被设置文件覆盖，不能据此承诺用户自行配置的所有秘密都被清除。这个进程环境清理不是 OS 沙箱；原有 hooks、插件与 MCP 仍是可信本机代码。Claude 对自定义模型假定的上下文容量与价格不作为服务事实显示；只保留它报告的已用上下文 token，实际输入输出用量仍来自网关上游。未接入的跨协议方向继续不可选。

### pi 运行预算

pi 的模型注册 API 必须有输入上下文和输出上限。私有扩展优先用已安装 pi 官方公开目录中模型 ID 与协议都精确匹配、且边界一致的数值；没有精确值时不推测模型容量。可以在该 Harness 的高级环境中显式配置 `PI_GATEWAY_CONTEXT_TOKENS`（1–16777216）与 `PI_GATEWAY_OUTPUT_TOKENS`（1–1048576），两个都要为正整数，输出不得大于上下文。这是适配器的运行预算，修改后启动指纹改变；不表示模型标称容量，也不产生价格或余额。缺少有效预算的未选模型不注册，所选模型缺少预算则明确拒绝开始。

扩展在进程内用官方 `registerProvider` 注册服务，网关凭据只留在进程内存，并从子进程继承环境删除。pi 恢复会话时会重新加载扩展，因此同一进程的扩展实例从自己的私有槽取回凭据；新进程总由 Host 重新发放。扩展数据文件不含凭据。pi 强制要求的价格字段只作内部占位；经服务的会话不把它们或运行预算转换成 Agent 报告的费用、上下文容量。实际 token 用量仍从服务的响应记录。Pi 仅为私有 provider 注册官方 streamSimple 委托，沿用官方 SDK 的消息、工具、推理回放与取消转换，覆盖普通回复、压缩与分支摘要。每次以 options.reasoning 为准；在原 onPayload 回调之后核对模型并限制输出上限，删除上限的回调不能消除运行预算。payload 失配直接在官方 SDK 发网前失败。该桥允许服务使用自己的模型别名，不靠修改模型 ID 触发 SDK 的型号判断；其他 provider 不受影响。

## 调度

网关与内置 Harness 共用一个调度器（`model-scheduler.ts`）：同一份候选规则、错误分类、重试、健康与并发上限。内置 Harness 不经回环端口，它的每个服务 Provider 在注册时被包一层（`scheduled-provider.ts`）直接调用调度器。调度器从不自己发请求，健康只来自真实请求。

### 候选

设置 › 模型 里每个模型可以有「出错时改用」：至多 4 个已保存服务的模型，按顺序，可以是别的服务的同名模型、别的模型或本服务的另一个模型。保存要 `admin`，不弹本机确认：每个候选都是已确认地址的服务。保存时核对每一项都指向已保存的模型；移除模型时它的备选一起移除。只核对这次请求送来的列表；已保存的列表里指向已删除服务或模型的项在下次保存时丢掉，删除服务或移除模型时也从别的服务的列表里清掉，所以悬空的项从不妨碍改名、停用或清除密钥。改动列表写审计 `provider.fallbacks.changed`（服务 ID、变动的模型数、新列表指向的服务 ID、是否放宽；没有模型名）：新增或调整顺序是放宽，审计写不进去就不保存；只移除是收紧，照常保存并在响应里带 `x-latch-audit: failed`。列表与「同时请求」上限不计入服务的执行修订，保存它们不替换插件，也不使已批准的定时任务失效。

- **经 Latch 的会话**在开始时把所选服务每个模型的备选写进 `ModelRoute.fallbacks`（服务 ID、模型、上游协议、来源），随会话持久化，计入 `routeHash` 与启动指纹；没有备选时指纹不变。入口协议不能直接说、也没有已实现转换的备选在这一步略去。之后改设置只影响新会话。
- **凭据**签发时绑定每个候选当时的服务指纹。签发时或之后被停用、删除、改了地址密钥或模型的备选只让那个候选失效并被跳过，不作废会话；第一个候选不能用时仍照原规则失败。
- **内置 Harness**每轮可以换模型，所以它的候选在这一轮第一次请求时按当时的设置定下，这一轮内不变。
- 透传给备选时只把请求体的 `model` 改成那个服务里的名字（数字词元保留原样）；协议不同的备选走同一套转换，思考档位在那个模型没有声明时改用它的默认值。推理封装仍只回放给签发它的服务与模型。token 计数请求只发给会话自己的服务。

### 错误分类与故障切换

只在回复的第一批字节到达之前；之后断了就是这一轮失败，从不再发一次。

| 上游的结果 | 做法 | 计入健康 |
| --- | --- | --- |
| 400、404、405、413、422、501 等请求自身的问题 | 原样返回，不换候选 | 不计 |
| 401，或写明是密钥问题的 403 | 换下一个候选；服务标「密钥无效」一分钟，之后由真实请求再问它 | 计 |
| 其他 403（地区、账户不能用这个模型等） | 换下一个候选；不说密钥无效 | 计 |
| 这个服务在 Latch 里的每月预算用完（见「预算」） | 换下一个候选，没有时返回 402 `budget-exceeded`；没有向服务发任何请求 | 不计入熔断 |
| 402，或错误里写明余额、额度用完 | 换下一个候选；服务休息 30 分钟，休息结束后再遇到时 2 小时、8 小时、1 天。同时在途的请求一起遇到只算一步，休息期间再被拒绝不加长；成功一次回到 30 分钟 | 不计入熔断 |
| 429 | 有下一个候选就换；没有时，`retry-after` 不超过 10 秒的等一次再试，否则带着 `retry-after` 原样返回。服务标「请求过多」到它要求的时间（最多一分钟），其间别的服务排在前面 | 不计入熔断 |
| 500、502、503、504、529、连不上、回复开始前连接断开 | 同一服务再试两次，间隔 1 秒与 3 秒，各 ±30%；还不行换下一个候选 | 计 |
| 流式请求 60 秒内没有开始回复 | 有下一个候选就立刻换；没有就把超时按入口协议返回。超时后从不向同一个服务再发一次：它可能还在处理第一份 | 计 |
| 已开始回复后断开 | 不换，按入口协议发流内错误 | 计 |

- **首字节时限只给流式请求**，量的是到响应头或流的任何字节（含注释与保活）的时间，不是到第一段正文；内置 Harness 的路径量到服务的响应到达。响应到了以后模型可以安静地想很久，不会被切断或重发。非流式请求（`stream` 不为 true、token 计数）整份回答一次到达，没有首字节时限，耗时也不计入健康。
- 一个请求在回复开始前最多 90 秒，等位置与等名额的时间不算在内，到时返回最后一个错误。一个 60 秒不出声的服务不会把这 90 秒用完：有备选时，备选在同一个请求里、大约第 60 秒接手。
- **备选自己拒绝这个请求**（400 类）时跳过它，返回前一个候选的真实失败；会话自己的服务返回 400 类时仍原样返回、不换候选。
- **带服务端状态的请求**（`previous_response_id`、`store: true`、`conversation`、`container`）从不发给另一个服务，只在同一服务的候选之间切换，否则返回第一个失败。
- **可能已经在服务端执行过的请求不再发第二次。** 请求带服务端自己执行的工具（网页搜索、代码执行、`mcp_servers` 等）或服务端状态时，只有能证明它没有执行的失败才允许重试或换候选：连接根本没有建立、401/403、402、429。5xx、60 秒没有回复、发出后连接断开（包括 200 之后正文一个字节都没到）都原样返回，不在原处重试，也不换到别的服务。
- **会话自己的服务在运行中被改了**（第一个候选的指纹不再是服务当前的）时，照改动前的规则回答：网关作废凭据，内置 Harness 报 `model-route-changed`。不会悄悄换到下一个候选，也不写切换记录。
- **后面的候选满了**（它的位置或全 Host 名额等不到）时，返回前一个候选的真实失败，不用 `gateway-busy` 盖住它。
- **先审计再切换**：每次把请求交给另一个候选之前写 `task.model.fallback`（会话、离开的服务 ID、去往的候选序号、错误分类；没有模型名与任何正文）。写不进去就不切换，返回当时的错误。因为第一个候选被暂缓而从备选开始的请求同样先写一条。
- **会话亲和**：一轮里换到备选后，这一轮余下的请求直接去那个备选；下一轮从第一个候选开始，除非它正被暂缓。
- 被暂缓（密钥无效、休息中、熔断中）的服务排到候选末尾：前两种在别无选择时仍会收到真实请求，熔断中的不发。一个都不能试时返回 503 `gateway-circuit-open` 与 `retry-after`。服务已经变了的候选在调度之前就去掉，调度器也不认不是服务当前指纹的候选：它不会被尝试，也不会清掉这个服务已有的记录。
- 真实失败不回退到演示模型；没有设置备选的模型只有它自己一个候选。

### 健康与熔断

每个服务一个状态，只在不正常时出现在 `ProviderSummary.health` 与 `ProviderSettings.health`：`slow`（最近 5 次首字节的中位数是此前的 3 倍以上）、`failing`、`quota`、`rate`（429）、`key-invalid`，附最近一次失败的分类与时间；后四种带 `until`，到时自己结束，由下一个真实请求重新判断，页面过了这个时间也不再显示。所有设备都能看到，里面没有请求、回复或密钥。

- 熔断在连续 4 次可计失败，或 2 分钟内至少 10 个请求里一半失败时打开；60 秒内不向它发请求。429 与余额用完不计入：它们是账户的状态，各有自己的琥珀色状态与时间，不会把服务标成「出错中」。
- 60 秒后放一个真实请求去试；这个请求一开始回复就算试成功，熔断立即关闭，别的请求不用等它的回复结束（回复怎么结束照常计入）。试失败再开 60 秒；回复开始前客户端断开只归还名额、不改变状态。
- 服务的密钥、地址或模型变了（指纹变化）就清空它的记录。状态只在 Host 内存，重启后从空白开始。
- 「检测连接」仍只列模型，不影响这里的状态。

### 并发与排队

每个服务可以设「同时请求」上限（1–32，默认不设）。两条路径都先取服务的位置，再取全 Host 的 32 个名额之一，所以一个满了的服务不会占着别的服务要用的名额；换候选时先归还名额。服务的位置满了按到达顺序等，最多 30 秒，等不到返回 429 `gateway-busy` 与 `retry-after: 1`；取消等待立即让出位置。等待时会话摘要带 `live.queued`；只有在等某个服务自己的位置时才带 `live.queuedFor`（服务名），界面写「排队：<服务>」，等全 Host 名额时只写「排队」。这两个字段只由 Host 设置。

### 默认模型

新会话的模型按这个顺序取：会话里的选择 → Agent 的模型 → 项目的「默认模型」 → Harness 自己的默认。项目的默认模型只存在 Host 的项目记录（`settings.json` 的 `workspaces[].defaultModel`），不写进仓库；改它要 `admin`，写 `workspace.changed`（`modelChanged`）。它现在不能用、或这个 Harness 不能经 Latch 用它时不算数，会话照常开始。页面在草稿里就显示它；带了开始选项（`config`）或模型的请求算会话自己的选择。在自己带模型的 Harness 的模型菜单里选它自己的「默认」也是会话的选择：页面记住这个选择（下一稿仍是它，直到另选），请求带 `ownModel: true`，项目的默认模型不替换它。这台设备在 Latch 内置上选过的模型照旧被记住并排在项目默认之前；只有还没有选过模型的设备跟随项目默认。Agent 为自己的 Harness 保存的选项（`engineOptions`，其中可以有它自己的模型）算 Agent 的选择：交互开始时它们作为 `config` 发出，定时运行的计划也不再套用项目默认。

## 用量、花费与预算

这里说的是经 Latch 发给模型服务的请求：用了多少（用量）、花了多少（花费）、你自己设的每月上限（预算）。它与输入框旁的「额度」不是一回事：「额度」是各 Harness 自己的订阅窗口，由 Harness 报告，Latch 只显示、不计量也不限制（`packages/protocol/src/quota.ts`）。

### 用量账本

Host 每发出或拒绝一个模型请求，就在数据目录的 `gateway/usage-YYYY-MM.jsonl` 追加一行（`model-usage.ts`）。网关与内置 Harness 经同一个计量器（`model-budgets.ts` 的 `createModelMeter`）写同一份账本。文件 0600，目录 0700，只追加；按 Host 电脑自己的时间分月，整月结束超过 90 天的文件在启动和换月时删除，读取时也不取 90 天之前的行。上次崩溃留下的半行在下一次写入前补上换行，下一行不会跟着丢。账本读的是回复本身，不依赖这一轮的记录：一轮里点名超过 16 个模型时，之后的请求照样各有一行、照样计入预算；回复开始后中断或被放弃的请求，已经读到的用量照样记下。token 计数请求、模型列表、凭据或模型名不对而没到调度的请求不写。

每行只有这些字段，schema 是 strict，多一个字段的行不写也不读：

| 字段 | 含义 |
| --- | --- |
| `at` | 请求到达的时间；跨月的请求算在到达的那个月 |
| `sessionId`、`agentId`、`harness` | 会话、它所属的 Agent（没有就不写）、运行它的 Harness；都来自 Host 自己的记录 |
| `providerId`、`model`、`used` | 回答的服务（没有回答时是最后问的那个，一个都没问时是会话自己的服务）、问它时用的模型名、它在回复里说的模型名 |
| `outcome`、`attempts`、`fallback` | 结果分类、真正发给服务的次数、是否由「出错时改用」的服务回答 |
| `firstByteMs`、`totalMs` | 到回复开始与到结束的时长 |
| `inputTokens`、`outputTokens`、`cacheReadTokens`、`cacheWriteTokens`、`reasoningTokens` | 服务报告的用量；输入含缓存、输出含推理，后三项只在服务报告时存在 |
| `cost` | 花费（百万分之一货币单位 `micros`、`currency`、`source`），只在已知时存在 |

`outcome` 是 `ok`、调度的错误分类（`request`、`auth`、`forbidden`、`quota`、`rate`、`server`、`network`、`timeout`、`stream`、`unavailable`、`circuit-open`）、`busy`（排队超时）、`budget`（预算用完，没有发出）或 `aborted`（Harness 或人放弃）。

账本从不记：提示与回复的正文、工具参数与结果、推理、图片、服务密钥、`lmg1.` 凭据、任何请求头或回复头、查询串。模型名先经 `withoutKey` 与 `redactKnownSecrets` 并截到 200 字。账本是用量元数据，不是审计，也不进审计 detail；写不进去只记一行日志，不让请求失败。读不出的行跳过并计数，汇总里如实给出，不让读取失败。

每个月的账本旁有 `gateway/totals-YYYY-MM.json`（0600，strict）：按服务与按 Agent 的本月合计（tokens、各币种花费、发出的请求数与其中花费已知的数），只有键与数字，每写一行就原子替换一次，随账本文件一起删除。它记着自己覆盖的账本文件大小，只统计已经写入的前缀。大小对不上、文件缺失、格式或版本不对时，从账本整月重新数一遍再写回，不设行数上限。v1 可能误含尚未写入的请求，Host 从原账本重建 v2 合计。预算在运行中仍立即计入刚结算的请求，追加失败会留日志；没有可读账本行的请求只在本进程保留预算计数，重启按账本中实际可读的行恢复。Host 的时钟回到本进程尚未读过的旧月份时，会异步载入该月账本合计。载入完成前的预算检查可能暂时少计。一次汇总最多读 40 万行，超过时结果带 `truncated`，界面如实写明；预算用的合计没有这个上限。

### 汇总

`POST /link/api/model-usage`（`view`）按 `period`（`month`、`7`、`30`、`90`）与 `group`（`session`、`agent`、`service`、`model`）汇总：请求数、失败数（放弃的不算）、备选次数、报告了用量的请求数与它们的和、花费。只加服务真实报告的数：一行里没有任何请求报告用量时没有 `usage`，界面写「未报告」而不是 0；有的请求没报告某一项（缓存读写、推理）时，这一项整行不给。会话的名字按允许名单给：只有这台设备现在读得到的会话保留会话 ID；其余的请求（它读不了的会话、之后被删除的会话、没有会话的请求）照常计入各项合计，但并成一行、不带会话 ID。数据范围不是 `all` 的设备也拿不到任何请求的 Agent ID，看不到 Agent 的预算。Host 读完账本才取当前会话名单，答复前复核设备权限、当前会话归属与私有状态。Web 收到权限变化的快照时立即撤下旧汇总与预算，取消正在读取的请求，再按当前权限重读。

### 花费

花费只在两种情况下存在，Latch 没有内置价格表：

- **服务在回复里报告**：读 Chat Completions 与 Responses 回复的 `usage.cost`（OpenRouter 等），按美元记，`source: reported`。内置 Harness 的同两种连接器读同一个字段。
- **你给这个模型填了单价**：设置 › 模型 的模型行「⋯」›「单价」，输入、缓存输入、缓存写入、输出四项，每百万 tokens，币种美元或人民币；缓存两项留空时按输入单价算。`source: prices`，界面标「按你填的单价」。

两者都有时以你填的单价为准：服务报告的数只在没填单价时用，并且必须是 0 到 100 美元之间的普通数字，否则不采信，这次请求的花费记为未知（tokens 照记）。转换或由备选回答的请求，用回答的那个服务的模型的单价。花费在写账本行时算好，之后改单价不改旧行。不同币种分开加，不换算。

### 预算

可选。每个服务、每个 Agent 至多一个每月预算：tokens（输入加输出），或某一币种的花费。月份按 Host 电脑自己的时间，界面写明时区。没有账本的新月份从零开始。

- **按花费的预算要算得出花费**：设置时，它覆盖的每个模型都得有这个币种的单价，否则 400 `budget-cost-unknown`（服务：它的全部模型；Agent：设定使用的服务模型及当时配置的全部备选，没有设定服务模型的 Agent 与「通用」只能按 tokens）。之后仍可能出现花费未知的请求（后来选用的模型、新增备选、删改了单价或服务没报告用量）：它们不计入已用，`BudgetProgress.uncounted` 给出本月有多少次，用量页在预算旁写「未计入 N 次」。按 tokens 的预算不受影响。
- **没有预留**：Agent 预算在进入调度前检查，服务预算在各候选取得服务名额后检查。服务预算检查通过后，请求仍可能等待全 Host 名额。预算按已结算的用量检查，已通过检查的请求合计可能超过预算。
- **80%**：这一轮的记录带 `spend.budget: 'near'`（经 Latch 的会话在 `turn.routed.spend`，内置 Harness 在 `turn.spend`），这一轮的页脚写琥珀色「预算已用 80%」。会话照常继续。
- **100%**：预算检查发现已用完时拒绝请求或跳过该候选，已通过检查的请求照常进行。
  - **Agent 的预算**用完：这个 Agent 的会话的请求直接拒绝，不换到别的服务。内置 Harness 从 Host 校验后的创建上下文取得首轮归属，即使这时会话 ID 还没有写回 Hub。
  - **服务的预算**用完：和服务端 402 一样对待这个候选。模型有「出错时改用」时换下一个候选，先写 `task.model.fallback`（`errorClass: budget`）；没有可用候选时拒绝。别的候选只是被熔断暂缓时，回答是 503 `gateway-circuit-open` 与 `retry-after`（它会自己恢复），不是预算拒绝。
  - 拒绝是 402 `budget-exceeded`「本月预算已用完」，用入口协议的形状：OpenAI 形状 `error.code`；Anthropic `type: billing_error` 并带 `code`。内置 Harness 的这一轮以同一句话失败。不回退到演示模型。
- 单价、预算以及完成回执存在 `gateway/budgets.json`（0600，strict schema，整份原子替换）。旧文件的修订号默认为 0，回执默认为空；不认识的字段会使 Host 拒绝启动。`GET /link/api/model-spend`（`view`）给出当前 `revision`、单价、预算和本月已用。`PUT /link/api/model-prices` 和 `PUT /link/api/model-budgets` 要 `admin`，不弹本机确认。Agent 预算还要完整数据范围（`all`），包括「通用」，在读取目标/价格、答复已结算回执以及写入前都复核。
- **回执与冲突。** 两条写入带 `requestId`、`baseRevision`、目标键和完整值，`null` 清除。先按设备身份及请求 ID 找出已结算回执，同请求回答原修订号和 `replayed: true`，同 ID 不同语义返回 409 `request-conflict`。新请求在同一写入队列内以上个修订为条件。写成功连同回执原子保存并推进修订号，相同值也推进修订号并留回执，且不写改动审计。只留最近 256 条完成回执（身份与语义的哈希、原修订号、是否有审计失败）；旧回执被淘汰时，旧修订仍使同一请求即使在重启后也被 409 `model-spend-conflict` 拒绝，不会再次应用。
- **结果未知。** 原子写未确认时回 503 `model-spend-write-unknown`，留存已经审核的原写入，重试须复用原请求 ID、修订与完整内容。另一项写入此时回 503 `model-spend-write-pending`，没有受理。必需的审计写不下时回 503 `model-spend-audit-unavailable`，没有提交。当前值的 GET 用于刷新显示。
- **先审计再写**：`model.prices.changed`（服务 ID、模型名的哈希、变了哪几项、是否清除；没有金额）与 `model.budget.changed`（服务或 Agent 的 ID、变了哪几项、是否取消、`widening`；同样没有金额），actor 是发起的设备。预算按写入队列中当前保存的值判断是否会放宽，审计后再次核对设备权限才写入。让人能花更多的改动（取消预算、调高上限、换单位或币种，以及任何单价改动：单价决定按花费的预算怎么计）在审计写不进去时不执行；只会让人花得更少的（第一次设预算、调低上限）照常执行，回复带 `x-latch-audit: failed`。
- 删除服务时一并删它的单价与预算，删除 Agent 时一并删它的预算；这一步失败只记日志，不撤销删除。

## 生命周期与可见事实

Host 的内置模型服务与 Harness 网关共用 32 个上游请求名额，持有到响应实际读取完毕或取消结算，收到响应头不会归还。满额后按到达顺序排队，最多等 30 秒；等待队列额外限制为 128 个请求、序列化正文合计 64 MiB，达到任一界限拒绝新等待。超时或队列已满返回 429 `gateway-busy`，网关附 `retry-after: 1`。取消等待立即移除，停止 Host 拒绝全部等待；已经取得的名额只由所属请求归还一次。

排队不是授权。内置服务和网关在取得名额后重新核对当前服务、地址、密钥及模型声明；进程凭据失效或配置变化的请求不发送旧密钥。连接检测和模型列表不占模型请求名额。

进程退出、Host 关闭、服务协议/地址/密钥/可用性、模型清单或声明能力变化会作废凭据；下一轮重新准备进程与凭据，服务不能用了就明确失败。会话不能换服务，同服务内只提供该凭据允许的模型；备选的服务变了只让那个候选失效。Host 保存的 vision/thinking 声明随 lease 交给 profile，不从模型名猜图片、思考、价格或容量。

一轮有回复而没有任何请求到网关时，会话如实标记 bypassed 并写 task.model.bypassed；这只能发现整轮绕过，不能证明所有辅助调用都经过网关。Agent、插件和扩展是可信本机代码，网关不是 OS 隔离。

一个 Harness 请求在上游重试或换候选时仍算一次请求；失败的尝试没有回复可读，所以只有最终回答的那次回复的 token 计入，重试不重复计量。每轮只保存模型 ID、请求/失败/未结束数、由备选回答的请求数与那个服务的 ID、转换损耗枚举及服务报告的 token 用量。Responses、Chat、Anthropic 的流与非流式回答分别读取原生 usage 字段；缓存读写和推理只在服务报告时存在。超过读取预算的事件继续透传但用量未知。模型回复正文不进入网关账本，模型 ID 先脱敏。费用不从 token 或未知价格猜算，只取按你填的单价算出的或服务报告的；这一轮已知的花费与预算状态记在 `spend`。凭据不进入审计、SSE、启动预览或持久化会话。

尚欠的真实核对：预算拒绝（HTTP 402 `budget-exceeded`）还没有对着真实的 Harness 看它是否停下而不是重试；真实服务的 `usage.cost` 字段与币种也只用本地假服务核对过。

验证见 [TESTING.md](TESTING.md)。测试确认后端与本地假模型不等于本人系统确认或真实 BYOK 成功；真实 CLI 的临时验收与实际上游证据分别记录。
