# @latch/link-wire

原生链路与中继的纯线格式、严格校验、密码学注入接口与有界恢复状态。环境 isomorphic；只用 ES 标准库，不使用 Node、DOM、WebCrypto 全局或 I/O。密码学由调用方注入。

- 所有变长输入先限长；整数大端，保留位为零；未知标签与尾部字节拒绝。
- 更改编码、域分离或密钥派生时同步 `packages/testkit/vectors/link-v1.json`。
- 地址与路由均不是身份或凭据；v2外层画像独立绑定，旧v1/v2簿字节不改，新画像才用簿v3。
- 目录离线根约束节点、固定值与在线密钥；在线地址签名不能新增观察方，两级代次/期限/同代摘要都核对，本机同意由Host另外处理。
- 发现名、稳定缓存提示、网关核对与 DENY 批次摘要的编码必须固定边界；中继 ACK 不能代替设备墓碑 ACK。

机制见根 docs/REMOTE.md 与 docs/RELAY.md；测试在 test/，用 Vitest。
