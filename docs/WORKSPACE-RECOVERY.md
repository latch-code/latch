---
description: 从目录失效会话的已结算历史显式选择有效项目继续，保留草稿与未知请求身份。
sources:
  - apps/web/src/composer/WorkspaceRecovery.tsx
  - apps/web/src/composer/workspaceRecovery.ts
  - apps/web/test/workspace-recovery.test.ts
  - apps/host/src/forks.ts
  - apps/host/src/server.ts
  - apps/host/test/fork-recovery.test.ts
---
# 项目目录变化后的继续方式

会话固定创建时的文件夹身份。文件夹丢失、被替换或移出项目后，Host 以 409 `workspace-changed` 拒绝继续运行。

- 读取已保存的会话记录仍只需要原有的查看权限，不要求旧文件夹可用。
- 恢复不改写旧会话的目录，而是从它已结算的历史分叉到一个人明确选择的项目。
- 我的 Agent 与「通用」的聊天不用这套恢复：它们的家由 Host 自己建立与核对，从不让人选文件夹（[CUSTOM-AGENTS.md](CUSTOM-AGENTS.md#家与工具)）。

## 恢复面板

`WorkspaceRecovery`（`apps/web/src/composer/WorkspaceRecovery.tsx`）在原会话的输入框上方给出项目选择与「在新会话中继续」。确定的目录拒绝由它说明，不再叠加失败横幅；原输入仍可编辑，发送被阻止。

**它只产生一个分叉意图**：`taskId`、已结束回复的 `upToMessageId` 与人选的 `workspaceId`。

- 组件不请求 Host、不发送提示、不生成 `requestId`，也不清理原会话或草稿。
- 上层（`onFork`）保留当前草稿与附件，进入新会话的待发送状态；人下一次发送才调用 `POST /tasks`，沿用正常的提交与授权复查。

**可选的项目**（`recoveryWorkspaces`）：显式保存、当前可用的项目，排除有不可用文件夹的与超出所选 Harness 文件夹数量上限的。

- `default` 不作恢复目标：普通分叉有意复用 Host 的默认自有会话目录，不能借它绕过旧目录失效。
- 添加或修复项目后，上层更新项目列表即可原地重新选择；失效的旧选择不自动退到别的项目。

**分叉边界**（`recoveryMessage`）是最后一条已结束、有正文的助手回复，它之前不能有排队、运行或等待审批的消息。项目列表与来源历史分别判断。

**不能继续时操作仍可见，并写出原因**（`workspaceRecovery`，按这个顺序判断）：

| 情况 | 输入 |
| --- | --- |
| 上次提交的结果未知 | `phase: 'unknown'`。未知的提交仍恢复原请求体与原 `requestId`，**不能转成一次新的分叉** |
| 正在处理原会话 | `phase: 'busy'` |
| 来源仍在运行、等待审批或取消中 | 等真实结算 |
| Host 不支持分叉 | `forkSupported` 只在 `catalog.features.fork === true` 时为真 |
| 当前设备不能启动 | `runGate: { allowed: false, reason }`，来自设备的 `run` 权限与所选 Harness 的启动门禁；原因沿用已有的权限文案 |
| 没有已结束的回复、没有可用项目，或选择已失效 | — |

这些判断只管显示，不代替 Host 的授权。

## Host 仍是权威

`POST /tasks` 同时接受 `forkOf: { taskId, upToMessageId }` 与显式的 `workspaceId`。

- Host 从持久历史生成有界的背景文本；客户端不提交历史。
- Host 再核对新项目、文件夹身份、设备权限与 Harness。
- 显式保存的项目使用新项目的根，不走默认自有会话目录的复用路径。
- 文件不复制也不回滚；隐藏的推理与原工具参数不进入分叉种子。种子上限与来源记录见 [ARCHITECTURE.md](./ARCHITECTURE.md#会话分叉)。

## 验证的限度

`apps/host/test/fork-recovery.test.ts` 与 `apps/web/test/workspace-recovery.test.ts` 是纯 Node 用例，不证明浏览器里的原地选择、草稿焦点与实际发送；这些由 `e2e/workspace-recovery.e2e.ts` 在三种宽度下用真实的临时 Host 验证。真实的系统确认不在自动化范围内。
