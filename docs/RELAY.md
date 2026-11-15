---
description: 自建原生中继的安装、私有连接配置、手机接入和健康检查。
sources:
  - apps/relay/src/cli.ts
  - apps/relay/src/config.ts
  - apps/relay/deploy/compose.yaml
  - apps/relay/deploy/install.sh
  - apps/host/src/routes/native.ts
  - apps/host/src/native-settings.ts
  - apps/host/src/relay/controller.ts
  - apps/host/src/relay/profiles.ts
---
# 自建原生中继

在公网 Linux 上运行 Latch Relay，再在 Latch 桌面端导入连接配置。已配对的手机下次连上 Mac 时会取得由 Host 签名的地址，随后可从其他网络通过中继访问。首次配对仍在同一个局域网完成。使用自建中继不需要 Latch 账号；手机、会话与权限由自己的 Host 持有。

## 准备服务器

准备可直达的 Linux 服务器、DNS 和证书。证书链须受 Mac 和手机的系统信任，名称须与中继地址一致。公网需要由 Latch 的 Go TLS 网关直接处理 TLS，节点配置包括证书私钥、禁票据网关、网卡流量账本、内存和连接上限、每前缀上限及有界注册挑战。域名应指向这一服务器，使用其服务端口（默认初始配置为 8443）；也可以由操作者核对后配置同机的 TCP 转发。使用同一证书密钥续期可保持固定的公钥指纹；改变公钥要重新导入新配置。

源码方式需要 `.node-version`、`.go-version` 中的工具链和锁定依赖。运行服务时用单独系统用户和绝对的私有数据目录。以下例子用 `/srv/latch-relay`，由实际服务用户持有，目录 0700、文件 0600。

```sh
pnpm install --frozen-lockfile
pnpm build:relay
pnpm relay init --data-dir /srv/latch-relay
```

`init` 生成随机节点 ID、32 字节注册令牌和本机绑定的起始配置。把完整证书链和私钥以 0600 安装到该配置指定的文件，再编辑同目录的 `relay.json`。

| 公网设置 | 采用的值 |
| --- | --- |
| `host`、`port`、`gateway.binary` | 监听公网接口的地址或适当的通配地址、服务端口、构建出的 `latch-relay-tls` 的绝对路径 |
| `maxConnections`、`maxRoutes`、`maxPerPrefix`、`maxStateBytes` | 按节点实测容量设置的连接、路由、前缀与状态文件预算 |
| `gateway.maxHandshakes`、`handshakesPerSecond`、`handshakeBurst`、`prefixFraction` | 经实际机器压测得到的握手速率、并发与前缀比例 |
| `memory.bufferBytes`、`memory.limitBytes`、`registrationWork` | 实测内存预算、挑战软上限、计算槽与难度。缓冲加上各计算槽内存必须低于预算的一半 |
| `quota`、`fairness` | 套餐流量、结算日、时区、计量方向、实际公网网卡、突发预算、停发比例和每日公平份额 |

配置的准确字段与数值约束见 [config.ts](../apps/relay/src/config.ts) 和 [registration-work.ts](../apps/relay/src/registration-work.ts)。注册令牌由 `init` 生成，默认仅持有它的 Host 可登记。`openRegistration` 是运营公共中继时需要明确选择的配置。

```sh
pnpm relay check --data-dir /srv/latch-relay
pnpm relay start --data-dir /srv/latch-relay
```

进程启动后，从另一个终端用运营商报告的本结算周期已用字节校准，使用真实字节数替换 `USED_BYTES`。节点将在网卡计数与账本就绪后放行。

```sh
pnpm relay quota set-used USED_BYTES --data-dir /srv/latch-relay
pnpm relay status --data-dir /srv/latch-relay
pnpm relay health --data-dir /srv/latch-relay
```

容器方式复用 [Dockerfile](../apps/relay/deploy/Dockerfile)、[Compose](../apps/relay/deploy/compose.yaml) 与锁定的构建材料。映射的状态目录归容器的 UID/GID 65532；在容器内使用 `/var/lib/latch-relay` 配置路径及 `/opt/latch/latch-relay-tls` 网关路径。按 Compose 文件里的要求提供镜像摘要、状态目录、实测内存/进程/临时目录上限和健康检查配置。同样先通过容器的 `init` 写入私有配置，再准备证书和公网限额。运行 [install.sh](../apps/relay/deploy/install.sh) 可以一次检查并启动，第一次设置账本后等待健康检查。已校准的账本保持原样。安装与升级共用私有状态目录的只读目录锁，换镜像使用已有的排空和回退流程。

```sh
apps/relay/deploy/install.sh /absolute/path/to/compose.yaml --used-bytes USED_BYTES
```

## 在 Mac 添加

从已检查的服务器配置导出一份 0600 文件。命令只打印写入结果，用 `--output` 指定的新文件已有时会拒绝。证书公钥指纹从配置证书计算。文件包含登记令牌时应像注册文件一样私下传回这台 Mac，例如通过自己管理的 SSH 连接；不要上传到公开链接或提交。

```sh
pnpm relay profile --data-dir /srv/latch-relay \
  --url https://relay.example.com:8443 \
  --output /srv/latch-relay/latch-connection.json
```

在桌面端「设置 → 设备 → 关于连接」选「导入配置」，核对地址后选「验证并添加」，在这台 Mac 的系统窗口确认。Host 先审计，在现有出站规则下锁定解析地址，核对 TLS 证书、服务器名、公钥指纹与节点标识，再实际登记一个将随配置保存的真实路由。只有确认登记成功且配置与回执已写入才在签名地址簿中发布。验证连接在发送准入帧时复查权限与出站规则，文件原子替换前再查一次。连接局域网/内网中继时，需由本机管理员先在出站规则放行相应 `host:port`；导入只确认该中继，不改变全局出站规则。

网络或写入失败后，页面可继续同一待确认请求。私有配置中保存的原路由种子在重试时复用。文件已替换、目录同步结果未知时，先确认该次保存，再允许后续提交。放弃将阻止未完成请求发布。保存后的条目显示真实控制链路状态，可由本机管理员移除。移除和放弃都会在替换配置前尝试留审计；审计写失败时仍完成收紧，且响应标记审计失败。已有设备身份保持有效，之后不会再分发已移除节点的新地址。

中继看到连接 IP、时间、填充后的大小和流向。会话正文、Host 身份证明和设备授权仍由两端建立和验证。公开 `/healthz` 只反映节点是否接受连接，完整验证须使用手机或原生客户端走实际配对、跨网连接、重连和撤销。官方中继尚未部署。
