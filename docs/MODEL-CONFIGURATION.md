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
  - packages/harness-acp/src/runtime.ts
  - packages/harness-acp/src/profiles
---
# 模型与推理选项

模型与推理能力来自会话当前的 `TaskDetail.config`，不从模型名称、选项 ID 或预设猜测。ACP v1 将 `model` 定义为模型选择、`thought_level` 定义为推理级别，而 `model_config` 可以是上下文或速度等普通参数；后者按 Agent 原名放在模型附近。分类缺失和未知分类放在输入框的「⋯」里，不被改造成推理控件。选项名称、顺序、描述和实际值均来自 Agent。[ACP v1 会话配置规范](https://agentclientprotocol.com/protocol/v1/session-config-options)

输入框里模型与思考是两个控件：`SessionModelControl` 在左边，只写模型（等宽的 ID，经服务时前面是服务的标记），菜单里还有 `model_config`；`SessionThinkingControl`（[ThinkingControl.tsx](../apps/web/src/composer/ThinkingControl.tsx)）在右边挨着权限，写小字「思考」与当前一档。思考的菜单每档一行，用 Agent 自己的名字（Codex 写 `Low`、`High`，不翻译），菜单常驻只保留档位名称、分组和勾选；真实不可用、未知结果与未独立读回的说明仍可见。桌面使用顶层菜单、键盘单选与搜索；手机由同一原语提供底部面板。Harness 的标记为 16px，服务的标记 14px。没有 `thought_level` 时不伪造禁用滑块：思考写「默认」，不画箭头，但仍能点开，菜单里只有「默认」一行和一句话说明 Agent 没有报告。一次写入进行中时只有它所属的控件转圈，2 秒后写「等 <Harness> 回应…」；结果未知时两个控件都挡住后续写入，只有这次修改所属的控件写「· 结果未知」，值仍是 Host 确认过的那个，菜单里给「核对」。输入框上方的一条写出所选的值、时间、「结果未知」、「核对」与「重试同一请求」，不是错误，不出红色横幅。核对由 Host 向 Agent 读取当前设置后结算（[HARNESSES.md](./HARNESSES.md)）：所选值是 `applied`，修改之前的值是 `failed`，第三个值、忙或读不到仍是未知，提示写出原因；「核对」旁的 ⓘ 说明它会重启 Harness 的进程；核对没能结算（读到第三个值、读不到或出错，运行中除外）之后，这一条多一个「放弃这次结果」：只在这个页面上放下它，Host 的回执仍是结果未知、从不再发送，控件显示 Agent 现在报告的值，之后可以作为新请求再选；结算之前不能再选，结算后再选用新的请求编号。重试同一请求只读 Host 的回执，从不再次发送。`model_config` 不改变语义，也不转换成强弱刻度。重复类别按 Agent 顺序取第一个作为主要入口，其余明确的推理和模型参数按原顺序保留；重复值 ID 只保留首个。

新会话用 Harness 上次会话报告或不开会话读到的选项列表（见 [HARNESSES.md](HARNESSES.md#开始前的选项)），和会话里是同一个组件；还没有列表时也不虚构推理能力：`DraftModelControl` 写「默认模型」、`DraftThinkingControl` 写「默认」，模型菜单里是读取的入口（打开思考也会读取），不能读取时各自说明发第一条消息后可以换。

自己带模型的 Harness 的模型菜单先列它原生报告的模型，未报告时保留「默认模型」。之后按 Host 的 `models.wires` 与 `pairRoute` 列出可转发的已保存服务，分组写「<服务> · 经 Latch」；只有路线声明 `experimental` 时显示实验性。原生 Codex 通过 app-server 使用 Responses 服务，可选服务声明但原生 `model/list` 没有的模型，不带 `knownOnly` 限制。仍走 `codex-acp` 后备适配器的定义保留 `models.knownOnly`：只有适配器认识的服务模型可选。Claude Agent 使用 Anthropic 同协议服务或实验性 Chat、Responses 转换，公开会话设置中的 modelPicker 保留服务的原始模型 ID；Gemini CLI 使用 Gemini 服务；OpenCode、pi 和 DeepSeek Harness 可以分别使用四种同协议服务。Host 从实际命令所选的 profile 投影能力，客户端不维护另一份预设协议表。协议入口、最低版本与交付见 [MODEL-GATEWAY.md](MODEL-GATEWAY.md)。

网关优先同协议转发；只有已实现的 Responses→Chat、Anthropic→Chat、Anthropic→Responses 互译可选，分组标「实验性」，菜单末尾的「协议转换」说明可能略去的能力。其他方向仍不可选。用不了的服务收在「N 个服务用不了」，展开显示原因；`models.wires` 为空的 Harness 只用自己的模型。服务选择按 Harness 分别保存，换 Harness 不带过去。控件显示模型 ID 与服务标记，避免同名模型混淆；草稿思考选项仍以该 Harness 对所选模型实际能提供的列表为准，服务声明不会被误当成原生会话读回。手机与桌面使用同一份能力与模型列表，不能以菜单出现代替 Agent 已应用。

经服务的模型 ID 与 Agent 的配置值分别处理：OpenCode 使用 `latch/<模型>`，pi 使用 `latch-gateway/<模型>`，DeepSeek Harness 使用 provider 与模型组成的 JSON 二元组；显示仍取服务模型 ID。Host 按 profile 的精确编码来应用、读回和恢复，不用去前缀或模糊匹配把另一个 provider 的同名模型当成当前服务。pi 只列它实际成功注册的服务模型；官方目录没有明确运行上限、又未配置高级运行预算的模型不能开始，详见 [MODEL-GATEWAY.md](MODEL-GATEWAY.md#pi-运行预算)。预算不是服务报告的容量或价格，不显示为上下文上限或费用。Claude 网关会话同样隐藏 CLI 对自定义模型推测的容量与价格，只显示它报告的已用上下文 token 与上游真实用量。

会话开始后不能换服务，只在原服务内换模型。会话模型选项受网关凭据的模型列表约束；已确认的新模型在进程或 Host 重启后继续使用，服务清单删除旧模型而保留当前模型时仍可恢复。Host 保存的服务名通过 `modelRoute.name` 展示，停用、删除、缺密钥或地址未确认时给出不可用原因并阻止继续使用。服务协议或地址变化不自动迁移会话。整轮回复却没有请求经过网关时显示 bypassed 并说明；这不能证明其他辅助调用均经过网关。

## Latch 内置的思考深度

Latch 内置直接调模型服务，所以思考深度来自 设置 › 模型 里对每个模型的声明：`modelCapabilities[model].thinking`，由弱到强的上线值。服务的 `/models` 只给 ID，Latch 不按模型名称猜；设置页按协议给几组常见档位（Chat Completions 的 `reasoning_effort`；Responses 的 `reasoning.effort`；Anthropic 的 `output_config.effort`；Gemini 3 及以后的 `thinkingLevel`），默认不设置。没有声明时思考写「默认」，点开说明去哪里设置。

选择随 `ModelRef.effort` 走，与模型一样是「下一条」生效：模型控件写模型，思考控件写「高」，思考菜单里「默认 · 低 · 中 · 高」只列声明过的档位；换档时思考写「下一条：低」，换模型时模型写「下一条：…」，两个菜单都有「撤销切换」。会话记在 `TaskSummary.effort`；之后不带模型的输入沿用它，带模型却不带档位的输入回到模型默认值。换到另一个模型时，它也声明了同一档位才保留。Host 在开始前核对档位：请求里未声明的返回 400 `effort-unavailable`，会话记着的档位后来被取消时返回 409，要求重新选择；插件发送前再查一次，从不改成别的档位。Anthropic 的档位是这一强度下的自适应思考：同时发 `thinking: {type: "adaptive"}` 与 `output_config.effort`，不发 token 预算。必须写明 `thinking`，因为 Opus 4.6–4.8 与 Sonnet 4.6 不带它就不思考；Claude 5 系列默认就是自适应思考。Opus 4.5 及更早的模型不接受自适应思考，会返回 400，不要给它们声明档位。

各协议的细节：Responses 发 `reasoning: {effort}`，不请求推理摘要（没有验证的组织请求摘要会被拒），所以只有服务自己发来推理文字时才显示；请求带 `store: false`，因为 Latch 自己保存对话，从不按响应 ID 引用。Gemini 的档位与其他协议一样写成小写（`minimal`、`low`、`medium`、`high`），上线时转成 API 的大写枚举，同时发 `includeThoughts: true`，思考摘要显示在思考里；Gemini 2.5 的 `thinkingBudget` 是 token 数，不是档位，不要给 2.5 声明。思考 tokens 计入输出，也单独记为推理。

**工具循环里的推理。** 一轮里模型调用工具、拿到结果再继续时，Anthropic 与 Responses 要求把这一轮已经给出的推理原样带回，否则模型失去这一轮前面的推理，Anthropic 还可能悄悄关掉这次请求的思考。Latch 内置因此保存服务签过名或加密的推理，并在同一轮的后续请求里带回：

- Anthropic：回复里的 `thinking`（连同 `signature`）与 `redacted_thinking`（`data`）块按到达时的位置与文字、工具调用一起原样发回，因为思考块可以夹在文字与工具调用之间，顺序不能变。有思考块缺少签名时整段不带。
- Responses：请求带 `store: false`；选了思考深度时同时请求 `include: ["reasoning.encrypted_content"]`（不推理的模型会拒绝这个字段，所以没有档位时不发）。回复里带加密内容的推理项与同一回复的消息项原样发回，工具调用带上它的项 ID；只在完成事件里补上加密内容的服务也能用。推理项没有加密内容时整段不带，因为不存储时服务找不到它。
- 只在当前这一轮（最后一条用户消息之后）带回；之前各轮按原来的样子发送，不带推理。这样 Latch 改了系统说明或工具列表之后，旧的推理不会让服务拒绝请求，代价是新的一轮不能读到上一轮的推理。
- 只带回同一协议、同一服务、同一模型给出的推理；换了模型、服务换了协议，或历史与当时的回复对不上时，都按原来的样子发送。
- 推理保存在 Host 的会话历史里（每个工具调用至多 1 MiB，超过就不保存），下一条用户输入开始新的一轮时删除，因为之后不会再发回；Gemini 的 `thoughtSignature` 之后各轮都带回，一直保留。推理不进入会话详情、SSE、快照、审计与日志；界面只显示服务给出的推理文字。Opus 4.7、4.8 与 Claude 5 系列默认不返回思考文字（`display: "omitted"`），Responses 也不请求推理摘要，所以界面常常没有推理文字，推理照样带回。
- 真实服务上的表现没有在测试里核对过；测试用本机的假模型服务。

服务换协议（设置 › 模型 › 服务页的「协议」，只在这个地址说多种协议时出现）时，Host 清除它为各模型声明的思考深度，图片开关保留；同一请求里给出的新声明照常保存。会话记着的档位随之失效，下一条按上文要求重新选择。

## 配置变更与接线

组件输入为 `config`、`busy: configId | null`、可选 `disabled`、`identity`、`feedback` 与 `onRefresh`，输出为 `onChange(configId, value)`。选项只产生实际 Agent 值的意图，原样交给现有配置提交流程；组件不请求 HTTP、不生成请求 ID、不直接改变 `currentValue`，也不将回调 Promise 的 resolve 视为选中成功。Agent 更新完整配置后，组件从新的 `config.currentValue` 读回选中项和有效选项。

`SessionControls` 增加可选的 `configFeedback: { kind: 'failed' | 'unknown', message }` 与 `onConfigRefresh`，`onConfig` 保留原 Promise。调用方按会话保存真实请求状态：

- 等待中用已有 `configBusy`，阻止继续写入。菜单仍可读，选项有不可操作原因。
- 明确失败保留原 Host 选中值和错误提示；不乐观回滚或虚构另一个成功值。
- 未知结果在入口与菜单中说明，并阻止新的配置写入。`onConfigRefresh` 只读权威状态；刷新失败不解锁。未知请求的重试继续沿用原请求身份，不能因重开菜单而替换请求 ID。

工作台必须同时保护输入框「⋯」中的其他配置入口；不能只锁住这个模型菜单。权限与会话停止状态沿现有 `SessionControls.locked` 和 Host 的设备、启动指纹、项目与模式复查，不因更换控件而放宽。

工作台通过每会话的 `ConfigRequests` 保留不可变请求身份，切换会话后的迟到结果不能解锁另一个请求。旧 Host 不声明回执能力时不发送额外协议字段；未知结果只读回真正的当前值，不再提交一次配置。支持回执的 Host 则必须先得到已结算回执，待处理或未知不能由偶然相同的当前值替代。刷新完成后关闭菜单并将焦点交回入口，避免反馈按钮卸载后丢失键盘位置。切换还在路上时发出的消息、重试与重发提交都等它结束再发送：否则消息先到，这一轮刚开始时会话拒绝这次切换（409 `task-running`，回执记为失败），这一轮仍用旧设置（`e2e/harness-options.e2e.ts`）。普通模型与推理切换没有新增本机确认。

`apps/web/test/model-reasoning.test.ts` 验证语义分类、真实值、排序、无推理能力时不显示空槽、忙碌与未知写入门禁、回调 resolve 不改变选中、手机入口以及安全文本。既有 `components-*.test.ts` 保留 Standard 下一条模型切换覆盖。纯 Node 用例不证明手机面板、键盘焦点或三宽布局已在浏览器通过；这些由真实渲染验证。

草稿换模型时按 Harness 的读取策略获取这个模型的思考选项，不沿用另一个模型的档位；人选择的每项在发送前必须成功应用，否则拒绝本轮。已知权限预设的完整梯度在草稿即可选，列表读回不能覆盖先前选择。Gemini 的私有系统设置与 Cursor force 显示「启动设置 · 未独立读回」；它们的 `source: launch` 与原生报告严格区分，未知回执不能靠本地设置值结清。
