---
description: Harness 经 Host 使用模型服务的回环入口、凭据、协议、启动交付、环境过滤与用量来源。
sources:
  - apps/host/src/model-gateway.ts
  - apps/host/src/model-gateway
  - apps/host/src/model-reply.ts
  - packages/harness-acp/src/profiles
  - packages/harness-acp/src/runtime.ts
---
# 模型网关

Host 为经 Latch 使用模型服务的 Harness 提供单独的回环临时端口。它只有模型路径，不是设备 API；每个 Agent 进程拿一个 `lmg1.` 凭据，Host 内存只保存其哈希，凭据绑定会话、服务、协议和模型列表。服务的真实密钥留在 Host，只发往已确认的服务源与路径，经与内置 Harness 相同的出站策略。

## 协议与请求

四种入口优先同协议透传；Responses 入口另可转换到 Chat Completions。其他跨协议方向、备选调度、价格账本和费用预算尚未实现：

| 入口 | 模型请求 | 模型列表 |
| --- | --- | --- |
| Responses | `POST /v1/responses` | `GET /v1/models`，OpenAI 形状 |
| Chat Completions | `POST /v1/chat/completions` | 同上 |
| Anthropic Messages | `POST /v1/messages`、`POST /v1/messages/count_tokens` | `GET /v1/models`，Anthropic 形状 |
| Gemini | `POST /v1{beta,alpha}/models/<模型>:generateContent`、`streamGenerateContent`、`countTokens`，也接受 `v1` | 相应版本的 `/models` |

凭据只开放自己协议的路径。模型列表只返回绑定的服务模型，不访问上游；请求体最多 32 MiB，模型必须在绑定列表里。Gemini 的上游版本按服务地址决定，未指定时用 `v1beta`，查询参数只保留 `alt=sse`。Chat 流式请求未指定 `stream_options.include_usage` 时补为 true，明确给出的值不覆盖；其他正文保持原样。

只接受预期回环 Host，不接受 Origin、浏览器的 Sec-Fetch-Site/Dest/User 等标记或未知 Sec-Fetch 字段；兼容 Node fetch 单独发送的 `Sec-Fetch-Mode: cors`。这个传输标记不构成身份验证，仍须有效进程凭据，不返回 CORS 头。入站认证、Cookie 和未列出的头不转发。Chat/Responses 只转发 accept、openai-beta；Anthropic 同协议透传另外保留 anthropic-version、anthropic-beta。回复只保留 content-type、retry-after、x-request-id、request-id，保留的值也脱敏。

读取完整请求体后，发出请求前再次核对进程凭据和服务指纹；上传期间撤销或变更的请求不转发。上游不跟随重定向。错误正文最多读取 64 KiB，去掉真实密钥的原文、JSON 转义、URL 编码和截断尾部等形式后返回；成功状态的 JSON 与 SSE 也可能包含错误，沿流跨字节块脱敏，只暂存可能的密钥前缀。日志经过 Host 秘密脱敏。下游断开时中止上游请求。开始回复后断流记录为未完成，不重发、不回退到其他服务或演示模型。

### Responses 转 Chat

入口和上游分别绑定在凭据上。`ModelRoute.wire` 是 Harness 入口；可选的 `upstream` 是服务协议，旧记录缺省时与入口相同。Host 通过 `pairRoute` 重算，网关再次核对已实现的 `TRANSLATED_PAIRS` 与服务协议、来源；不会把一个入口的凭据开放给另一个入口。转换路线始终标记实验性。

转换使用网关自己的类型化条目，不改变 Standard 的 `ModelMessage`。保留系统说明、消息、图片、函数定义、工具调用与结果、并行与指定工具选择、明确的思考档位和输出上限。命名空间与长工具名在 Chat 中编码为稳定名称，回来时恢复原名称和 namespace；自定义工具改成只含 `content: string` 的函数，再恢复原始 `custom_tool_call.input`。语法约束只作为说明传给服务，不能声称仍被强制执行。网关自己不执行工具。

图片 data URL 与 HTTP(S) URL 直接作为内容交给模型服务，网关不下载 URL。Chat 的工具结果只发文字；工具图片排在同批全部工具结果之后的 user 消息中，逐组注明对应调用及「不是用户发送的」，并记录 tool-image-location 损耗，不能声称原始消息位置仍保留。文件、PDF、服务端会话引用、`store: true` 与多个候选明确拒绝；未支持的执行型历史条目也拒绝，不能悄悄删除后继续。服务端工具不由 Host 代执行，当前 Chat 转换略去其定义；概率详情、引用标注等不转换的内容计入闭合损耗枚举。菜单的转换说明给出可能受限的能力，每轮 `routed.dropped` 只记录本轮实际遇到的枚举，不含正文。

Chat 流强制请求末尾用量。每条流独立维护有界状态，处理 UTF-8 分块、交错并行调用与结束后的 usage，输出完整的 `response.output_item.done`。工具参数与所有工具身份都核对后才给可执行的 done；同一工具索引的 ID 与名称一旦报告就不能变化，重复相同值兼容；达到输出上限或内容过滤时不发布未完成工具的 done。模型断流、畸形输出或流内错误返回 `response.failed`，不能变成空成功，也不重试或回退。429 与 retry-after 保留；上游过载改为 503，上下文超长保留 `context_length_exceeded`。

Chat 的 `reasoning_content` 以 `latch1.` 封装在 Responses 的 `encrypted_content` 中。它是带 HMAC 的来源封装，不是加密；签名 key 只在当前 Host 内存，签名绑定同一服务和模型。合法回放覆盖历史中的各个助手步骤，跨服务、跨模型、篡改、外来封装与 Host 重启前的封装都剥离并记录损耗。重启后不能承诺仍满足要求完整旧思考的服务；这样的服务可能拒绝旧上下文，须重新开始或清空上下文。封装前先脱敏，函数参数先核对对象、嵌套上限和有限数值，再逐个解码并脱敏 JSON 字符串词元；数字与未修改的词元保留原样。错误也在增加 JSON 转义层之前脱敏，避免编码隐藏密钥。不会持久化签名 key 或正文账本来恢复封装。

## Harness 交付

| Harness | 当前网关路线 |
| --- | --- |
| Codex 直连 | 至少 0.167.0；自定义 `latch` provider 使用 Responses 入口，可接同协议服务或转换到 Chat；凭据从 `LMG_TOKEN` 读取，参数只有地址、变量名和公开选项 |
| codex-acp | `providers/set`，仅在适配器声明并列出对应 provider/API 类型时使用；凭据经 ACP 头字段 |
| Gemini CLI | 至少 0.44.0；GOOGLE_GEMINI_BASE_URL、GEMINI_API_KEY 与会话私有系统设置 |
| OpenCode | 经网关至少 2.2.6；私有 `providers.latch` 配置与 shell hook；四种同协议服务 |
| DeepSeek Harness | 至少 0.2.2-rc.1；私有 Cordis patch 配置 llm provider、ACP 与默认模型；四种同协议服务 |
| pi | 经网关至少 1.5.0；私有扩展调用官方 `registerProvider`，只在当前进程注册模型；四种同协议服务 |

Qwen Code、goose 与 Claude Agent 的接线尚未实现，不在模型菜单中承诺转发。Cursor 与未知自定义命令只用自己的模型。订阅登录不进入网关；使用 Harness 自己的登录时仍由它原生处理。

Profile 的 launch 交付统一返回环境变量、参数和私有文件；文件以 0600 原子替换，只能写地址、模型、公开配置和变量名，不能含网关令牌。令牌只由 runtime 注入允许的环境变量。启动指纹覆盖 profile 版本、交法、变量名及参数/文件模板版本，不含临时端口或令牌。新进程仍在全部异步准备后复查命令、项目与授权；准备失败会撤销已经创建的凭据。模式换档参数、权限插件与网关参数共同传入。网关声明最低版本时，初始化后还核对 Agent 报告的版本；没有协议版本报告时取官方命令的版本读数，两者都无法确认就拒绝开始。dsh 的 ACP 固定报告应用内部版本 0.0.1，与发行版本无关，所以它只接受已核对的官方命令版本证据。自定义包装命令不能靠跳过官方版本查询绕过网关门槛；普通原生模型路线保持原有版本策略。

Codex 在开线程和恢复线程前，以相同 cwd 调用官方 `config/read`，只投影有效的命令环境过滤规则。旧 exclude/include_only 与新 filters 保持原表示，只额外排除 LMG_TOKEN；大小写冲突、混合表示、畸形或读取失败均拒绝开线程。不复制 set 或其他配置值，不读写 Codex 私有文件。规则通过线程 config 覆盖，既有规则不会被启动参数的数组替换。每次 turn/start 仍给出当前模型与权限。经网关的模型列表取服务声明，允许 Codex 原生目录之外的模型；导入历史仍经 thread/list/read，并包含自定义 provider 的线程。

Gemini 的系统设置把主模型、已知辅助模型别名和内置子 Agent 指向会话开始时的模型，同时合并所选思考启动设置；文件写好不等于 Agent 独立读回思考。辅助别名的其他生成参数保留，之后会话切模型时辅助调用仍可用开始时模型。新的别名、用户自定义子 Agent、重试条件覆盖等可能指定其他模型，网关只允许绑定列表里的请求，其他请求失败。私有系统设置替代了系统设置路径，不承诺保留另一个系统设置文件里的管理策略。

OpenCode 的公开启动配置同时设置主模型与小模型，保留原权限与 Agent 档位。模型值采用 `latch/<模型>`；它自己的原生模型路线保持兼容 1.x。会话私有插件使用官方 `shell.create.before` hook 清空工具子进程的 LMG_TOKEN 值；2.2.6 的环境合并会保留空变量名，因此不把它说成变量不存在。插件目录与源码属于 profile 的启动行为和版本指纹。

DeepSeek Harness 的网关 patch 与权限服务 patch 同时交付。Chat、Responses、Anthropic 使用私有 `latch-gateway` provider；0.2.2-rc.1 的自定义 API 注册仅有这三种，Gemini 复用官方 `google` provider 的实现并替换该进程的地址和模型列表。会话日志与包清单遥测插件在这条路线关闭；工具子进程的敏感变量清除由 dsh 自身提供。配置值严格解码为该协议指定的 provider 与模型二元组，恢复不接受其他 provider 的同名模型。0.2.2-rc.1 的 Google 序列化器按型号决定发送 thinkingLevel 还是 token 预算；当前仅为已核对的官方目录精确型号提供人声明的离散档位。未知 Gemini 别名不显示和接受离散思考选项；已有非默认档位时换入这类别名、或恢复含该旧档位的状态，都明确拒绝，不能静默变成自动预算。私有会话字段 routeThinking 保留需要保持或核对的档位，不能被一次不支持的模型报告抹掉；Agent 在运行中主动报告这种变化时，Host 作废该进程凭据并取消本轮。重新选中支持的模型或明确选中有效档位后可继续，核对回执只有真正读到所请求的有效值才结清这项记录。通用别名的离散档位桥尚未实现。该版本 ACP initialize 不声明图片输入，所以模型支持图片也不等于可以经这个 ACP 入口发送图片。

工具与原生能力仍由 Codex 决定。0.167 的目录外模型使用它自己的后备描述，不提供独立的 custom apply_patch；它仍可沿原生命令工具执行 apply_patch。Latch 不改模型 ID 来套用另一个型号的能力，不把后备描述中的容量当作服务声明。可直接使用 Responses 的服务优先透传，不能把某一家服务固定视为必须转换。

### pi 运行预算

pi 的模型注册 API 必须有输入上下文和输出上限。私有扩展优先用已安装 pi 官方公开目录中模型 ID 与协议都精确匹配、且边界一致的数值；没有精确值时不推测模型容量。可以在该 Harness 的高级环境中显式配置 `PI_GATEWAY_CONTEXT_TOKENS`（1–16777216）与 `PI_GATEWAY_OUTPUT_TOKENS`（1–1048576），两个都要为正整数，输出不得大于上下文。这是适配器的运行预算，修改后启动指纹改变；不表示模型标称容量，也不产生价格或余额。缺少有效预算的未选模型不注册，所选模型缺少预算则明确拒绝开始。

扩展在进程内用官方 `registerProvider` 注册服务，网关凭据只留在进程内存，并从子进程继承环境删除。pi 恢复会话时会重新加载扩展，因此同一进程的扩展实例从自己的私有槽取回凭据；新进程总由 Host 重新发放。扩展数据文件不含凭据。pi 强制要求的价格字段只作内部占位；经服务的会话不把它们或运行预算转换成 Agent 报告的费用、上下文容量。实际 token 用量仍从服务的响应记录。Pi 仅为私有 provider 注册官方 streamSimple 委托，沿用官方 SDK 的消息、工具、推理回放与取消转换，覆盖普通回复、压缩与分支摘要。每次以 options.reasoning 为准；在原 onPayload 回调之后核对模型并限制输出上限，删除上限的回调不能消除运行预算。Gemini 只注册服务声明且可原样发送的离散档位，Host 再过滤选项并拒绝旧的不支持值；最终 thinkingConfig 写对应档位并删除自动预算。payload 失配直接在官方 SDK 发网前失败。该桥允许服务使用自己的模型别名，不靠修改模型 ID 触发 SDK 的型号判断；其他 provider 不受影响。

## 生命周期与可见事实

进程退出、Host 关闭、服务协议/地址/密钥/可用性、模型清单或声明能力变化会作废凭据；下一轮重新准备进程与凭据，服务不能用了就明确失败。会话不能换服务，同服务内只提供该凭据允许的模型。Host 保存的 vision/thinking 声明随 lease 交给 profile，不从模型名猜图片、思考、价格或容量。

一轮有回复而没有任何请求到网关时，会话如实标记 bypassed 并写 task.model.bypassed；这只能发现整轮绕过，不能证明所有辅助调用都经过网关。Agent、插件和扩展是可信本机代码，网关不是 OS 隔离。

每轮只保存模型 ID、请求/失败/未结束数、转换损耗枚举及服务报告的 token 用量。Responses、Chat、Anthropic、Gemini 的流与非流式回答分别读取原生 usage 字段；缓存读写和推理只在服务报告时存在。超过读取预算的事件继续透传但用量未知。模型回复正文不进入网关账本，模型 ID 先脱敏。费用不从 token 或未知价格猜算。凭据不进入审计、SSE、启动预览或持久化会话。

验证见 [TESTING.md](TESTING.md)。测试确认后端与本地假模型不等于本人系统确认或真实 BYOK 成功；真实 CLI 的临时验收与实际上游证据分别记录。
