# @latch/relay-edge

edge 中继协议：Cloudflare Workers 加 Durable Objects，复用 `@latch/relay-core` 的状态机。每个地区节点是一个独立 Worker，每个分片一个永不休眠的节点对象。组装前的入站限制与底层关闭结算无法验证期间，生产 Worker 和部署入口一律拒绝；协议夹具保留。

- 运行环境 `workerd`：只用 ES 标准库与 `src/platform.ts` 手写的平台接口；只有 `worker.ts`、`work.ts` 两个部署入口读运行时全局变量。不加 Cloudflare 依赖或类型包，不导入 `node:` 模块。
- 身份是中继自己的 Ed25519 密钥（`link-wire` 的 `relay-identity.ts`），不是 TLS 证书或主机名；一个节点可以有多个地址。
- 路由、路由令牌、待接合、重放记录只在内存；DENY 标签在对象的 SQLite，每对象内存最多 16,384 个，读不到或超预算时拒绝。没有计费配额与公平分摊。
- 不输出日志（无 `console`）、不存完整 IP：Worker 把 `CF-Connecting-IP` 折成 /24 或 /48 前缀后只把前缀交给节点对象。错误与拒绝不带原因、秘密或标识。
- 签名私钥、管理令牌、可选注册令牌只作为 Workers secret；`wrangler.jsonc` 不写账户、秘密，`observability` 关闭。
- 注册计算挑战的 scrypt 只在无状态的 `latch-relay-work` Worker 里算（服务绑定），节点对象只做有界并发与超时。
- 要求 workerd v1.20261117.1 的 `WebSocket.bufferedAmount`，缺失、异常或非法值时拒绝服务。接收待处理、填充队列与运行时未写出的数据共同受 `buffers.ts` 的字节和消息数硬上限约束。计数归零只结算 payload，Close 在途时仍占用连接槽。生产要求运行时提供物理关闭结算与组装前入站限额，接收工作等待实际结算。
- `bufferedAmount` 的上线范围与真实慢读行为尚未在 Cloudflare 部署验收；Node 夹具不能替代平台验收。内存安全上限不是费用配额或公平算法。
- 未经平台实测的接口与数值在 `platform.ts` 与 docs/RELAY.md「Workers 平台验证」标出。
- 部署模块经同一 Wrangler 调用器写秘密：只走 stdin，固定净化与弃置诊断，不能继承用户的诊断环境或输出。

测试在 test/：Node 里用假平台（真实 WebCrypto 与 node:sqlite）驱动真实 core，并经真实 TLS 驱动 link-client 客户端。
