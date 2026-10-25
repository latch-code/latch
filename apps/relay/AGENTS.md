# @latch/relay

不持有用户或 Host 身份的盲中继。core 是无 I/O 状态机；Node 适配器拥有 TLS、WebSocket、字节拼接、磁盘聚合计量与 CLI。

- URL、日志和错误不包含秘密、路由 ID、通行证或完整 IP。只转发已获准的一对字节流，不解释内层。
- 自建默认注册令牌；显式 open 才开放。管理端口仅本机，公开健康只报 ok/503。
- 有界解析、连接级错误隔离、背压、节点日预算与分层前缀公平；没有路由绝对带宽下限。
- CLI 必须显式 data-dir；Node 带 disable-sigusr1；不操作真实云服务。

机制见根 docs/RELAY.md；测试在 test/，用 Vitest、本地端口0与测试证书。
