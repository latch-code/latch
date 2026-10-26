---
description: 从目录失效会话的已结算历史显式选择有效项目继续，保留草稿与未知请求身份。
sources:
  - apps/web/src/components/WorkspaceRecovery.tsx
  - apps/web/src/components/workspaceRecovery.ts
  - apps/web/test/workspace-recovery.test.ts
  - apps/host/src/forks.ts
  - apps/host/src/server.ts
  - apps/host/test/fork-recovery.test.ts
---
# 项目目录变化后的继续方式

会话固定创建时的文件夹身份。文件夹丢失、替换或移出项目后，Host 以 `workspace-changed` 拒绝继续运行；读取已保存的会话记录仍需原有的查看权限，但不要求旧文件夹可用。恢复不会改写旧会话的目录。

`WorkspaceRecovery` 在原会话内提供项目选择和“在所选项目继续”。它只产生一个分叉意图：`taskId`、已结束回复的 `upToMessageId` 与用户明确选择的 `workspaceId`。上层保留当前草稿，进入新会话的待发送状态，用户下一次发送才调用既有 `POST /tasks`。组件本身不请求 Host、不发送提示、不生成请求 ID，也不清理原会话或草稿。

工作台已接入这个流程：确定的目录拒绝由恢复面板解释，不再叠加失败红条；原输入仍可编辑，发送被阻止。手机继续到新会话时，面板把焦点交还草稿，不再重新聚焦 Agent 选择。`e2e/workspace-recovery.e2e.ts` 通过真实临时 Host、已删除的原文件夹和有效保存项目，验证三宽的草稿、焦点与用户明确发送前没有创建请求。

## 受控输入与接线

`apps/web/src/components/WorkspaceRecovery.tsx` 接收完整 `source: TaskDetail`、当前 `workspaces`、受控的 `workspaceId` / `onWorkspaceChange`，以及下列真实状态：

- `forkSupported` 只在 `catalog.features.fork === true` 时传入 `true`。旧 Host 缺少能力时显示不能继续的原因。
- `runGate` 为 `{ allowed: true }` 或 `{ allowed: false, reason }`。调用方使用当前设备的 `run` 权限和实际所选 Harness 的启动门禁；原因沿用已有权限文案。组件展示判断不替代 Host 授权。
- `local` 表示当前请求确实经 `host.sock`，不能把回环浏览器当本机。`harness` 传入真正用于新会话的 Harness 名称和文件夹数量限制。
- `phase` 为 `idle`、`busy` 或 `unknown`。未知提交仍恢复原请求的原始请求体和 `requestId`；不能将未知结果转成一次新的分叉。正在取消或运行的来源也先等真实结算。
- `onFork(taskId, upToMessageId, workspaceId)` 仅准备分叉草稿。上层保留现有草稿及其附件语义，不自动发送，继续沿用正常提交、授权复查与 L3 本机确认流程。

组件要求显式保存的当前可用项目，排除不可用文件夹、不允许远程启动的项目与超出所选 Harness 文件夹数量上限的项目。`default` 不作为恢复目标：普通分叉有意复用 Host 已知的自有默认会话目录，不能借此避开旧目录失效。添加或修复项目后，上层更新项目列表即可原地重新选择；失效的旧选择不会自动回退到其他项目。

来源最后一个可用边界为已结束的助手回复，其前缀不能包含排队、运行或等待审批的消息。没有回复、来源仍运行或上次提交结果未知时，操作保留可见并说明原因。项目列表与来源历史分别判断，旧项目不存在不妨碍选择有效的新项目。

## Host 仍是权威

既有 `POST /tasks` 同时接受 `forkOf: { taskId, upToMessageId }` 和显式 `workspaceId`。Host 从持久历史生成有界的背景文本，再核对新项目、文件夹身份、设备权限与 Harness；客户端不提交历史。显式保存项目使用新项目的根，跳过默认自有会话目录的复用路径。文件不会复制或回滚，隐藏推理和原工具参数也不进入分叉种子；种子上限与来源记录见 [ARCHITECTURE.md](./ARCHITECTURE.md#会话分叉)。

`apps/host/test/fork-recovery.test.ts` 使用临时 Host 验证旧自有文件夹真实删除后：继续原会话被拒绝、历史可读、无效目标被拒绝、有效保存项目产生新会话、精确重试不重复创建。`apps/web/test/workspace-recovery.test.ts` 覆盖未知结果、忙碌、权限与能力缺失、目标变化、历史边界以及项目名的隐藏字符展示。浏览器中的原地选择、草稿焦点和实际发送由工作台集成用例验证；纯 Node 用例不证明这些浏览器交互或真实系统确认已通过。
