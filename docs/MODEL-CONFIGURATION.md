---
description: Agent 上报的模型、推理级别和模型参数如何进入同一选择菜单，以及权威选中值与未知结果的接线。
sources:
  - apps/web/src/composer/ModelControl.tsx
  - apps/web/src/composer/modelReasoning.ts
  - apps/web/test/model-reasoning.test.ts
  - packages/protocol/src/types.ts
  - packages/harness-acp/src/mapping.ts
---
# 模型与推理选项

模型与推理能力来自会话当前的 `TaskDetail.config`，不从模型名称、选项 ID 或预设猜测。ACP v1 将 `model` 定义为模型选择、`thought_level` 定义为推理级别，而 `model_config` 可以是上下文或速度等普通参数；后者按 Agent 原名放在模型附近。分类缺失和未知分类放在输入框的「⋯」里，不被改造成推理控件。选项名称、顺序、描述和实际值均来自 Agent。[ACP v1 会话配置规范](https://agentclientprotocol.com/protocol/v1/session-config-options)

输入框页脚的 `SessionModelControl` 用同一个 `@latch/ui` 模型菜单容纳这些选项，其中思考档位是一行分段控件，菜单不随之关闭。桌面使用顶层菜单、键盘单选与搜索；手机由同一原语提供底部面板。身份图标为 16px。没有 `thought_level` 时不留推理占位或伪造禁用滑块；只有单个可用值时沿用原语的静态值展示。`model_config` 不改变语义，也不转换成强弱刻度。重复类别按 Agent 顺序取第一个作为主要入口，其余明确的推理和模型参数按原顺序保留；重复值 ID 只保留首个。

Standard 的模型选择继续使用真实 `ModelRef` 与“下一条”草稿语义，没有新增推理字段。新会话尚未得到 Agent 的会话配置时也不虚构推理能力。

## 配置变更与接线

组件输入为 `config`、`busy: configId | null`、可选 `disabled`、`identity`、`feedback` 与 `onRefresh`，输出为 `onChange(configId, value)`。选项只产生实际 Agent 值的意图，原样交给现有配置提交流程；组件不请求 HTTP、不生成请求 ID、不直接改变 `currentValue`，也不将回调 Promise 的 resolve 视为选中成功。Agent 更新完整配置后，组件从新的 `config.currentValue` 读回选中项和有效选项。

`SessionControls` 增加可选的 `configFeedback: { kind: 'failed' | 'unknown', message }` 与 `onConfigRefresh`，`onConfig` 保留原 Promise。调用方按会话保存真实请求状态：

- 等待中用已有 `configBusy`，阻止继续写入。菜单仍可读，选项有不可操作原因。
- 明确失败保留原 Host 选中值和错误提示；不乐观回滚或虚构另一个成功值。
- 未知结果在入口与菜单中说明，并阻止新的配置写入。`onConfigRefresh` 只读权威状态；刷新失败不解锁。未知请求的重试继续沿用原请求身份，不能因重开菜单而替换请求 ID。

工作台必须同时保护输入框「⋯」中的其他配置入口；不能只锁住这个模型菜单。权限与会话停止状态沿现有 `SessionControls.locked` 和 Host 的设备、启动指纹、项目、模式与本机确认复查，不因更换控件而放宽。

工作台通过每会话的 `ConfigRequests` 保留不可变请求身份，切换会话后的迟到结果不能解锁另一个请求。旧 Host 不声明回执能力时不发送额外协议字段；未知结果只读回真正的当前值，不再提交一次配置。支持回执的 Host 则必须先得到已结算回执，待处理或未知不能由偶然相同的当前值替代。刷新完成后关闭菜单并将焦点交回入口，避免反馈按钮卸载后丢失键盘位置。普通模型与推理切换没有新增本机确认。

`apps/web/test/model-reasoning.test.ts` 验证语义分类、真实值、排序、无推理能力时不显示空槽、忙碌与未知写入门禁、回调 resolve 不改变选中、手机入口以及安全文本。既有 `components-*.test.ts` 保留 Standard 下一条模型切换覆盖。纯 Node 用例不证明手机面板、键盘焦点或三宽布局已在浏览器通过；这些由真实渲染验证。
