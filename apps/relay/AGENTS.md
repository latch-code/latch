# @latch/relay

不持有用户或 Host 身份的盲中继（自建 Linux 服务器）。状态机在 `@latch/relay-core`（`apps/relay-edge` 复用它）；Node 适配器拥有 WebSocket、字节拼接、磁盘聚合计量、ACME 自动证书与 CLI；标准库 Go 网关拥有公网 TLS。

- URL、日志和错误不包含秘密、路由 ID、通行证或完整 IP。只转发已获准的一对字节流，不解释内层。edge 类型无法对 Cloudflare 自己的日志作同样承诺，见 docs/RELAY.md。
- 自建默认注册令牌；显式 open 才开放。只读管理端口仅本机，写管理经 0700/0600 Unix socket，公开健康只报 ok/503。
- 有界解析、连接级错误隔离、背压、节点日预算与分层前缀公平；默认统计中继自身转发字节并免手动校准启动，显式 `--iface` 时计量网卡字节。
- 注册软阈值以上用绑定原 REGISTER 的一次 scrypt 挑战；异步作业有界，超时不提前复用尚未结算的计算槽，证明不能突破硬资源份额。
- 有域名新部署默认生成持久 Ed25519 `relayKey`（`/v1/{h,d,c}/0` 挑战签名 + v2 绑定证明），ACME 续期默认复用原 TLS 私钥以兼容 `--legacy-spki`；无域名公网 IP 部署（`--ip`）生成带 IP SAN 的自签 P-256 证书（`self-tls.ts`）并复用同一私钥自动续期，导出 SPKI 固定的 v1 配置（`/v1/{h,d,c}`）。公网直连仅用禁票据的 Go TLS 网关（支持 `acme-tls/1` 自动签发与热加载），经私有 Unix socket 与固定 PROXYv2 头接 Node；显式 `--behind-proxy` 仅绑定回环供同机反向代理接入；生产节点均须完整 cgroup 套接字内存计量就绪后才接收新连接。
- 监控、网卡计量、Unix socket 管理、内核锁只属于 Linux 中继；Workers 的对应物见 apps/relay-edge/AGENTS.md。
- CLI 必须显式 data-dir；监督器持有内核锁并向 worker 继承锁 FD；Node 带 disable-sigusr1；仓库只写代码与模板，不操作真实云服务。
- 目录签名仅在独立离线/发布命令读取私钥；服务入口只使用公开目录。

测试在 test/，用 Vitest、本地端口0与测试证书。
