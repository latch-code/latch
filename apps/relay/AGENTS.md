# @latch/relay

不持有用户或 Host 身份的盲中继。core 是无 I/O 状态机；Node 适配器拥有 WebSocket、字节拼接、磁盘聚合计量与 CLI；标准库 Go 网关拥有公网 TLS。

- URL、日志和错误不包含秘密、路由 ID、通行证或完整 IP。只转发已获准的一对字节流，不解释内层。
- 自建默认注册令牌；显式 open 才开放。只读管理端口仅本机，写管理经 0700/0600 Unix socket，公开健康只报 ok/503。
- 有界解析、连接级错误隔离、背压、节点日预算与分层前缀公平；没有路由绝对带宽下限。
- 注册软阈值以上用绑定原 REGISTER 的一次 scrypt 挑战；异步作业有界，超时不提前复用尚未结算的计算槽，证明不能突破硬资源份额。
- 公网仅用禁票据的 Go TLS 网关，经私有 Unix socket 与固定 PROXYv2 头接 Node；Node TLS 仅本地验证。构建使用已修补 Go，参数见 docs/RELAY.md。
- CLI 必须显式 data-dir；监督器持有内核锁并向 worker 继承锁 FD；Node 带 disable-sigusr1；不操作真实云服务。

机制见根 docs/RELAY.md；测试在 test/，用 Vitest、本地端口0与测试证书。
