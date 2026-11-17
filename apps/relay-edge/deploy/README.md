# Cloudflare Workers 中继

生产部署尚未开放。发布入口会拒绝 WebSocket 升级，`pnpm relay-edge:setup` 会在构建或调用 Wrangler 前停止。当前可用的方式是 [Linux 中继](../../../docs/RELAY.md#方式-alinux-服务器self) 与局域网直连。

## 上线所需的平台能力

- **组装前的入站上限。** Workers 会在调用 JavaScript 的 `message` 回调前组装 WebSocket 消息，单条最多 32 MiB；当前入口无法在组装前拒绝过大的帧及未完整的分片。平台需能对连接和对象约束正在组装的帧、分片与消息。应在真实运行时验证超限数据尚未分配到对象时就被拒绝。[Workers WebSocket 接口](https://developers.cloudflare.com/workers/runtime-apis/websockets/#events)
- **实际关闭。** `close` 事件可能先于输出泵结束；`bufferedAmount` 归零只说明已发送 payload。必须能等待该连接的收发与关闭帧全部结算，再把容量交给新连接。应在真实运行时让接收端慢读、未读取 Close 或突然断开，核对连接槽和内存仍受限。[锁定的 workerd 实现](https://github.com/cloudflare/workerd/blob/v1.20261117.1/src/workerd/api/web-socket.c%2B%2B)

有边界的入口可以在受控 TLS 连接中解析帧头、在分配 payload 前拒绝超限值，并等待传输实际结束。若用这样的入口承接流量，还需让公开的 Worker 地址拒绝直接升级，确保所有连接都经过同一限制。上述路径尚未接入 Workers。现有 Linux 中继提供受控的 Go/TLS 入口。

## 本地协议验证

`pnpm build:relay-edge` 构建 Worker 与注册挑战校验 Worker。测试通过本地 TLS 与 Node 夹具覆盖端到端协议与应用缓冲；线上接收、物理关闭与 Durable Object 内存尚未验收。健康端点只代表配置状态。

部署模块的 Wrangler 调用统一经 `scripts/wrangler.ts`。它核对已审阅的 Wrangler 版本，子进程仅继承运行和已登录配置所需的环境。调试和结构化日志写入空设备，禁用遥测，并通过指定空的 dotenv 文件阻止工作目录内的配置重启诊断。秘密只进标准输入，写秘密命令的两个输出都丢弃。将来的正式 CLI 与源码入口共用这一调用路径；连接文件与管理头仅写入新建的 0600 文件。[Wrangler 环境变量](https://developers.cloudflare.com/workers/wrangler/system-environment-variables/) [Wrangler 4.164.0 日志实现](https://github.com/cloudflare/workers-sdk/blob/wrangler%404.164.0/packages/wrangler/src/utils/log-file.ts)
