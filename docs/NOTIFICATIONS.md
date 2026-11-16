---
description: 桌面通知的完成与失败、首次选择状态、偏好恢复和 preload 合同。
sources:
  - apps/desktop/src/notifications.cjs
  - apps/desktop/src/main.cjs
  - apps/desktop/src/computers.cjs
  - apps/desktop/src/preload.cjs
  - apps/desktop/test/notifications.test.ts
  - e2e/multi-host.e2e.ts
  - e2e/desktop-notifications.e2e.ts
  - packages/protocol/src/notifications.ts
  - apps/web/src/settings/NotificationSettings.tsx
---
# 桌面通知

桌面端主进程（`notifications.cjs`）自己经已认证的 `host.sock` 读取 Host 快照并决定通知。页面不给通知文字或会话标识。

## 什么时候发

| 事件 | 条件 | 开关 |
| --- | --- | --- |
| 完成、失败 | 先前正在运行或等待批准、随后真实完成或失败的会话 | `completion` |
| 新增审批 | 快照里出现新的待处理审批 | `approval` |
| 提问 | 会话的待答提问数（`pendingQuestions`，内置 Harness 与 ACP Agent 的提问都算）比上一份快照多 | `approval` |

- 第一份快照只建基线；重复快照不重复提醒。
- `failed` 或 `runOutcome` 为 `failed` 的结束用固定的失败文字；`idle` 且 `runOutcome` 是 `completed` 或没有这个字段的算完成；取消和中断不冒充完成。
- 只在没有前台窗口且平台支持通知时发送。每个会话十秒内最多一条。
- 断连、鉴权失败或不支持通知时不伪造提醒。

**按 Agent 过滤。** 会话属于某个 Agent（`TaskSummary.agent`，或它是那个 Agent 的定时任务的运行，按快照的 `automations` 查到）且那个 Agent 的 `notifications` 关掉了对应一项时不发：完成对应 `completed`，失败对应 `failed`，审批与提问对应 `waiting`。

- 被关掉的结束也不触发首次自动开启。
- 快照里没有 Agent（设备没有完整数据范围）或形状不对时照常发送。
- iPhone 与 iPad 的通知不按 Agent 区分，尚未实现。

## 内容与点击

- 正文是主进程的固定文字。标题默认是 Latch；只有用户开启 `title` 偏好时才显示会话标题，去掉控制字符并限制长度。
- 点击使用已认证快照里的会话标识聚焦窗口、打开会话，并定位到它最早的待处理请求。页面还没读到这个请求时，先打开会话，读取最新状态后再定位。
- 窗口是这次点击重新打开的时，页面第一次订阅之前到达的点击由 preload 保留到那时；取消订阅后不再接收。

**Dock 徽标**独立于通知偏好，与「等你处理」用同一规则（`attentionOf`）按会话计数：有待处理请求或待答提问的会话，加上 Latch 不认识的请求之后再无动静、以及 Host 判定沉默的运行。未读结果与运行中不算。

## 其他电脑

桌面端添加的其他电脑（[ARCHITECTURE.md](ARCHITECTURE.md#桌面端与其他电脑)）的已认证快照由 `computers.cjs` 读取后交给同一个控制器（`observeRemote`）。

- 每台电脑各自的基线与十秒节流；同一套偏好、首次同意与前台判断；按那台电脑上的 Agent 设置过滤。移除电脑时它的基线一起删除。
- 标题前加电脑名（`build-mini · Latch`），这台 Mac 的不加。
- 点击打开那台电脑的窗口，并经它的 `latchShell.computers.subscribeSession` 打开该会话。
- Dock 徽标是这台 Mac 的计数加上所有在线的其他电脑的等你处理数；离线、证书或身份有问题的电脑不计入。

## 偏好与首次同意

三个偏好（`completion`、`approval`、`title`）初始均关闭，`consent` 是 `unasked`。

- **首次自动开启。** 首次在后台观察到真实结束、且用户尚未选择时，主进程打开完成与审批通知、持久化 `accepted` 并发送这条通知；系统在第一条通知时询问授权，客户端不另设询问条。标题偏好不变。
- 用户在设置里改动任一通知都记为 `accepted`；关掉通知不会再次自动打开。
- **写入串行。** 后台事件与设置共用一个串行写队列，按最新状态生成提交，后台事件不覆盖后来的选择。写入成功后才更新内存并发布状态；写入失败保留内存旧值。相同选择不重复写入。关闭时等待已排入队列的写入结算。

`notifications.json` 是版本 1 的私有记录，包含 `preferences` 和 `consent`。

- 没有版本的三个布尔字段按旧格式读入：任一通知已开启视为 `accepted`，否则 `unasked`。
- 损坏或不可读时默认关闭，不声称能恢复过去的选择。

## preload 合同

`@latch/protocol` 导出 `DesktopNotificationPreferences`、`DesktopNotificationState` 和 `DesktopNotificationConsent`。

- `get()`、`set({completion,approval,title})`、`subscribe(sessionIdCallback)` 与 `subscribeState(stateCallback)`。
- 状态只有偏好、`supported` 和可选的 `consent`；没有标题、正文、路径或任意会话参数。
- `supported` 只描述平台能力，不是 OS 授权状态或送达回执：系统是否实际展示、是否被专注模式或系统设置抑制，Electron 无法可靠判定。

## 验证范围

`e2e/desktop-notifications.e2e.ts` 与 `e2e/multi-host.e2e.ts` 只替换系统展示类，不向系统投递真实通知。系统授权、专注模式和锁屏送达需要所有者验收。
