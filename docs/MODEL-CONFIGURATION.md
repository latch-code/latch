---
description: Agent 上报的模型、推理级别和模型参数如何进入同一选择菜单，Latch 内置按模型声明的思考深度，以及权威选中值与未知结果的接线。
sources:
  - apps/web/src/composer/ModelControl.tsx
  - packages/protocol/src/model-route.ts
  - apps/web/src/composer/modelReasoning.ts
  - apps/web/src/settings/ProvidersSettings.tsx
  - apps/host/src/plugins/providers/chat-wire.ts
  - apps/host/src/plugins/providers/responses-wire.ts
  - apps/host/src/plugins/providers/anthropic-wire.ts
  - apps/host/src/plugins/providers/gemini-wire.ts
  - packages/core/src/runtime.ts
  - apps/web/test/model-reasoning.test.ts
  - packages/protocol/src/types.ts
  - packages/harness-acp/src/mapping.ts
---
# 模型与推理选项

模型与推理能力来自会话当前的 `TaskDetail.config`，不从模型名称、选项 ID 或预设猜测。ACP v1 将 `model` 定义为模型选择、`thought_level` 定义为推理级别，而 `model_config` 可以是上下文或速度等普通参数；后者按 Agent 原名放在模型附近。分类缺失和未知分类放在输入框的「⋯」里，不被改造成推理控件。选项名称、顺序、描述和实际值均来自 Agent。[ACP v1 会话配置规范](https://agentclientprotocol.com/protocol/v1/session-config-options)

输入框页脚的 `SessionModelControl` 用同一个 `@latch/ui` 模型菜单容纳这些选项，其中思考档位是一行分段控件，菜单不随之关闭。Agent 给各档写了说明时，每一段的提示框是它的说明，选中那一档的说明写在这一行下面，换档时跟着换（手机的「思考」面板里每档也带说明）；只重复档名的说明不显示。桌面使用顶层菜单、键盘单选与搜索；手机由同一原语提供底部面板。身份图标为 16px。没有 `thought_level` 时不伪造禁用滑块：标签写「默认思考」，菜单里一句话说明 Agent 没有报告；只有单个可用值时沿用原语的静态值展示。`model_config` 不改变语义，也不转换成强弱刻度。重复类别按 Agent 顺序取第一个作为主要入口，其余明确的推理和模型参数按原顺序保留；重复值 ID 只保留首个。

新会话用 Harness 上次会话报告或不开会话读到的选项列表（见 [HARNESSES.md](HARNESSES.md#开始前的选项)），和会话里是同一个组件；还没有列表时也不虚构推理能力：`DraftModelControl` 写「默认模型 · 默认思考」，菜单里是读取的入口，不能读取时说明发第一条消息后可以换。

自己带模型的 Harness 的菜单里，「<Harness> 自己的模型」之后是保存的模型服务。Latch 能把这个 Harness 的请求转给它的服务（协议相同，见 [HARNESSES.md](HARNESSES.md#经-latch-使用模型服务)）列出它的模型，组名写「<服务> · 经 Latch」（Codex 还写「实验性」），菜单下面一句说明「经 Latch」，并说一整轮没有经过 Latch 时会话里会告诉你；只用自己认识的模型的 Harness（Codex，`models.knownOnly`）读过自己的列表后，服务里它不认识的模型不能选，写「Codex 不认识这个模型」；其他服务列出但不能选，写明原因（协议不同、转换尚未实现，或这个 Harness 还不能经 Latch）。选中的服务模型是这个 Harness 自己的选择（换 Harness 不带过去，换回来还在），标签写「模型 · 服务」，因为同一个模型名可能在两个服务里；这时思考深度开始后才知道。手机的新会话面板列出相同的内容。会话开始后服务不能换：菜单的第一组写这个服务的名字，只列网关会转发的这个服务的模型，其他服务写「换服务要新开会话：开始时确认的是这个服务。」，菜单下面说请求经 Latch 转给哪个服务，有一轮没有经过 Latch 时改为说明这件事。

## Latch 内置的思考深度

Latch 内置直接调模型服务，所以思考深度来自 设置 › 模型 里对每个模型的声明：`modelCapabilities[model].thinking`，由弱到强的上线值。服务的 `/models` 只给 ID，Latch 不按模型名称猜；设置页按协议给几组常见档位（Chat Completions 的 `reasoning_effort`；Responses 的 `reasoning.effort`；Anthropic 的 `output_config.effort`；Gemini 3 及以后的 `thinkingLevel`），默认不设置。没有声明时输入框写「默认思考」并说明去哪里设置。

选择随 `ModelRef.effort` 走，与模型一样是「下一条」生效：输入框标签为「模型 · 高」，菜单里的「默认 · 低 · 中 · 高」分段只列声明过的档位，换档与换模型一样显示「下一条：…」。会话记在 `TaskSummary.effort`；之后不带模型的输入沿用它，带模型却不带档位的输入回到模型默认值。换到另一个模型时，它也声明了同一档位才保留。Host 在开始前核对档位：请求里未声明的返回 400 `effort-unavailable`，会话记着的档位后来被取消时返回 409，要求重新选择；插件发送前再查一次，从不改成别的档位。Anthropic 的档位是这一强度下的自适应思考：同时发 `thinking: {type: "adaptive"}` 与 `output_config.effort`，不发 token 预算。必须写明 `thinking`，因为 Opus 4.6–4.8 与 Sonnet 4.6 不带它就不思考；Claude 5 系列默认就是自适应思考。Opus 4.5 及更早的模型不接受自适应思考，会返回 400，不要给它们声明档位。

各协议的细节：Responses 发 `reasoning: {effort}`，不请求推理摘要（没有验证的组织请求摘要会被拒），所以只有服务自己发来推理文字时才显示；请求带 `store: false`，因为 Latch 自己保存对话，从不按响应 ID 引用。Gemini 的档位与其他协议一样写成小写（`minimal`、`low`、`medium`、`high`），上线时转成 API 的大写枚举，同时发 `includeThoughts: true`，思考摘要显示在思考里；Gemini 2.5 的 `thinkingBudget` 是 token 数，不是档位，不要给 2.5 声明。思考 tokens 计入输出，也单独记为推理。

服务换协议（设置 › 模型 › 服务页的「协议」，只在这个地址说多种协议时出现）时，Host 清除它为各模型声明的思考深度，图片开关保留；同一请求里给出的新声明照常保存。会话记着的档位随之失效，下一条按上文要求重新选择。

## 配置变更与接线

组件输入为 `config`、`busy: configId | null`、可选 `disabled`、`identity`、`feedback` 与 `onRefresh`，输出为 `onChange(configId, value)`。选项只产生实际 Agent 值的意图，原样交给现有配置提交流程；组件不请求 HTTP、不生成请求 ID、不直接改变 `currentValue`，也不将回调 Promise 的 resolve 视为选中成功。Agent 更新完整配置后，组件从新的 `config.currentValue` 读回选中项和有效选项。

`SessionControls` 增加可选的 `configFeedback: { kind: 'failed' | 'unknown', message }` 与 `onConfigRefresh`，`onConfig` 保留原 Promise。调用方按会话保存真实请求状态：

- 等待中用已有 `configBusy`，阻止继续写入。菜单仍可读，选项有不可操作原因。
- 明确失败保留原 Host 选中值和错误提示；不乐观回滚或虚构另一个成功值。
- 未知结果在入口与菜单中说明，并阻止新的配置写入。`onConfigRefresh` 只读权威状态；刷新失败不解锁。未知请求的重试继续沿用原请求身份，不能因重开菜单而替换请求 ID。

工作台必须同时保护输入框「⋯」中的其他配置入口；不能只锁住这个模型菜单。权限与会话停止状态沿现有 `SessionControls.locked` 和 Host 的设备、启动指纹、项目与模式复查，不因更换控件而放宽。

工作台通过每会话的 `ConfigRequests` 保留不可变请求身份，切换会话后的迟到结果不能解锁另一个请求。旧 Host 不声明回执能力时不发送额外协议字段；未知结果只读回真正的当前值，不再提交一次配置。支持回执的 Host 则必须先得到已结算回执，待处理或未知不能由偶然相同的当前值替代。刷新完成后关闭菜单并将焦点交回入口，避免反馈按钮卸载后丢失键盘位置。普通模型与推理切换没有新增本机确认。

`apps/web/test/model-reasoning.test.ts` 验证语义分类、真实值、排序、无推理能力时不显示空槽、忙碌与未知写入门禁、回调 resolve 不改变选中、手机入口以及安全文本。既有 `components-*.test.ts` 保留 Standard 下一条模型切换覆盖。纯 Node 用例不证明手机面板、键盘焦点或三宽布局已在浏览器通过；这些由真实渲染验证。
