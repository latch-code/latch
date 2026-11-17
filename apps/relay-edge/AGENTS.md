# @latch/relay-edge

官方中继（edge 类型）：Cloudflare Workers 加 Durable Objects，复用 `@latch/relay-core` 的状态机。每个地区节点是一个独立 Worker，每个分片一个永不休眠的节点对象。部署由所有者在仓库外用自己的 wrangler 完成；仓库只有代码、测试与 `deploy/` 模板。

- 运行环境 `workerd`：只用 ES 标准库与 `src/platform.ts` 手写的平台接口；只有 `worker.ts`、`work.ts` 两个部署入口读运行时全局变量。不加 Cloudflare 依赖或类型包，不导入 `node:` 模块。
- 身份是中继自己的 Ed25519 密钥（`link-wire` 的 `relay-identity.ts`），不是 TLS 证书或主机名；一个节点可以有多个地址。
- 路由、路由令牌、待接合、重放记录只在内存；DENY 标签与花费计数在对象的 SQLite。计数按块预留，重启只会多计不会少计；读不到、出错或未配置上限一律拒绝新连接，从不放行。
- 不输出日志（无 `console`）、不存完整 IP：Worker 把 `CF-Connecting-IP` 折成 /24 或 /48 前缀后只把前缀交给节点对象。错误与拒绝不带原因、秘密或标识。
- 签名私钥、管理令牌、可选注册令牌只作为 Workers secret；`wrangler.jsonc` 不写账户、秘密，`observability` 关闭。
- 注册计算挑战的 scrypt 只在无状态的 `latch-relay-work` Worker 里算（服务绑定），节点对象只做有界并发与超时。
- 没有发送端背压（平台无 `bufferedAmount`）：靠每连接排队上限、每对象接合数上限（满了 4302）与日/月消息上限。
- 未经平台实测的接口与数值在 `platform.ts` 标注、在 docs/RELAY.md「未实测」列出，改动它们先改那里。

测试在 test/：Node 里用假平台（真实 WebCrypto 与 node:sqlite）驱动真实 core，并经真实 TLS 驱动 link-client 客户端。
