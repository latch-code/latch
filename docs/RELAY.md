---
description: 自建原生中继的安装、私有连接配置、手机接入和健康检查。
sources:
  - apps/relay/src/cli.ts
  - apps/relay/src/config.ts
  - apps/relay/deploy/compose.yaml
  - apps/relay/deploy/install.sh
  - apps/relay/deploy/upgrade.sh
  - apps/host/src/routes/native.ts
  - apps/host/src/native-settings.ts
  - apps/host/src/relay/controller.ts
  - apps/host/src/relay/profiles.ts
---
# 自建原生中继

在公网 Linux 上运行 Latch Relay，再在 Latch 桌面端导入它的连接配置。已配对的手机下次连上 Mac 时取得 Host 签名的地址，之后可以从其他网络经中继访问。

- 首次配对仍在同一个局域网完成。
- 自建中继不需要 Latch 账号；手机、会话与权限由自己的 Host 持有。
- 中继看得到连接 IP、时间、填充后的大小与流向。会话正文、Host 身份证明与设备授权由两端建立和验证。
- 官方中继尚未部署。

## 准备服务器

需要一台可直达的 Linux 服务器、指向它的域名与证书。

- **证书。** 证书链须受 Mac 与手机的系统信任，名称与中继地址一致。用同一把证书密钥续期时公钥指纹不变；公钥变了要重新导出并导入配置。
- **TLS 由 Latch 的 Go 网关直接处理**（`latch-relay-tls`）。域名指向这台服务器的服务端口（`init` 写出的是 8443）；也可以由操作者核对后在同机配置 TCP 转发。
- **运行身份。** 单独的系统用户，绝对路径的私有数据目录：目录 0700、文件 0600，由服务用户持有。下面用 `/srv/latch-relay`。
- **源码方式**需要 `.node-version` 与 `.go-version` 的工具链和锁定的依赖。

```sh
pnpm install --frozen-lockfile
pnpm build:relay
pnpm relay init --data-dir /srv/latch-relay
```

`init` 生成随机节点 ID、32 字节的注册令牌和只绑定本机（`127.0.0.1`）的起始配置 `relay.json`。把完整证书链与私钥以 0600 放到配置指定的文件，再编辑 `relay.json`。

监听地址不是回环时，配置必须同时给出 `gateway`、`quota`、`fairness`、`memory`、`maxStateBytes` 与 `registrationWork`，否则 `check` 失败：

| 设置 | 采用的值 |
| --- | --- |
| `host`、`port`、`gateway.binary` | 公网接口的 IP 或通配地址、服务端口、构建出的 `latch-relay-tls` 的绝对路径 |
| `maxConnections`、`maxRoutes`、`maxPerPrefix`、`maxStateBytes` | 按节点实测容量定的连接、路由、每前缀与状态文件预算 |
| `gateway.maxHandshakes`、`handshakesPerSecond`、`handshakeBurst`、`prefixFraction` | 实际机器压测得到的握手并发、速率、突发与前缀比例 |
| `memory.bufferBytes`、`memory.limitBytes`、`registrationWork` | 实测的内存预算，注册挑战的软上限、计算槽与难度。缓冲加上各计算槽的内存必须低于预算的一半 |
| `quota`、`fairness` | 套餐流量、结算日、时区、计量方向、公网网卡、突发预算、停发比例；每前缀的每日公平份额 |

字段与数值约束以 [config.ts](../apps/relay/src/config.ts) 和 [registration-work.ts](../apps/relay/src/registration-work.ts) 为准。默认只有持有注册令牌的 Host 能登记；`openRegistration` 是运营公共中继时才明确选择的设置。

```sh
pnpm relay check --data-dir /srv/latch-relay
pnpm relay start --data-dir /srv/latch-relay
```

进程启动后，从另一个终端用运营商报告的本结算周期已用字节校准账本（替换 `USED_BYTES`）。网卡计数与账本就绪后节点才放行。

```sh
pnpm relay quota set-used USED_BYTES --data-dir /srv/latch-relay
pnpm relay status --data-dir /srv/latch-relay
pnpm relay health --data-dir /srv/latch-relay
```

其他子命令：`drain`（不再接新连接，排空现有连接）、`reload-tls`（续期后重读证书）；`pnpm relay --help` 列出全部。每个命令都要显式的绝对 `--data-dir`，`--config` 可指向别处的配置文件。

### 容器方式

用 [Dockerfile](../apps/relay/deploy/Dockerfile)、[Compose](../apps/relay/deploy/compose.yaml) 与锁定的构建材料。

- 映射的状态目录归容器的 UID/GID 65532。容器内配置路径用 `/var/lib/latch-relay`，网关路径用 `/opt/latch/latch-relay-tls`。
- Compose 文件要求的环境变量必须给出：镜像摘要 `LATCH_RELAY_IMAGE`（`仓库@sha256:…`）、状态目录 `LATCH_RELAY_DATA_DIR`，以及实测的内存、进程数、临时目录上限与健康检查参数。
- 同样先用容器里的 `init` 写出私有配置，再准备证书与公网限额。

[install.sh](../apps/relay/deploy/install.sh) 检查配置、启动服务，在账本尚未校准时写入一次已用字节，再等健康检查通过；已校准的账本保持原样。

```sh
apps/relay/deploy/install.sh /absolute/path/to/compose.yaml --used-bytes USED_BYTES
```

换镜像用 [upgrade.sh](../apps/relay/deploy/upgrade.sh)（排空与回退）。安装与升级共用状态目录上的同一把目录锁。

## 在 Mac 添加

在服务器上从已检查的配置导出一份连接配置：

```sh
pnpm relay profile --data-dir /srv/latch-relay \
  --url https://relay.example.com:8443 \
  --output /srv/latch-relay/latch-connection.json
```

- `--url` 必须是 `https` 的 origin，且证书与它的主机名相符；`--output` 是新文件的绝对路径，已存在时拒绝。文件以 0600 写出，命令只打印写入结果。
- 文件含地址、节点 ID 与从配置证书算出的公钥指纹；没有开放登记时还含注册令牌。含令牌的文件要私下传回这台 Mac（例如自己管理的 SSH），不上传到公开链接，不提交。

在桌面端「设置 › 设备 › 关于连接」选「导入配置」，核对地址后选「验证并添加」，并在这台 Mac 的系统窗口确认。添加与移除只能由这台 Mac 上有 `admin` 的设备发起。每个节点只能添加一次，至多四个自建中继。

**Host 做什么。**

1. 先审计，再在现有出站规则下锁定解析出的地址。
2. 核对 TLS 证书、服务器名、公钥指纹与节点标识。
3. 实际登记一条随配置保存的真实路由。
4. 只有登记成功且配置与回执都已写入，才在签名地址簿里发布。

验证连接在发送准入帧时复查权限与出站规则，文件原子替换前再查一次。局域网或内网的中继需要本机管理员先在出站规则里放行对应的 `host:port`；导入只确认这一个中继，不改全局出站规则。

**失败、放弃与移除。**

- 网络或写入失败后，页面继续同一个待确认请求；重试复用私有配置里保存的原路由种子。
- 文件已替换而目录同步结果未知时（503 `native-relay-write-unknown`），先确认那次保存，再允许后续提交。
- 放弃会阻止未完成的请求发布。
- 保存后的条目显示真实的控制链路状态，可由本机管理员移除。已有的设备身份保持有效，之后不再分发已移除节点的新地址。
- 移除与放弃都先尝试留审计，再替换配置；审计写失败时仍完成收紧，响应标明审计失败。

## 验证

公开的 `/healthz` 只说明节点是否接受连接。完整的验证要用手机或原生客户端走实际的配对、跨网连接、重连与撤销。
