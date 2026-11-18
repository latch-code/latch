# @latch/relay-edge

edge 中继：运营者自己 Cloudflare 账户上的 Workers 加 Durable Objects，复用 `@latch/relay-core` 的状态机，注册令牌登记，开放登记只由运营者显式选择。每个地区节点是一个独立 Worker，每个分片一个永不休眠的节点对象。

- 运行环境 `workerd`：只用 ES 标准库与 `src/platform.ts` 手写的平台接口；只有 `worker.ts`、`work.ts` 两个部署入口读运行时全局变量。不加 Cloudflare 依赖或类型包，不导入 `node:` 模块。
- 身份是中继自己的 Ed25519 密钥（`link-wire` 的 `relay-identity.ts`），不是 TLS 证书或主机名；一个节点可以有多个地址。
- 路由、路由令牌、待接合、重放记录只在内存；DENY 标签在对象的 SQLite，每对象内存最多 16,384 个，读不到或超预算时拒绝。没有计费配额与公平分摊。
- 不输出日志（无 `console`）、不存完整 IP：Worker 把 `CF-Connecting-IP` 折成 /24 或 /48 前缀后只把前缀交给节点对象。错误与拒绝不带原因、秘密或标识。
- 签名私钥、管理令牌、可选注册令牌只作为 Workers secret；`wrangler.jsonc` 不写账户、秘密，`observability` 关闭。
- 注册计算挑战的 scrypt 只在无状态的 `latch-relay-work` Worker 里算（服务绑定），节点对象只做有界并发与超时。
- 界限只依赖节点持有和交给 `send()` 的字节（`buffers.ts`）：接收与填充队列字节上限；未认证带填充的连接全对象限数、每个限字节，满了关闭最大前缀里最旧的而不是拒绝新来者；连接槽每前缀限数、按时钟保留。每连接发送预算是速率不是内存上限：持有通行证的不读手机能让平台缓冲增长，除非平台报告并回落 `bufferedAmount`（它只能提前关闭，不能释放预算）。这些不是费用配额或公平算法。
- 组装前的平台内存（任何知道地址的人可反复触发重置）、关闭后的平台队列与慢读积压只能在真实部署上检查：`scripts/accept-core.ts`（`pnpm relay-edge:accept`）先凭管理令牌确认是运营者自己的中继再逐项验收，docs/RELAY.md「Workers 的界限与验收」写明最坏情况。Node 夹具不能替代平台验收。
- 部署模块经同一 Wrangler 调用器写秘密：只走 stdin，固定净化与弃置诊断，不能继承用户的诊断环境或输出。

测试在 test/：Node 里用假平台（真实 WebCrypto 与 node:sqlite）驱动真实 core，并经真实 TLS 驱动 link-client 客户端。
