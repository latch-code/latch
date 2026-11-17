---
description: 手机在其他网络连回 Mac：先直连，否则经自己的中继（Linux 服务器），三步接入、在 Mac 上核对与测试、两种类型的身份与谁能看到什么、按状态排查。
sources:
  - apps/relay/src/cli.ts
  - apps/relay/src/config.ts
  - apps/relay/deploy/compose.yaml
  - apps/relay/deploy/install.sh
  - apps/relay/deploy/upgrade.sh
  - apps/relay-edge/src/node.ts
  - apps/relay-edge/src/buffers.ts
  - apps/relay-edge/src/edge.ts
  - apps/relay-edge/deploy/wrangler.jsonc
  - apps/relay-edge/deploy/README.md
  - apps/relay-edge/scripts/profile.ts
  - apps/relay-edge/scripts/setup-core.ts
  - apps/relay-edge/scripts/wrangler.ts
  - apps/web/src/settings/RelaySettings.tsx
  - apps/web/src/settings/relayCommands.ts
  - packages/link-wire/src/relay-identity.ts
  - packages/link-wire/src/relay-availability.ts
  - packages/link-wire/src/pass.ts
  - apps/host/src/routes/native.ts
  - apps/host/src/native-settings.ts
  - apps/host/src/relay/controller.ts
  - apps/host/src/relay/profiles.ts
  - apps/host/src/relay/official.ts
  - apps/host/scripts/latch-relay.ts
---
# 中继

## 什么时候需要中继

- **同一网络：直连。** 手机与 Mac 在同一个局域网时，手机直接连 Mac，不经过任何中继。首次配对也在同一网络完成。
- **不在同一网络：经中继。** 手机从 Mac 签名的连接簿里取中继地址，Mac 事先在中继上登记好；中继只把两条连接接在一起。
- 中继看不到会话正文：手机与 Mac 之间还有一层只在两端建立和验证的 TLS，Host 身份证明与设备授权都在这层里。中继能看到连接 IP、时间、填充后的大小与流向、哪条登记的路由被谁连接。

跨网络接入使用你自己的 Linux 中继。Cloudflare Workers 中继尚未实现，官方中继列表为空。设置 › 中继 第一行是直连的状态（同一网络的手机现在能否直接连这台 Mac，原因在悬停里），下面是你的中继，每行有方式、地址、状态和 ⋯（测试、停用 / 启用、移除），底部是「添加中继」。

- **谁能看到什么。** 中继的运营者（你自己）与服务器所在的云能看到：两端 IP、时间、填充后的大小与方向、路由标识、哪条路由被接通、通行证字段、路由令牌与准入证明。看不到：会话正文、Host 身份、设备授权，它们都在端到端的内层。Latch 的中继代码不写日志、不存完整 IP。
- 当前没有官方中继的行、开关与「优先使用」设置。

## 中继协议的身份

| | `self`（Linux 服务器） | `edge`（Cloudflare Workers，供协议验证） |
| --- | --- | --- |
| 外层 TLS | 运营者自己的证书，在自己的机器终止 | Cloudflare 的证书，在 Cloudflare 终止 |
| 节点身份 | 固定证书公钥（SPKI SHA-256） | 中继自己的 Ed25519 密钥：每条连接先发随机数，节点用私钥签名后才继续 |
| 准入证明 | v1，不绑定这条连接 | v2，绑定节点在这条连接上的随机数，只能用一次 |
| 地址 | 一个 | 一到四个，手机与 Mac 竞速，先通过签名检查的胜出 |

签名文本、证明文本与消息格式写在 [relay-identity.ts](../packages/link-wire/src/relay-identity.ts) 与 [pass.ts](../packages/link-wire/src/pass.ts)，共享向量在 `packages/testkit/vectors/link-v1.json`（`edgeRelay`、`addressBookV4`）。

- 一个 edge 节点可以有多个地址（`workers.dev` 与自定义域名），因为绑定连接与节点的是签名，不是主机名：一个地址答出别的密钥，只会在竞速中输掉。
- iOS 的路径轮次取消时，每个来源停止拨号或准入，并等待 NIOTS 通道结束。换网或替换轮次等待上一轮退出。
- edge 的签名不绑定 TLS 会话：能为这个域名终止 TLS 的一方可以把它实时转发。它保证节点的密钥参与了这条连接，并让每个准入证明只能用一次；再在 WebSocket 里加一层对节点密钥的加密尚未实现。
- self 保持 v1 证明：已部署的自建节点与旧手机只认 v1，客户端也分不出升级过的节点，绑定需要一次不存在的协商。

## 自己的中继

### 方式 A：Linux 服务器（self）

「添加中继」› Linux 服务器同样是三步：登录（`ssh` 到你的服务器）、部署（下面的命令，在服务器上运行）、连接（用 `scp` 把中继文件取回这台 Mac，再拖进来）。部署命令需要在服务器上的 Latch 源码目录运行，应复制到登录服务器的终端。安装版用「已有中继文件」导入。在公网 Linux 上运行 Latch Relay：

**准备服务器。** 需要一台可直达的 Linux 服务器、指向它的域名与证书。

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
pnpm relay quota set-used USED_BYTES --data-dir /srv/latch-relay   # 用运营商报告的本周期已用字节校准
pnpm relay status --data-dir /srv/latch-relay
pnpm relay health --data-dir /srv/latch-relay
```

其他子命令：`drain`（不再接新连接，排空现有连接）、`reload-tls`（续期后重读证书）；`pnpm relay --help` 列出全部。每个命令都要显式的绝对 `--data-dir`。容器方式用 [Dockerfile](../apps/relay/deploy/Dockerfile)、[Compose](../apps/relay/deploy/compose.yaml)、[install.sh](../apps/relay/deploy/install.sh) 与 [upgrade.sh](../apps/relay/deploy/upgrade.sh)：映射的状态目录归容器的 UID/GID 65532，Compose 要求的环境变量必须给出，换镜像用 upgrade.sh（排空与回退）。

**中继文件。** 从已检查的配置导出：

```sh
pnpm relay profile --data-dir /srv/latch-relay --url https://relay.example.com:8443 --output /srv/latch-relay/latch-connection.json
```

`--url` 是 https origin，证书须与主机名相符；`--output` 是新文件的绝对路径，以 0600 写出，命令只打印写入结果。文件（版本 1）含地址、节点 ID、证书公钥指纹，没有开放登记时还含注册令牌。

### Cloudflare Workers（edge）

当前 Workers 的 WebSocket 接口在交给 JavaScript 前已经组装消息，也没有返回单连接物理关闭结果的接口。生产 Worker 拒绝升级，源码部署命令停止。设置与 CLI 拒绝添加 Workers 配置，已有配置可以停用、移除。Host 不为这些配置拨号或签发通行证，手机也跳过旧连接簿里的 Workers 地址。

协议和部署模块保留用于本地验证。发布门槛见 [Worker 验收条件](../apps/relay-edge/deploy/README.md)。

### 在 Mac 上添加

读入中继文件后出现核对卡：方式、地址、证书公钥 SHA-256 的前 8 位十六进制；注册令牌只写「已包含」。选「确认并连接」后这台 Mac 弹出系统确认，窗口写明第一个地址、地址总数与同一个密钥短哈希，对照后再确认。之后一行进度：连上、密钥相符、注册、连接簿签发。Host 签好包含当前中继配置的连接簿后显示「Host 已签发」。手机收到和使用连接簿的状态需要手机端的证据。任一步失败就停在那一步，写明原因并给「重试」（原 requestId 与原 profile，不重复添加）；结果未知时关闭对话框仍在本页内存中保留原请求，展示用的密钥短哈希不进入请求体。

- 只有这台 Mac 上有 `admin` 的设备能添加、停用、移除；其他有 `admin` 的设备只看得到列表与状态。
- 每个节点只能添加一次，至多四个自己的中继。
- 命令行：Host 停止时可用 `pnpm latch relay add --file <中继文件> --data-dir <目录>`、`relay list` 和 `relay remove <节点标识>`。添加时终端列出每个地址与密钥短哈希，核对后输入 y，非交互用 `--expect-key <密钥短哈希>`。先写审计再保存为待核对，Host 启动后节点证明密钥并接受登记，才可进入签名连接簿。Host 运行时可用 `relay test <节点标识>` 检查连通性、身份与登记，并查看 Host 签发状态。

**Host 做什么。**

1. 先审计，再在现有出站规则下锁定解析出的地址。
2. 核对节点的 TLS 证书、服务器名与公钥指纹。
3. 实际登记一条随配置保存的真实路由。
4. 只有登记成功且配置与回执都已写入，才在签名连接簿里发布。

「测试」先记 `native.relay.test` 审计（节点与配置的哈希），再另登记一条一次性的路由，不影响正在用的那条；审计失败时不解析地址或连接，等待期间与每次写前复核权限及所测配置。文件已替换而目录同步未知时（503 `native-relay-write-unknown`）先确认那次保存。移除与放弃都先尝试留审计，再替换配置；审计写失败时仍完成收紧；CLI 移除或关闭也容忍审计打开失败，并在终端报告审计失败。启用一个中继与添加一样，审计写不进就不做。局域网或内网的中继需要本机管理员先在出站规则里放行对应的 `host:port`。每条控制与数据连接持有其实际来源和锁定 IP 的出站许可；撤销许可后只关闭失去许可的连接。

### 手机怎样得到新中继

手机不需要做任何事。Mac 每次发连接簿都按当前设置重新签名；已配对的手机下次连上 Mac（同一网络，或经仍可用的中继）时取得新连接簿，之后在其他网络就会用到新中继。移除的中继不再出现在之后的连接簿里。只在其他网络、而且旧连接簿里没有可用中继的手机，要先回到同一网络连一次。

## Workers 平台验证

- 应用账本合计收到后等待处理的数据、填充队列与运行时未发送的 payload。每连接上限为 512 KiB 与 512 条，每对象上限为 8 MiB 与 8192 条。计数不可读取或遇到同步发送失败时拒绝继续写入，未结算的消息仍占用预算。
- workerd v1.20261117.1 接收一条消息会在 JavaScript 前组装至多 32 MiB。Workers 没有控制组装上限的接口。收到 Close 和 payload 计数归零后仍保留连接槽，正在发送的 Close 不计入 payload。Node 夹具验证应用账本，平台上的组装前内存和物理关闭需要另外验收。
- 每个节点对象最多在内存中持有 16,384 个 DENY 标签，每条路由最多 8192 个。恢复时只读取剩余额度允许的标签，满额时拒绝登记或关闭无法完整记录 DENY 的路由。

## 按状态排查

| 状态 | 含义 | 怎么办 |
| --- | --- | --- |
| 直连 可用 / 未开启 | 这台 Mac 现在有没有等待同一网络手机的局域网入口 | 没有配对的手机或没有局域网时不开启 |
| 连接中 | Mac 正在连接或登记 | 等几秒 |
| 已连接 · 延迟 | Mac 已在节点登记，手机可经它连接 | — |
| 密钥不符 | 节点给出的密钥或证书与中继文件不一致 | 确认文件来自这个中继；重新生成文件后移除再添加 |
| 连不上 | 连不上节点或连接中断，Mac 在退避重试（下次重试的时间在悬停里） | 检查地址、DNS、出站规则；`/healthz`、`/admin/status` |
| 登记被拒绝 | 节点拒绝了这台 Mac：注册令牌不对或缺失、节点已满 | 重新导出中继文件后移除再添加 |
| 已停用 | 你在 ⋯ 里停用了它 | 需要时启用 Linux 中继 |
| 尚未实现 | Workers 中继暂停上线 | 可停用或移除已有配置 |
| 需要检查 | 同一天两次报告路由冲突 | 移除后重新添加 |

Linux 中继的 `/healthz` 只说明节点接受连接。完整的验证要用手机在另一个网络实际连接、重连与撤销。
