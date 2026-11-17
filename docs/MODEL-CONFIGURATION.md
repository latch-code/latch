---
description: 模型与思考两个控件怎样取值、写入与结算，经 Latch 的服务怎样进入模型菜单，Latch 内置的思考深度与推理带回，默认模型与保存的模型来源，出错时改用、健康、单价、预算与用量的界面，模型服务的编辑。
sources:
  - apps/web/src/composer/ModelControl.tsx
  - packages/protocol/src/model-route.ts
  - apps/web/src/composer/modelReasoning.ts
  - apps/web/src/settings/ProvidersSettings.tsx
  - apps/web/src/settings/ModelSpend.tsx
  - apps/web/src/usage
  - apps/web/src/settings/modelSpend.ts
  - apps/host/src/plugins/providers/chat-wire.ts
  - apps/host/src/plugins/providers/responses-wire.ts
  - apps/host/src/plugins/providers/anthropic-wire.ts
  - packages/core/src/runtime.ts
  - apps/web/test/model-reasoning.test.ts
  - packages/protocol/src/types.ts
  - packages/harness-acp/src/mapping.ts
  - packages/harness-acp/src/runtime.ts
  - packages/harness-acp/src/profiles
---
# 模型与推理选项

模型与推理能力来自会话当前的 `TaskDetail.config`，不从模型名称、选项 ID 或预设猜测。

相邻的文档：

- 模型服务的保存、密钥与路由：[ARCHITECTURE.md](ARCHITECTURE.md)。密钥只在这台 Mac 上填写（`secrets`，只在本机），存在 0600 的 `providers.json`，不返回任何设备。
- 网关的协议、交付、调度、账本与预算：[MODEL-GATEWAY.md](MODEL-GATEWAY.md)。
- Harness 怎样读取与应用选项：[HARNESSES.md](HARNESSES.md#开始前的选项)。

## 选项的分类

按 [ACP v1 会话配置规范](https://agentclientprotocol.com/protocol/v1/session-config-options)：

| 分类 | 去处 |
| --- | --- |
| `model` | 模型控件 |
| `thought_level` | 思考控件 |
| `model_config`（上下文、速度等） | 按 Agent 原名放在模型菜单里；不改变语义，不转成强弱刻度 |
| 缺失或未知 | 输入框的「⋯」，不改造成推理控件 |

- 选项名称、顺序、描述和实际值都来自 Agent；思考的档位用 Agent 自己的名字，不翻译。
- 重复类别按 Agent 顺序取第一个作为主要入口，其余按原顺序保留；重复的值 ID 只留首个。
- 没有 `thought_level` 时不伪造禁用的控件：思考写「默认」，菜单里只有「默认」一行与一句说明。

## 两个控件

模型（`SessionModelControl`）与思考（`SessionThinkingControl`，[ThinkingControl.tsx](../apps/web/src/composer/ThinkingControl.tsx)）是两个控件，手机与桌面用同一份能力与模型列表。

**新会话。** 用 Harness 上次会话报告或不开会话读到的选项列表，和会话里是同一个组件。

- 还没有列表时不虚构能力：`DraftModelControl` 写「默认模型」、`DraftThinkingControl` 写「默认」，即将使用的值；能读取时菜单里是一行读取动作，不加说明文字。
- 草稿换模型时按 Harness 的读取策略取这个模型的思考选项，不沿用另一个模型的档位。
- 人选择的每一项在发送前必须成功应用，否则拒绝本轮。
- 已知权限预设的完整梯度在草稿即可选，列表读回不能覆盖先前的选择。
- Cursor force 显示「启动设置 · 未独立读回」：它的 `source: launch` 与原生报告严格区分，未知回执不能靠本地设置值结清。

**写入与结算。** 菜单出现不等于 Agent 已应用；值总是 Host 确认过的那个。

| 状态 | 行为 |
| --- | --- |
| 进行中 | 只有所属的控件转圈；阻止继续写入，菜单仍可读 |
| 明确失败 | 保留原 Host 选中值和错误提示；不乐观回滚，不虚构另一个成功值 |
| 结果未知 | 两个控件与「⋯」里的其他配置入口都挡住后续写入；不是错误，不出红色横幅 |

结果未知时：

- **核对**由 Host 向 Agent 读取当前设置后结算（[HARNESSES.md](HARNESSES.md)）：读到所选值是 `applied`，读到修改之前的值是 `failed`；第三个值、忙或读不到仍是未知。它会重启 Harness 的进程，「核对」的提示框写明。
- **重试同一请求**只读 Host 的回执，沿用原请求身份，从不再次发送。
- **放弃这次结果**只在核对没能结算之后出现（运行中除外）。它只在这个页面上放下：Host 的回执仍是结果未知、从不再发送；控件显示 Agent 现在报告的值，之后可以作为新请求再选。
- 结算之前不能再选；结算后再选用新的请求编号。

### 组件的接线

- 模型控件只产生意图：`onChange(configId, value)` 原样交给配置提交流程。它不请求 HTTP、不生成请求 ID、不改 `currentValue`，也不把回调 Promise 的 resolve 当作选中成功。Agent 更新配置后从新的 `config.currentValue` 读回。
- 失败与未知的反馈（`feedback`）与核对（`onRefresh`）由调用方按会话的真实请求状态给出（`SessionComposers.tsx` 的 `configFeedback`）。核对只读权威状态，失败不解锁。
- 工作台用每会话的 `ConfigRequests` 保留不可变的请求身份：切换会话后的迟到结果不能解锁另一个请求，重开菜单也不换请求 ID。
- Host 支持回执时必须先得到已结算的回执；待处理或未知不能由偶然相同的当前值代替。Host 不声明回执能力时不发额外字段，未知结果只读回真正的当前值，不再提交一次。
- **切换还在路上时发出的消息、重试与重发都等它结束再发送。** 否则消息先到，会话在这一轮刚开始时拒绝切换（409 `task-running`，回执记为失败），这一轮仍用旧设置。
- 权限与会话停止状态仍由 Host 按设备、启动指纹、项目与模式复查。模型与推理切换没有本机确认。

`apps/web/test/model-reasoning.test.ts` 是纯 Node 用例，不证明手机面板、键盘焦点或三宽布局。

## 经 Latch 的服务

自己带模型的 Harness 的模型菜单先列它原生报告的模型，未报告时保留「默认模型」；之后按 Host 的 `models.wires` 与 `pairRoute` 列出可转发的已保存服务：都在一个来源「Latch 网关」下（不论有哪些服务），每个服务一组，组名写服务名。

- Host 从实际命令所选的 profile 投影能力；客户端不维护另一份协议表。
- 路线声明 `experimental` 时组名带「实验性」标记，全部实验性时左栏的悬停写「Latch 网关 · 实验性」：已实现的转换是 Responses→Chat、Responses→Anthropic、Anthropic→Chat、Anthropic→Responses，可能略去的能力在组名的悬停说明里（`PickerGroup.hint`），菜单里没有说明行；手机点按组名时同一说明分成一句与折起的各项（`BoardNote`）。其他方向不可选。
- 用不了的服务收在「N 个服务用不了」，展开显示原因。`models.wires` 为空的 Harness 只用自己的模型。
- `models.knownOnly`（codex-acp）：只有适配器认识的服务模型可选。Codex 直连可选服务声明但原生 `model/list` 没有的模型。
- 服务选择按 Harness 分别保存，换 Harness 不带过去。控件显示模型 ID 与服务标记，避免同名模型混淆。
- 草稿选了服务模型时，思考选项来自 Host 下发的 `HarnessInfo.serviceOptions`（按服务与模型，[HARNESSES.md](HARNESSES.md#开始前的选项)），不用 Harness 自己模型的档位：Codex 直连由 Host 按服务声明的档位投影（`declared`，与会话提供的选项 ID、取值相同）；其他 Harness 用经网关的会话报告过的（`session`）。两者都没有时只有「默认」。Codex 直连（`models.serviceThinking`）的「默认」不发档位，悬停说明它是模型服务的默认，会话里也一样，不写「用 Codex 的默认值」；其他 Harness 的「默认」是它自己的默认。

**模型值的编码。** 显示总取服务的模型 ID；Agent 的配置值按 profile 的精确编码应用、读回和恢复，不用去前缀或模糊匹配把另一个 provider 的同名模型当成当前服务。

| Harness | 配置值 |
| --- | --- |
| OpenCode | `latch/<模型>` |
| pi | `latch-gateway/<模型>` |
| DeepSeek Harness | provider 与模型组成的 JSON 二元组 |

- pi 只列它实际成功注册的服务模型（[pi 运行预算](MODEL-GATEWAY.md#pi-运行预算)）。运行预算不显示为上下文上限或费用。
- Claude 的网关会话同样隐藏 CLI 对自定义模型推测的容量与价格。

**会话开始之后**

- 会话的模型菜单与新会话的一样分组：Harness 自己的模型（会话在服务上时取 `HarnessInfo.catalogue`，没有列表时只有「默认模型」），再是每个能用的服务，当前的打勾。会话所在服务的组列会话报告的值，选它原地换；其他组的值是 `serviceChoice`／`ownChoice`，选它让会话换路线（[MODEL-GATEWAY.md](MODEL-GATEWAY.md#会话中换路线)），控件照常显示切换中、失败与结果未知。
- `models.routeSwitch` 为 `services` 的 Harness（Grok Build、goose）在服务与自己的登录之间的选项不可选，悬停写原因；没有 `routeSwitch` 的写「开始后不能换服务」。
- 已确认的新模型在进程或 Host 重启后继续使用；服务清单删了旧模型而保留当前模型时仍可恢复。`modelRoute.model` 跟随会话当前的服务模型。
- 服务名经 `modelRoute.name` 展示。停用、删除、缺密钥或地址未确认时组名写状态，菜单写一行原因并阻止继续。服务的协议或地址变了不自动迁移会话。
- 整轮回复却没有请求经过网关时显示 bypassed，菜单写一行琥珀色提示；这不证明其他辅助调用都经过网关。
- 手机的选择表没有悬停：点按服务的组名显示这段说明，再点收起。
- 菜单只有选项：请求经 Latch 转发、用谁的密钥、协议转换略去什么、凭据被继承、会话开始时定下的「出错时改用」都在服务组名的悬停说明里。由备选回答的一轮，作者行写回答的服务与模型加「备选」标签。内置 Harness 的这种轮次只记由备选回答的步骤（`routed.direct`）。

**Codex 的思考。** 用网关模型时菜单只列「默认」与该服务声明的档位；「默认」遵循模型服务，不继承 Codex 本机配置的档位。规则见 [MODEL-GATEWAY.md](MODEL-GATEWAY.md#harness-交付)。

## Latch 内置的思考深度

Latch 内置直接调模型服务，思考深度来自 设置 › 模型 里对每个模型的声明：`modelCapabilities[model].thinking`，由弱到强的上线值。

- 服务的 `/models` 不报思考档位，Latch 不按模型名猜。设置页按协议给几组常见档位，默认不设置。
- 同一行有一个可选的上下文长度（token），交给经网关的 Harness；列表报了长度时预填（[MODEL-GATEWAY](MODEL-GATEWAY.md#凭据)）。
- 没有声明时思考写「默认」，点开说明去哪里设置。

**选择。** 随 `ModelRef.effort` 走，与模型一样「下一条」生效，两个菜单都有「撤销切换」。

- 会话记在 `TaskSummary.effort`。之后不带模型的输入沿用它；带模型却不带档位的输入回到模型默认值。换到另一个模型时，它也声明了同一档位才保留。
- Host 在开始前核对：请求里未声明的档位 400 `effort-unavailable`；会话记着的档位后来被取消时 409，要求重新选择。插件发送前再查一次，从不改成别的档位。
- 服务换协议时，Host 清除它为各模型声明的思考深度（图片开关保留；同一请求里给出的新声明照常保存）。会话记着的档位随之失效。

**各协议发什么**

| 协议 | 请求 |
| --- | --- |
| Chat Completions | `reasoning_effort` |
| Responses | `reasoning: {effort}`，`store: false`（Latch 自己保存对话，从不按响应 ID 引用）；不请求推理摘要，所以只有服务自己发来推理文字时才显示 |
| Anthropic | `thinking: {type: "adaptive"}` 加 `output_config.effort`，不发 token 预算。必须写明 `thinking`：Opus 4.6–4.8 与 Sonnet 4.6 不带它就不思考。Opus 4.5 及更早的模型不接受自适应思考，会返回 400，不要给它们声明档位 |

思考 tokens 计入输出，也单独记为推理。

**工具循环里的推理。** 一轮里模型调用工具、拿到结果再继续时，Anthropic 与 Responses 要求把这一轮已给出的推理原样带回。Latch 内置因此保存服务签过名或加密的推理，在同一轮的后续请求里带回：

- **Anthropic**：`thinking`（连同 `signature`）与 `redacted_thinking`（`data`）块按到达时的位置与文字、工具调用一起原样发回。有思考块缺少签名时整段不带。
- **Responses**：选了思考深度时请求 `include: ["reasoning.encrypted_content"]`（不推理的模型会拒绝这个字段，所以没有档位时不发）。带加密内容的推理项与同一回复的消息项原样发回，工具调用带上它的项 ID；只在完成事件里补上加密内容的服务也能用。推理项没有加密内容时整段不带。
- **只在当前这一轮**（最后一条用户消息之后）带回。之前各轮不带推理：Latch 改了系统说明或工具列表之后，旧的推理不会让服务拒绝请求；代价是新的一轮读不到上一轮的推理。
- **只带回同一协议、同一服务、同一模型给出的**；换了模型、服务换了协议，或历史与当时的回复对不上时不带。
- 推理保存在 Host 的会话历史里（每个工具调用至多 1 MiB，超过就不保存），下一条用户输入开始时删除。它不进入会话详情、SSE、快照、审计与日志；界面只显示服务给出的推理文字。
- 真实服务上的表现没有核对过；测试用本机的假模型服务。

## 默认模型

新会话的模型按这个顺序取（`server.ts` 的 `projectDefaultModel`、`savedGateway`）：

1. 会话里的选择。带了模型的请求；在自己带模型的 Harness 的菜单里选它自己的「默认」（请求带 `ownModel: true`，页面记住这个选择）；分叉沿用来源会话。带任何开始选项（`config`）的请求不套用项目默认；其中有模型类选项时也不套用第 4 项。
2. Agent 的模型。Agent 为自己的 Harness 保存的选项（`engineOptions`）算 Agent 的选择：交互开始时作为 `config` 发出，定时运行的计划也不套用项目默认。
3. 项目的「默认模型」。
4. 在这台 Mac 上为这个 Harness 固定的模型来源（见下）；我的 Agent 的会话与不带私有上下文的会话不用它。
5. Harness 自己的默认。

**项目的默认模型**

- 只存在 Host 的项目记录（`settings.json` 的 `workspaces[].defaultModel`），不写进仓库。改它要 `admin`，写 `workspace.changed`（`modelChanged`）。
- 它现在不能用，或这个 Harness 不能经 Latch 用它时不算数，会话照常开始。
- 思考档位只对内置 Harness 带上，且要仍在声明里。
- 这台设备在 Latch 内置上选过的模型照旧被记住并排在项目默认之前；只有还没选过模型的设备跟随项目默认。

**固定的 Harness 与模型来源**

- 没有保存过 Harness 时，默认是有模型的 Latch 内置，否则是第一个就绪、能运行命令、自带模型的 Harness，用它自己的默认模型；输入框里的选择替代它。
- 在模型菜单里把自带模型的 Harness 的网关模型设为默认时，`PUT /preferences` 的 `defaults.gateway` 与 `harnessId` 一起保存进 `settings.json`。要 `admin` 且只在这台 Mac 的桌面端；Harness 必须就绪且不是 Latch 内置，路线当场核对（`modelRouteFor`）。
- 每次投影默认值时用当前启用的服务、模型清单与可用协议重新校验：失效时给 `gatewayUnavailable`，要求重选，不悄悄换成别的。
- 它只在保存的默认 Harness 就是这个 Harness 时生效。

## 出错时改用与健康

规则在 [MODEL-GATEWAY.md](MODEL-GATEWAY.md#调度)，这里是界面。

- 模型行的「⋯」打开「出错时改用」：从已保存的服务里选模型并排序，写进该服务的 `fallbacks`。服务页「连接」里的「同时请求」设并发上限，默认「不限」。两者都要 `admin`，其他设备只读。
- 健康状态只在不正常时出现：变慢、额度用完、请求过多是琥珀色，出错中、密钥无效是红色；悬停或聚焦写最近一次失败的分类与时间。带结束时间的状态过了就不再显示（[健康与熔断](MODEL-GATEWAY.md#健康与熔断)）。
- 模型菜单只在出错中、额度用完、密钥无效时在服务的组名里写状态词。

## 单价、预算与用量

规则与存储在 [MODEL-GATEWAY.md](MODEL-GATEWAY.md#用量花费与预算)，这里是界面。

- **单价**在模型行的「⋯」里；**本月预算**在服务页「连接」与 Agent 设置「执行方式」里。两者单独保存，不跟服务或 Agent 的其他修改一起提交，要 `admin`。
- 预算是一个限额窗口，与 Harness 的窗口同一画法：到 80% 条与数字写琥珀色，用完写红色；说明写明按这台 Mac 的时间算月。
- 按花费设预算前，它覆盖的模型都要先填这个币种的单价，否则保存被拒绝并写明缺哪些模型。
- **用量**在「额度与用量」的用量视图（[DESIGN.md](DESIGN.md#组件)「额度与用量」），对所有能查看的设备开放；设置里只有单价与预算。没有服务报告的数写「未报告」，不写 0；花费标「估算」与依据（「按你填的单价」或服务报告），并写出未计价请求的比例。
- 同一视图也算 Harness 用自己登录跑的轮次与内置 Harness 用插件服务的轮次（`POST /link/api/usage`，[MODEL-GATEWAY.md](MODEL-GATEWAY.md#网关以外的轮次)），可按来源只看一种；「全部来源」时一样东西一行，来源的比例画在行里。演示模型的轮次不计。花费的依据在「估算」上点按或悬停可见。
- 这台设备读不到的会话、已删除的会话与没有会话的请求并成「其他会话」一行；不属于 Agent 或这台设备不能读 Agent 时并成「其他」。
- 按花费的预算有算不出花费的请求时写「未计入 N 次」。
- 一轮的页脚在花费已知时写花费；这一轮让某个预算到 80% 或用完时写对应的琥珀或红色字样。

## 模型服务的编辑

更新现有服务的地址、协议、密钥或确认其地址时，`PUT /providers/:id` 要带 `expectedTarget`：当前看到的 `baseURL` 与 `kind`。修改后的地址仍放在请求的 `baseURL`。

- Host 在准备本机确认时和进入串行写入后各复核一次预期目标，地址按凭据绑定的源和路径比较。
- 改变目标的请求缺少预期目标，或目标已经变了：直接拒绝。
- 收紧操作与不改变目标的普通设置不需要它。
