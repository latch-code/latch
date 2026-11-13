---
description: Harness 经 Host 使用模型服务的回环入口、凭据、协议、启动交付、环境过滤与用量来源。
sources:
  - apps/host/src/model-gateway.ts
  - apps/host/src/model-reply.ts
  - packages/harness-acp/src/profiles
  - packages/harness-acp/src/runtime.ts
---
# 模型网关

Host 为经 Latch 使用模型服务的 Harness 提供单独的回环临时端口。它只有模型路径，不是设备 API；每个 Agent 进程拿一个 `lmg1.` 凭据，Host 内存只保存其哈希，凭据绑定会话、服务、协议和模型列表。服务的真实密钥留在 Host，只发往已确认的服务源与路径，经与内置 Harness 相同的出站策略。

## 协议与请求

当前四种入口只做同协议透传，尚未实现跨协议转换、备选调度、价格账本和预算：

| 入口 | 模型请求 | 模型列表 |
| --- | --- | --- |
| Responses | `POST /v1/responses` | `GET /v1/models`，OpenAI 形状 |
| Chat Completions | `POST /v1/chat/completions` | 同上 |
| Anthropic Messages | `POST /v1/messages`、`POST /v1/messages/count_tokens` | `GET /v1/models`，Anthropic 形状 |
| Gemini | `POST /v1{beta,alpha}/models/<模型>:generateContent`、`streamGenerateContent`、`countTokens`，也接受 `v1` | 相应版本的 `/models` |

凭据只开放自己协议的路径。模型列表只返回绑定的服务模型，不访问上游；请求体最多 32 MiB，模型必须在绑定列表里。Gemini 的上游版本按服务地址决定，未指定时用 `v1beta`，查询参数只保留 `alt=sse`。Chat 流式请求未指定 `stream_options.include_usage` 时补为 true，明确给出的值不覆盖；其他正文保持原样。

只接受预期回环 Host，不接受 Origin、浏览器的 Sec-Fetch-Site/Dest/User 等标记或未知 Sec-Fetch 字段；兼容 Node fetch 单独发送的 `Sec-Fetch-Mode: cors`。这个传输标记不构成身份验证，仍须有效进程凭据，不返回 CORS 头。入站认证、Cookie 和未列出的头不转发。Chat/Responses 只转发 accept、openai-beta；Anthropic 同协议透传另外保留 anthropic-version、anthropic-beta。回复只保留 content-type、retry-after、x-request-id、request-id，保留的值也脱敏。

读取完整请求体后，发出请求前再次核对进程凭据和服务指纹；上传期间撤销或变更的请求不转发。上游不跟随重定向。错误正文最多读取 64 KiB，去掉真实密钥的原文、JSON 转义、URL 编码和截断尾部等形式后返回；成功状态的 JSON 与 SSE 也可能包含错误，沿流跨字节块脱敏，只暂存可能的密钥前缀。日志经过 Host 秘密脱敏。下游断开时中止上游请求。开始回复后断流记录为未完成，不重发、不回退到其他服务或演示模型。

## Harness 交付

| Harness | 当前网关路线 |
| --- | --- |
| Codex 直连 | 至少 0.167.0；进程启动配置自定义 `latch` provider，Responses；凭据从 `LMG_TOKEN` 读取，参数只有地址、变量名和公开选项 |
| codex-acp | `providers/set`，仅在适配器声明并列出对应 provider/API 类型时使用；凭据经 ACP 头字段 |
| Gemini CLI | 至少 0.44.0；GOOGLE_GEMINI_BASE_URL、GEMINI_API_KEY 与会话私有系统设置 |

其余 Harness 的接线尚未实现时不在模型菜单中承诺转发。Cursor 与未知自定义命令只用自己的模型。订阅登录不进入网关；使用 Harness 自己的登录时仍由它原生处理。

Profile 的 launch 交付统一返回环境变量、参数和私有文件；文件以 0600 原子替换，只能写地址、模型、公开配置和变量名，不能含网关令牌。令牌只由 runtime 注入允许的环境变量。启动指纹覆盖 profile 版本、交法、变量名及参数/文件模板版本，不含临时端口或令牌。新进程仍在全部异步准备后复查命令、项目与授权；准备失败会撤销已经创建的凭据。模式换档参数、权限插件与网关参数共同传入。

Codex 在开线程和恢复线程前，以相同 cwd 调用官方 `config/read`，只投影有效的命令环境过滤规则。旧 exclude/include_only 与新 filters 保持原表示，只额外排除 LMG_TOKEN；大小写冲突、混合表示、畸形或读取失败均拒绝开线程。不复制 set 或其他配置值，不读写 Codex 私有文件。规则通过线程 config 覆盖，既有规则不会被启动参数的数组替换。每次 turn/start 仍给出当前模型与权限。经网关的模型列表取服务声明，允许 Codex 原生目录之外的模型；导入历史仍经 thread/list/read，并包含自定义 provider 的线程。

Gemini 的系统设置把主模型、已知辅助模型别名和内置子 Agent 指向会话开始时的模型，同时合并所选思考启动设置；文件写好不等于 Agent 独立读回思考。辅助别名的其他生成参数保留，之后会话切模型时辅助调用仍可用开始时模型。新的别名、用户自定义子 Agent、重试条件覆盖等可能指定其他模型，网关只允许绑定列表里的请求，其他请求失败。私有系统设置替代了系统设置路径，不承诺保留另一个系统设置文件里的管理策略。

## 生命周期与可见事实

进程退出、Host 关闭、服务协议/地址/密钥/可用性、模型清单或声明能力变化会作废凭据；下一轮重新准备进程与凭据，服务不能用了就明确失败。会话不能换服务，同服务内只提供该凭据允许的模型。Host 保存的 vision/thinking 声明随 lease 交给 profile，不从模型名猜图片、思考、价格或容量。

一轮有回复而没有任何请求到网关时，会话如实标记 bypassed 并写 task.model.bypassed；这只能发现整轮绕过，不能证明所有辅助调用都经过网关。Agent、插件和扩展是可信本机代码，网关不是 OS 隔离。

每轮只保存模型 ID、请求/失败/未结束数及服务报告的 token 用量。Responses、Chat、Anthropic、Gemini 的流与非流式回答分别读取原生 usage 字段；缓存读写和推理只在服务报告时存在。超过读取预算的事件继续透传但用量未知。模型回复正文不进入网关账本，模型 ID 先脱敏。费用不从 token 或未知价格猜算。凭据不进入审计、SSE、启动预览或持久化会话。

验证见 [TESTING.md](TESTING.md)。测试确认后端与本地假模型不等于本人系统确认或真实 BYOK 成功；真实 CLI 的临时验收与实际上游证据分别记录。
