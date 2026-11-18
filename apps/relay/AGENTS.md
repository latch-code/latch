# @latch/relay

不持有用户或 Host 身份的盲中继，self 类型（自建 Linux 服务器）。状态机在 `@latch/relay-core`（edge 类型在 `apps/relay-edge` 复用它）；Node 适配器拥有 WebSocket、字节拼接、磁盘聚合计量与 CLI；标准库 Go 网关拥有公网 TLS。

- URL、日志和错误不包含秘密、路由 ID、通行证或完整 IP。只转发已获准的一对字节流，不解释内层。edge 类型无法对 Cloudflare 自己的日志作同样承诺，见 docs/RELAY.md。
- 自建默认注册令牌；显式 open 才开放。只读管理端口仅本机，写管理经 0700/0600 Unix socket，公开健康只报 ok/503。
- 有界解析、连接级错误隔离、背压、节点日预算与分层前缀公平；v2含PAD的实际帧字节扣费，不能延长阶段；没有路由绝对带宽下限。
- 注册软阈值以上用绑定原 REGISTER 的一次 scrypt 挑战；异步作业有界，超时不提前复用尚未结算的计算槽，证明不能突破硬资源份额。
- self 的身份是固定证书公钥与 v1 准入证明，格式冻结：已部署节点与旧客户端只认它。公网仅用禁票据的 Go TLS 网关，经私有 Unix socket 与固定 PROXYv2 头接 Node。任一端断开时关闭两端，等待两向转发结束再释放连接槽。Node TLS 仅本地验证。构建使用已修补 Go。
- 监控、网卡计量、Unix socket 管理、内核锁只属于 self；edge 的对应物见 apps/relay-edge/AGENTS.md。
- CLI 必须显式 data-dir；监督器持有内核锁并向 worker 继承锁 FD；Node 带 disable-sigusr1；仓库只写代码与模板，不操作真实云服务。
- 目录签名仅在独立离线/发布命令读取私钥；服务入口只使用公开目录。目录只列 self 节点（edge 节点没有自己的 IP）。

测试在 test/，用 Vitest、本地端口0与测试证书。
