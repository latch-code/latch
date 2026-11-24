---
description: 已配对 iPhone 的锁屏通知、实时活动、Apple 凭据配置与重新验证待办。
sources:
  - apps/host/src/apple-push.ts
  - apps/host/src/native-push.ts
  - native/ios/App/Conversation/Drawers.swift
  - native/ios/App/Root/PhonePush.swift
  - native/ios/Shared/LatchQuestionAttributes.swift
  - native/ios/QuestionWidget/LatchQuestionWidget.swift
---
# iPhone 锁屏提醒与灵动岛

已配对的 iPhone 可以订阅这台 Host 的待审批、待回答提醒。手机与 Host 不需要同时打开 Latch 的会话页。Host 直接连 Apple Push Notification service（APNs），需要互联网和与 App 签名团队匹配的 APNs 凭据。默认关闭，不需要另建通知中转服务。

## 配置

1. 在 Apple Developer 账号下为 App ID `codes.latch.ios` 启用 Push Notifications，用相同团队的描述文件给 App 签名安装。模拟器构建、未签名 App、其他团队的 APNs 密钥不能验证真实投递。
2. 在 Host 数据目录的 `identity` 子目录创建私有文件 `apns.json`。文件归当前系统用户，权限为 0600。用本地编辑器填写 Apple 提供的 Team ID、Key ID 和整段 P-256 私钥。JSON 中的换行用 `\n` 表示。开发签名用 `sandbox`，分发签名用 `production`。该文件只在 Host 启动时读取。由运营者在方便时重启自己的 Host。
3. 在手机的「设置 → 通知」打开「这台电脑的锁屏提醒」，允许系统通知。确认目标电脑后，App 在已验证的原生连接里登记 Apple 令牌。可以分别为每台电脑开关；关闭时需连上对应 Host 得到确认。手机被 Host 撤销后也会停止投递。
4. 可在 iOS 设置控制 Latch 通知和实时活动。iOS 17.2 及以上支持 Apple 远程启动实时活动。关闭实时活动或设备还没有活动令牌时，使用普通通知。灵动岛的呈现取决于设备及系统设置。

```json
{
  "environment": "sandbox",
  "teamId": "<Apple Team ID>",
  "keyId": "<APNs Key ID>",
  "privateKey": "<Apple 提供的完整 PEM 私钥>"
}
```

## 收到后如何处理

锁屏和紧凑灵动岛显示 Latch 标识与待审批、待回答或待更新状态。最小样式由 VoiceOver 读出状态。展开公开审批时，已验证的 Agent 使用预设名，其他来源显示 Latch。手机可解封时，展开的灵动岛还会显示真实会话标题、单个常见文件名和操作。文件摘要可用清单文件名或文件范围，例如「修改文件 / 3 个 Swift 文件」。内置写文件工具确认目标不存在时可以显示「新建文件」。命令用独立样式展示完整匹配的已知命令。Host 判为高风险时显示「高风险」。摘要含这些详情时可选择「拒绝」或「批准」，其余审批显示「解锁查看审批」。提问显示「查看问题」，待更新时可打开 Latch 查看最新状态。普通锁屏通知也可轻点打开，展开审批通知可选择「批准」或「拒绝」。

解锁后，App 连接原电脑并按本机的 Face ID 偏好验证。Host 再查这台设备对这条待办的权限。App 会核对会话和决定标识，再显示对应审批或问题。文件审批列出设备有权看到的路径，双方完整、能比较时显示拟新增和移除的行数。执行端以结构化字段报告命令时，审批卡显示可滚动的命令原文，并单列已知的工作目录。批准、拒绝和回答仍经原有审批卡、Host 权限和回执流程。Host 写入审批回执后，原提醒即无法再定位这条审批，Agent 可以继续收尾。另一台设备已回答或权限已变化时，原提醒不能用于处理下一条。

同一台手机在同一个 Host 同时突出一条等待事项，处理后继续下一条。投递失败会重试，可永久失效的活动启动令牌回退到普通通知。Apple 不保证抵达时间；短时有效的提醒可能在长时间离线时过期。活动状态两分钟后标为待更新。活动的更新令牌已登记时，Host 会在事项结束后请求 Apple 收起活动；后台或锁屏不能打开正文验证窗口，首次在后台启动的活动可能要等到 App 恢复验证后才能收起。点开时始终向 Host 复核。

Apple 请求包含通用提醒和不透明路由信息。启动公开审批的实时活动时，Host 从结构化请求提取固定操作码、预设名、风险标记、已知文件类型与目标数，或与白名单完整匹配的命令和清单文件名。复合命令和重定向需要解锁查看。新版手机可经已认证的订阅登记提供一把预览密钥。Host 将长度受限、处理过不可见字符和已知秘密的会话标题与安全的单个文件名加密发送，密文绑定本次活动的路由和凭据。App 和实时活动扩展使用本机共享的钥匙串项，设备重启后首次解锁前无法使用。撤掉订阅或忘记电脑后，手机会删掉对应密钥。旧版应用、旧 Host 或无法解封时沿用通用摘要。普通通知和私有审批使用通用提示。路由信息无法授权读取会话或执行决定。

Host 将登记表加密写入 `identity/apns-devices.enc`，加密密钥在同目录私有文件中，均从数据导出排除。Apple 的签名私钥、预览密钥、会话名明文、任意命令参数、文件完整路径与正文均留在原有授权边界内。

Apple 的签名配置、App 的通知权限与网络条件都会影响真机结果。[Apple APNs 请求](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns) · [Apple 实时活动通知](https://developer.apple.com/documentation/activitykit/starting-and-updating-live-activities-with-activitykit-push-notifications)
