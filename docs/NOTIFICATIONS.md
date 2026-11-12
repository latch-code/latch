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

主进程自行经已认证的 `host.sock` 读取 Host 快照。页面不给通知文字或会话标识；第一份快照只建基线。只有先前正在运行或等待批准、随后真实完成或失败的会话才产生结束事件，重复快照不重复提醒。`failed` 或明确的失败 outcome 使用固定失败文字；取消和中断不冒充完成。旧 Host 缺少 outcome 时仍接受其 `idle` 正常结束状态。新增审批使用固定待处理文字。

完成与失败共用 `completion` 开关，审批用 `approval`；两者只在没有前台窗口且平台支持通知时发送。通知默认标题为 Latch；只有用户开启 `title` 偏好时才显示清理控制字符、限制长度的会话标题。每个会话十秒内最多一条，点击使用已认证快照里的会话标识聚焦窗口、打开会话，并直接定位到它最早的待处理请求；窗口是这次点击重新打开的，页面第一次订阅之前到达的点击由 preload 保留到那时；取消订阅后不再接收。页面还没读到这个请求时，先打开会话，读取最新状态后再定位。Dock 徽标与「等你处理」用同一规则：有待处理请求或待答提问的会话，加上 Latch 不认识的请求之后再无动静、以及 Host 判定沉默的运行，按会话计数；未读结果与运行中不算。断连、鉴权失败或不支持通知时不伪造提醒。

**其他电脑。** 桌面端添加的其他电脑（[ARCHITECTURE.md](ARCHITECTURE.md#桌面端与其他电脑)）的已认证快照由 `computers.cjs` 读取后交给同一个控制器（`observeRemote`）：每台电脑各自的基线与十秒节流，同一套偏好、首次同意与前台判断。标题前加电脑名（`build-mini · Latch`，开启标题偏好时 `build-mini · <会话标题>`），这台 Mac 的不加；点击打开那台电脑的窗口，并经它的 `latchShell.computers.subscribeSession` 打开该会话（窗口打开前到达的由 preload 保留到第一次订阅）。移除电脑时它的基线一起删除。Dock 徽标是这台 Mac 的计数加上所有在线的其他电脑的等你处理数；离线、证书或身份有问题的电脑不计入。`multi-host.e2e.ts` 用同样只替换系统展示类的方法验证两台测试 Host 下的一条带前缀的通知、点击路由与 Dock 总数。

三个偏好初始均关闭。首次在后台观察到真实结束、且用户尚未选择时，主进程打开完成与审批通知、持久化 `accepted` 并发送这条通知，系统在第一条通知时询问授权；客户端不另设询问条。标题偏好不变。

- 用户在设置里改动任一通知都记为 accepted；关掉通知不会再次自动打开。
- 后台事件与普通设置共用一个串行写队列，按最新状态生成提交，后台事件不覆盖后来选择。
- 写入成功后才更新内存并发布状态；写入失败保留内存旧值，后续请求仍能继续。相同选择不重复写入。

`notifications.json` 是版本 1 的私有记录，包含 `preferences` 和 `consent`。旧版三个布尔字段自动迁移：任一通知已开启视为 accepted，全关且没有历史选择记录视为 unasked。损坏或不可读时默认关闭；不声称能够从损坏数据恢复过去的选择。关闭停止新增状态事件并等待已经排入队列的偏好写入结算。

`@latch/protocol` 导出 `DesktopNotificationPreferences`、`DesktopNotificationState` 和 `DesktopNotificationConsent`。preload 合同保留 `get()`、`set({completion,approval,title})` 和 `subscribe(sessionIdCallback)`，新增 `subscribeState(stateCallback)`。状态只有偏好、`supported` 和可选 `consent`；没有标题、正文、路径或任意会话参数。新成员和字段在客户端按可选处理，旧壳仍可使用普通设置与原点击订阅。

系统是否实际展示、被专注模式或系统设置抑制，Electron 无法可靠判定；这里的 supported 只描述平台能力，不是 OS 授权状态或送达回执。

Vitest 覆盖真实 Host 状态变更映射、前后台与节流、取消/中断、磁盘迁移和重启、等待写入时的设置竞争、失败恢复、IPC 来源与有限输入，以及在 Node VM 中加载产品 preload 后的实际调用和事件过滤。VM 与测试通知后端不等于真实系统通知授权或锁屏验收。


`desktop-notifications.e2e.ts` 的Electron用例在临时bootstrap中用EventEmitter通知类接住展示调用，随后加载产品main；没有改动生产IPC、真实凭据代理、Host快照读取、preload或焦点判断。受控本地Provider在真实Host产生运行、完成、失败、审批与已结算取消；快照读取失败不能产生完成提醒。用例经真实preload保存偏好，检查前台抑制、隐藏窗口后的通知、点击恢复并选中对应会话、默认标题不含正文，以及重复快照不重复通知。只替换系统展示类，不向系统投递真实通知；独立Node用例验证同一个Provider夹具的实际Host状态。系统授权、专注模式和锁屏送达仍需所有者验收。
