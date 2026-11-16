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

插件用 `context.registerTransport(driver)` 提供双向的字节载体。Host 只在原生连接已经配置时才监听启用插件声明的通道；启用插件本身不开启原生连接、不登记设备，也不授予会话权限。

**通道接口**（`packages/sdk/src/transports.ts`）是平台无关的：`incoming: AsyncIterable<Uint8Array>`、`write(bytes, signal)`、`closed` 与异步的 `close()`。

- 单块至多 16 KiB，写入按序。
- 关闭必须结束读取与待写，并在真实资源停止后才结算。
- Node 的 `ByteTransportStream` 在消费边界把它转成 Duplex。SDK 不引入 Node stream 类型；`@latch/link-client` 不依赖 SDK 或 Cordis。

## 公开描述与私密配置

公开描述只表示路由，不是身份或权限。版本 1 只有 `{ version: 1, driverId, channelId, endpoint }`，序列化后不超过 2 KiB：

| 字段 | 约束 |
| --- | --- |
| `driverId` | 1–64 位字母、数字、下划线或连字符 |
| `channelId` | 同样的字符，1–128 位 |
| `endpoint` | 不超过 1024 字符的公开 origin；拒绝 userinfo、路径、query、fragment、控制字符与执行型协议 |

- **秘密不进描述。** Webhook 密钥路径、Bot token、设备密钥、邀请码与任意插件配置都不能放进去。凭据由本机可信的 driver 闭包持有，不进入 descriptor、URL、注册表的能力列表、日志或错误。
- **编码。** `checkedTransportDescriptor` 规范化 origin；`encodeTransportDescriptor` 用固定的字段顺序；`transportDescriptorHash` 在 `latch-transport-descriptor-v1` 域内算 SHA-256。
- 把自定义 descriptor 写入手机连接簿或配对二维码尚未实现。

## 原生消费与生命周期

- **`profile` 固定。** 自定义 driver 的 `profile` 是 `native-stream-v1`，不从传输消息协商。
- **认证在 Host。** `connectPluginTransport(registry, descriptor, identity, options?)` 只把公开描述与取消信号交给 driver，认证由 Host 的共享层完成。持有载体账户或消息会话不能代替设备身份。
- **上限。** 全局至多 8 个启用的公开监听通道，每个通道至多 4 条连接，所有插件合计至多 32 条。声明只在激活成功后发布。
- **时限。** `driver.open` 的准备预算是 3 秒，不为慢速的消息服务放宽。监听失败 5 秒后再试；Host 合并同步，关闭后拒绝新的接受，不建立无限的同步队列。

**租约。** 每个监听与连接持有对应 Cordis generation 的真实租约。

- 替换、retire 与停用先使传输租约失效，消费者立即取消并关闭；旧代等 `closed` 与读取退出后才释放。
- 只有传输租约的插件可以正常停用；同时还有运行、Harness 或面板租约时照旧答 409。
- 插件自己的异步 `close` 不能用超时伪造成已停止。
- 源码与 effect 的回收遵守应用内插件资产的不可变代次契约。

## 消息载体适配器

`messageByteTransport(carrier, connectionId, signal?)` 把有明确单条上限的双向消息会话变成字节通道；`createMessageTransportDriver` 把它与用户提供的 open/listen 消息实现组合成 driver。消息层不代替 TLS 或业务的 `requestId` 回执。

- **`connectionId`** 是新连接共享的 16 字节公开随机标识，不是认证。
- **帧。** 头部 22 字节：版本、数据或 ACK 类型、连接标识与 32 位序号。单条载体消息 256–16384 字节。
- **顺序。** 数据按序输出；重复的只重发 ACK；连接不符、越界与非法帧使连接关闭。
- **背压。** 至多 4 片在途，消费者实际读取后才确认，背压传回写入方；缓冲上限 64 KiB 或 128 片。
- **重发。** 每 200ms 重发，至多 8 次尝试，之后关闭。
- **Node 桥。** 高水位 16 KiB，写队列超过 256 KiB 时拒绝；不把异步 send 排成无限队列。
- **取消**使待 ACK 的写失败，移除订阅，并等真实载体的 `close` 与已发出的 send 结算。

## 能力边界与验证

插件是可信本机代码：这些接口不提供 OS 沙箱，也约束不了模块自己调用系统或解释外部配置。Host 只在用户按现有的代码信任流程安装并应用后加载模块，不自动下载 driver 或安装 npm 依赖。

[MessagePort 示例](../examples/message-port/README.md)是实际加载的本机双向消息插件。

尚未实现：

- Swift 不执行 JS 插件，手机上的自定义 connector。
- 飞书的真实双向 driver、单向 Webhook、慢速存储转发与离线消息语义。现有的交互时限不能由这些载体假称满足。

自动化用例只用临时目录、端口 0 与本机消息会话，不接触真实 Bot 或群聊；真机与实际的消息服务要单独验证。
