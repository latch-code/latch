# MessagePort 本机连接示例

`host.mjs` 是完整的可信本机插件，使用 Node MessageChannel 提供双向消息。它通过产品的 `createMessageTransportDriver` 适配碎片、ACK、去重、重排、背压与真实关闭；消费端仍运行敲门、平台 TLS、RootProof、HTTP/2 和正文窗口。载体拿不到设备身份。

这是同一 Node 进程内的交互示例，不连接互联网、飞书或其他 IM，也不提供手机 connector。它不会开启尚未配置的原生连接。Vitest 的 Host 用例加载此文件并验证真实认证连接，独立的消息适配器用例另注入丢包、重排和取消。

嵌入式调用方可以把默认插件放入 `startServer({plugins:[plugin], ...})`，并显式使用自己的临时数据目录、工作区、端口 0 与已配置原生入口；也可按现有可信本地模块流程安装。Node 消费者使用：

```ts
const connection = await connectPluginTransport(host.registry, descriptor, identity, { signal })
// identity 来自调用方已完成的设备登记，只交给共享消费层。
const snapshot = await connection.client.request('GET', '/link/api/snapshot')
await connection.close()
```

读取正文前仍须完成本次 App/连接的正文窗口验证，不能凭内存消息通道跳过。示例不打印或保存身份资料。私密载体配置应保留在本机实现闭包中；公开 endpoint 只能是 origin，不能填 Bot token、Webhook 路径或 URL 参数。真实远程 driver 必须独立实现双向交互和关闭约定，并满足现有握手时限；单向 Webhook 和慢速存储转发不符合此合同。

接口和边界见 [连接插件](../../docs/TRANSPORT-PLUGINS.md)。
