---
description: 自定义连接插件的公开描述、Cordis 租约、原生认证消费、消息背压与明确的平台边界。
sources:
  - packages/sdk/src/transports.ts
  - packages/core/src/registry.ts
  - packages/link-wire/src/crypto.ts
  - packages/link-client/src/transport-descriptor.ts
  - packages/link-client/src/byte-transport.ts
  - packages/link-client/src/message-transport.ts
  - apps/host/src/native-transports.ts
  - apps/host/src/message-transport-driver.ts
  - apps/host/src/relay-transport-driver.ts
  - apps/host/src/native.ts
  - apps/host/src/server.ts
  - apps/host/src/routes/native.ts
---
# 连接插件

自定义插件可以用 `context.registerTransport(driver)` 提供双向交互载体。技能、工具、界面与 Harness 的作者面不受影响。Host 在原生连接已经配置时才监听启用插件声明的通道；启用插件本身不会开启原生连接、登记设备或授予会话权限。

SDK 通道是平台无关的 `incoming: AsyncIterable<Uint8Array>`、`write(bytes, signal)`、`closed` 与异步 `close()`。单块上限 16 KiB，写入按序，关闭必须结束读取和待写，并在真实资源停止后结算。Node 的 `ByteTransportStream` 在消费边界转换为 Duplex；主 SDK 不引入 Node stream 类型，link-client 不依赖 SDK 或 Cordis。

## 公开描述与私密配置

公开描述版本 1 只有 `{version:1, driverId, channelId, endpoint}`，序列化不超过 2 KiB。driverId 是 1–64 位字母、数字、下划线或连字符；channelId 同样限制为 1–128 位。endpoint 是不超过 1024 字符的公开 origin，拒绝 userinfo、路径、query、fragment、控制字符和执行型协议。Webhook 密钥路径、Bot token、设备密钥、邀请码和任意插件配置都不能放进去。凭据由本机可信 driver 闭包持有；它们不进入 descriptor、URL、注册表能力列表、日志或错误。

`checkedTransportDescriptor` 规范化 origin；`encodeTransportDescriptor` 使用固定字段顺序，`transportDescriptorHash` 在 `latch-transport-descriptor-v1` 域内计算 SHA-256。descriptor 只表示路由，不是身份或权限。当前提供独立有限 codec，尚未把自定义 descriptor 写入手机连接簿或配对二维码。

## 原生消费与生命周期

自定义 driver 的 `profile` 固定为 `native-stream-v1`，不从传输消息协商。

`connectPluginTransport(registry, descriptor, identity, options?)` 只把公开描述和取消信号交给 driver。认证由 Host 共享层完成；持有载体账户或消息会话不能替代设备身份。

driver 可以声明至多八个全局启用的公开监听通道；每个通道至多四条连接，所有插件合计至多 32 条。声明只在激活成功后发布。Host 合并同步、关闭后拒绝新接受，监听失败五秒后再试，不建立无限同步队列。driver.open 的共享准备预算为三秒，不为慢速消息服务放宽现有时限。

每个监听和连接持有对应 Cordis generation 的真实租约。替换、retire 和停用先使传输租约失效，消费者立即取消并关闭；旧代等待 `closed` 和读取退出后才释放。只有传输租约的插件可以正常停用；同时仍有运行、Harness 或面板租约时保留原有 409。插件自己的异步 close 不能被超时伪造成已停止。源码和 effect 的回收继续遵守应用内插件资产的不可变代次契约。

## 消息载体适配器

`messageByteTransport(carrier, connectionId, signal?)` 接受有明确单条上限的双向消息会话。connectionId 是新连接共享的 16 字节公开随机标识，不是认证。消息包含版本、数据/ACK 类型、连接标识和 32 位序号；数据按序输出，重复只重发 ACK，错连接、越界和非法帧关闭。

单条载体消息为 256–16384 字节，头部 22 字节。发送最多四片在途，实际消费者读取后才确认，背压会传回写入方；缓冲上限 64 KiB/128 片。每 200ms 重发，最多八次尝试，然后关闭。Node 桥高水位 16 KiB，写队列超过 256 KiB 拒绝；不把异步 send 排成无限队列。取消使待 ACK 的写失败，移除订阅，并等待真实载体 close 和已发 send 结算。消息层不替代 TLS 或业务 requestId 回执。

`createMessageTransportDriver` 组合这个适配器与用户提供的 open/listen 消息实现。

## 能力边界与验证

插件是可信本机代码；这些接口不提供 OS 沙箱，也不能约束模块自行调用系统或解释外部配置。Host 仅在用户按现有代码信任流程安装/应用后加载模块，不自动下载 driver 或安装 npm 依赖。

当前 Node 消费者和交互消息适配器已经实现；Vitest 通过丢包、重排、重复、背压和取消，以及真实 Go TLS/HTTP/2、正文窗口、业务回执和官方 relay 适配器链。[MessagePort 示例](../examples/message-port/README.md) 是实际加载验证的本机双向消息插件。测试使用临时目录、端口 0 和本机消息会话，不接触真实 Bot 或群聊。Swift 不执行 JS 插件，自定义手机 connector、飞书真实双向 driver、单向 Webhook、慢速存储转发和离线消息语义尚未实现。现有交互时限不能被这些载体假称满足；真机和实际消息服务仍需单独验证。
