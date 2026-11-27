---
description: 手机在其他网络连回 Mac：先直连，否则经自己的中继（Linux 服务器或自己的 Cloudflare 账户），部署、验收、在 Mac 上核对与测试、两种类型的身份与谁能看到什么、按状态排查。
sources:
  - apps/relay/gateway/main.go
  - apps/relay/src/acme.ts
  - apps/relay/src/self-tls.ts
  - apps/relay/src/cli.ts
  - apps/relay/src/config.ts
  - apps/relay/deploy/compose.yaml
  - apps/relay/deploy/compose.standalone.yaml
  - apps/relay/deploy/install.sh
  - apps/relay/deploy/upgrade.sh
  - apps/relay/scripts/bundle-linux.ts
  - apps/relay/scripts/accept-linux.ts
  - apps/relay/scripts/setup-linux-core.ts
  - apps/relay/scripts/setup-linux.ts
  - apps/relay-edge/src/node.ts
  - apps/relay-edge/src/buffers.ts
  - apps/relay-edge/src/edge.ts
  - apps/relay-edge/deploy/wrangler.jsonc
  - apps/relay-edge/deploy/README.md
  - apps/relay-edge/scripts/setup-core.ts
  - apps/relay-edge/scripts/wrangler.ts
  - apps/relay-edge/scripts/accept-core.ts
  - apps/relay-edge/scripts/accept.ts
  - packages/link-client/src/relay-files.ts
  - apps/web/src/settings/RelaySettings.tsx
  - apps/web/src/settings/relayCommands.ts
  - packages/protocol/src/relay-endpoint.ts
  - packages/link-wire/src/relay-identity.ts
  - packages/link-wire/src/relay-availability.ts
  - packages/link-wire/src/pass.ts
  - apps/host/src/routes/native.ts
  - apps/host/src/native-settings.ts
  - apps/host/src/native-network.ts
  - apps/host/src/native-network-backend.ts
  - native/macos/LatchNetwork.swift
  - apps/host/src/relay/controller.ts
  - apps/host/src/relay/profiles.ts
  - apps/host/src/relay/official.ts
  - apps/host/scripts/latch-relay.ts
---
# 中继

## 什么时候需要中继

- **首次配对。** 手机通过可互访的局域网或 USB 个人热点连上 Mac。首次扫码来自另一个可达的私网子网时，手机和 Mac 系统确认窗口各自显示六位核对码。逐位核对后才在 Mac 上批准，不一致或手机没有显示数字时取消。中继不承办首次配对。
- **配对以后。** 手机尝试当前网络发现的直连入口。配置了中继时，两条路可以同时尝试；手机从 Mac 签名的连接簿里取中继地址，Mac 事先在中继上登记好。先验证成功的路径承载连接。没有可用直连和中继时，手机离线。
- 中继看不到会话正文：手机与 Mac 之间还有一层只在两端建立和验证的 TLS，Host 身份证明与设备授权都在这层里。中继能看到连接 IP、时间、填充后的大小与流向、哪条登记的路由被谁连接。显式传输（上传附件、打开文件）按网速走，在中继看来是一段有大小和速率的突发流量。

需要中继时，使用运营者自己的 Linux 服务器或 Cloudflare Workers。Latch 没有官方中继。「设置 › 连接转发」第一行显示这台 Mac 是否已开启直连监听。手机是否发现并连通它，要看手机端结果。下面列出已接入的中继。本机管理员还会看到找到的连接配置，可以直接核对并连接。已接入的中继可测试、启停或从这台 Mac 移除。

- **谁能看到什么。** 中继的运营者（你自己）与平台（服务器所在的云，或 Cloudflare）能看到：两端 IP、时间、填充后的大小与方向、路由标识、哪条路由被接通、通行证字段、路由令牌与准入证明；手机与 Mac 一样，在用时按 40 ms 一格发、空闲时 250 ms，所以看得出何时在用，看不出单个请求的大小与时刻；一次显式传输（打开文件，或经中继上传大于 1 MiB 的附件）表现为一条单独连接上一段有大小和速率的突发流量：总量补到大小档，所以看得出大致的大小、结束时刻与链路速率。看不到：会话正文、Host 身份、设备授权，它们都在端到端的内层。Latch 的中继代码不写日志、不存完整 IP；Cloudflare 自己的边缘日志不在 Latch 控制之内，部署时关闭了 Workers 的日志与观测。
- 当前没有官方中继的行、开关与「优先使用」设置。

### 同一网络怎样判断

首次配对期间，或 Mac 认出已经证明过的网络时，它会在选中的接口上通过 Bonjour 发布匿名名称。换到陌生 Wi-Fi 后，即使两台设备都连上了，也可能还发现不了对方；可以在 Mac 上打开「显示二维码」暂时开启发现。访客网络若隔离设备，仍须换到能互访的网络。

同名 Wi-Fi 也可能给手机和 Mac 分配不同子网。已配对手机收到跨子网的 Bonjour 发现时，还要在 Mac 签名且有效的连接簿中核对地址与端口。办公网允许设备互访但不转发 Bonjour 时，在手机的电脑设置里点「用 Mac 的局域网地址重连」。地址变化或连接簿过期时，也可以扫描 Mac 当前的二维码；手机核对已保存的 Host 公钥并沿用原设备身份。用上述地址成功直连后，手机可在本次前台网络上短时复用它，最长十分钟，最长不超过有效地址证据的期限。换网、锁屏或进入后台时清除。直连不可用时，手机可以走连接簿中可用的中继。

初次拨号时，已有直连候选通常先试 250 毫秒，当前网关上次走直连时先试 600 毫秒。正在使用的连接失效后，手机立即尝试可用的直连和中继，保留当前页面与草稿。中继接手后，手机发现可用的直连时会在连接空闲时再尝试切回。见[手机重连](STREAMING.md#手机重连)。

- **网络组件。** `latch-network`（`native/macos/LatchNetwork.swift`）把这台 Mac 的地址交给 Host，最多 16 行：先排物理网口（`en*` 的 Wi‑Fi、有线）的私网 IPv4，再排它们的唯一本地与链路本地 IPv6，隧道最后，所以排在系统列表末尾的 USB 网卡不会被挤掉。每个接口的网关取它自己服务的 `Router`（`State:/Network/Service/<id>/IPv4|6`），不是只有主接口才有；同一接口两个服务给出不同网关时不给网关。
- **配对的邻近证明。** 手机报它所在网络的网关哈希；Host 只用手机连进来的那个地址（`localAddress`）所在接口的网关比对，再看邻居表里手机与网关的硬件地址。同子网内缺少这些证据时拒绝。另一私网子网上的手机通过物理接口直连时，支持核对码的两端可改用六位数核对。两端根据本次登记编号、Host 的随机挑战、Host 身份与手机两把公钥各自计算。跨网配对不会把网段记为已证明的邻近网络。
- **自动选址。** 直连入口只有一个地址，按数据线热点、Wi‑Fi、有线的顺序选：手机只会从 Wi‑Fi（包括 Mac 临时连上的 iPhone 个人热点）或数据线进来，有线口常在手机到不了的另一个网段。已绑定的地址只在没有更靠前的种类时保留，所以启动时只有有线、之后 Wi‑Fi 起来，入口会移到 Wi‑Fi。要固定地址用 `--native-host`。
- **iPhone 的个人热点经数据线。** iPhone 用数据线共享网络时，这台 Mac 多一个以太网接口，iPhone 是它的网关。组件按 USB 厂商（Apple）与产品名（iPhone、iPad）认出它并标为 `tether`，连接簿里它仍是 `ethernet`。自动选址时它排在 Wi‑Fi 与有线之前：数据线插着时直连入口在这根线上，二维码下方提示用数据线连接并打开个人热点。同一 Wi‑Fi 的其他手机此时需要可用中继才能连接。邻近证明：手机就是这根线的网关，来源就是网关地址即成立，配对与日常的 `/native/proximity` 都不查邻居表。理由：USB 接口是到这台 iPhone 的点对点链路，只有它能是这根线的网关；它路由出去的流量不会转发进来，热点上的其他设备（Wi‑Fi、蓝牙或另一根线）用自己的地址，仍按邻居表判断。这根线以子网命名（`knownTetherHash`，不含网关 MAC），证明过一次就算已知网络，之后没有邻居表也在上面发布 Bonjour。每台 iPhone 的热点子网相同，所以「已知」只决定在这根线上发布匿名名称，认证不变。数据线本身不建立信任，配对仍要扫码并在 Mac 上确认。Wi‑Fi 不放宽：日常证明与已知网络都要网关 MAC。
- **邻居表与启动方式。** macOS 27 上，只要还在运行的上级进程里有 ad-hoc 签名的程序（独立可执行版 pnpm、fnm，或本机打的包），进程就读不到 IPv4 邻居表里的硬件地址。这与「本地网络」权限和负责进程无关；它是在 macOS 27.3 上观察到的行为，Apple 没有公开规则（[Apple 对 IPv4 邻居表查询的说明](https://developer.apple.com/forums/thread/822025?page=2)）。所以 Host 不直接启动网络组件：一个立即退出的 `/bin/sh` 在后台启动它，组件改由 launchd 接管，Host 怎么启动都读得到邻居表。负责 App 不变，本地网络的判断照旧。请求经 fd 4 送达（Node 在直接子进程退出时会关闭它的标准输入），fd 3 交回组件的 PID；组件仍持有 stdout 时 Host 才按 PID 结束它，stdout 关闭才算真正退出。Host 退出或崩溃时管道关闭，组件读到结尾自行退出。
- **权限状态。** 没有这项权限时，macOS 拒绝 Bonjour 注册（`kDNSServiceErr_PolicyDenied`）。网络组件把它报为 `denied`，Host 不再按 30 秒重试，组件挂一个等待中的 TCP 连接到该接口的网关，系统给了权限后报 `ready`，Host 立即重新发布。另一个信号是邻居表：绑定的 Wi‑Fi 或有线接口问过网关后仍看不到它的硬件地址。两者之一成立时，`native/info` 与配对面板的轮询带 `localNetwork`（`denied` 或 `unreadable`），设置 › 连接转发 的「直接连接」与连接手机的面板分别按证据显示「本地网络未允许」或「无法读取本地网络信息」：桌面端的按钮打开「系统设置 › 隐私与安全性 › 本地网络」（桌面端只放行这一个 `x-apple.systempreferences:` 地址），打包的应用另在屏幕底部居中浮出一张不取焦点的引导卡（`local-network-guide.cjs`）：「在「本地网络」里找到 Latch，打开它的开关」与 Latch 的图标和名字；它每秒读一次 `native/info`，看到 `allowed` 显示「已允许」约 1.2 秒后关闭，也在按 ×、5 分钟后或回到 Latch 窗口时关闭；浏览器里写出这条路径。数据线热点上看不到邻居表不算问题，不提示。
- **只有数据线、不开热点**：尚未实现。要由 Mac 经 usbmuxd（系统未公开的接口）拨到手机 App 的回环端口，还需要一种不靠局域网的邻近证据。

## 中继协议的身份

| | 旧版固定证书（v1 配置文件） | 中继独立密钥（v2 配置文件：Linux 新部署与 Cloudflare Workers） |
| --- | --- | --- |
| 外层 TLS | 运营者自己的证书，在自己的机器终止 | WebPKI 证书（内置 ACME 自动签发、同机 Caddy/Nginx 反代或 Cloudflare 终止） |
| 节点身份 | 固定证书公钥（SPKI SHA-256） | 中继自己的 Ed25519 密钥：每条连接先发随机数，节点用私钥签名后才继续 |
| 准入证明 | v1，不绑定这条连接 | v2，绑定节点在这条连接上的随机数，只能用一次 |
| 地址 | 一个 | 一到四个，手机与 Mac 竞速，先通过签名检查的胜出 |

签名文本、证明文本与消息格式写在 [relay-identity.ts](../packages/link-wire/src/relay-identity.ts) 与 [pass.ts](../packages/link-wire/src/pass.ts)，共享向量在 `packages/testkit/vectors/link-v1.json`（`edgeRelay`、`addressBookV4`）。

- 一个 v2 节点可以有多个地址（例如 `workers.dev` 与自定义域名），且外层 TLS 证书自动续期换私钥不会使客户端配置失效，因为绑定连接与节点的是中继自己的 Ed25519 密钥签名。
- iOS 拨中继时，从外层连接到验证 Mac 的根证明最多 24 秒。每个握手步骤最多等 8 秒，只有完成一个步骤才给下一步计时。
- iOS 的路径轮次取消时，每个来源停止拨号或准入，并等待 NIOTS 通道结束。换网或替换轮次等待上一轮退出。
- iPhone 上同一节点的几个地址同时只有一个发送准入证明。它 4 秒内没有接合就关闭连接、放弃这次准入，其间被拒的地址再拨一次，所以一个卡住的地址不会拖到整轮超时。
- 中继密钥的签名不绑定外层 TLS 会话：能为这个域名终止 TLS 的一方可以把它实时转发。它保证节点的密钥参与了这条连接，并让每个准入证明只能用一次；再在 WebSocket 里加一层对节点密钥的加密尚未实现。
- Linux 节点同时保留 `/v1/{h,d,c}` 的旧版 v1（固定证书 SPKI）支持，已部署的旧配置继续可用。

## 自己的中继

### 方式 A：Linux 服务器

需要一台可 SSH 登录的 Linux 服务器（`x86_64` 或 `arm64`，运行 `systemd`）。**不需要购买域名**，服务器也无需拉取 Latch 源码或安装 Node、pnpm、Go。

在 Latch 的源码目录运行一条命令（「设置 › 连接转发 › 添加转发服务 › 自己的服务器」会根据所填项自动生成命令）：

1. **只有公网 IP、没有域名（最常用，默认优先用安全组已放行的 443 端口，若被占用自动回退 8443）**：
   ```sh
   pnpm latch relay setup linux --server root@203.0.113.10
   ```
   命令自动识别服务器公网 IP（若用 SSH 别名或处于云 NAT 后，也可显式加 `--ip <公网IP>`），探测 `443` 空闲时直接监听 `443`（免去云控制台改安全组；若 `443` 已被其他服务占用则自动切到 `8443`），在服务器上生成包含该 IP SAN 的 P-256 证书，并在后台到期前 30 天**复用同一把私钥**自动重签热加载（`spkiHash` 永久不变）。Mac 与 iPhone 均凭 256 位证书公钥哈希强绑定直连，不依赖外部公共 CA。
2. **有域名且服务器 443 端口空闲（自动申请并续期公共 CA 证书）**：
   ```sh
   pnpm latch relay setup linux --server root@203.0.113.10 --domain relay.example.com
   ```
   服务通过内置 ACME（`TLS-ALPN-01`，无需开放 80 端口）自动申请 Let's Encrypt 证书并在到期前 30 天复用原 TLS 私钥自动续期热加载，节点以持久 Ed25519 `relayKey` 证明身份（`--legacy-spki` 导出的旧版 v1 配置同样跨续期有效）。网关暂时不能加载新证书时，服务会重试加载。若 TLS 私钥丢失或与证书不匹配，续期会暂停，恢复原来的证书和私钥后会自动重试。
3. **有域名且复用服务器已有的 Caddy 或 Nginx 反向代理（443 已被占用时）**：
   ```sh
   pnpm latch relay setup linux --server root@203.0.113.10 --domain relay.example.com --behind-proxy
   ```
   服务只绑定服务器回环 `127.0.0.1:18443`（可用 `--port` 修改），由你现有的 Caddy 或 Nginx 在 `:443` 终止 TLS 并转发 `/v1/*` 与 `/healthz`；命令会给出对应的反向代理配置片段。反代尚未重载前可加 `--skip-accept` 先导出连接文件。
4. **使用服务器上已有的证书文件**（证书与私钥复制到 `root` 控制的 `/etc/latch-relay/tls`，仅向 `latch-relay` 服务组授予 `0640` 只读权限）：
   ```sh
   pnpm latch relay setup linux --server root@203.0.113.10 --domain relay.example.com --port 8443 --cert /etc/ssl/relay/fullchain.pem --key /etc/ssl/relay/key.pem
   ```
5. **添加与后续运维**：打开这台 Mac 的「设置 › 连接转发」，找到刚生成的服务器配置，点「核对并连接」。日常升级与查看状态同样在 Mac 上一条命令完成：
   ```sh
   pnpm latch relay setup linux --server root@203.0.113.10 --upgrade   # 平滑升级程序，保留节点身份与已配对手机
   pnpm latch relay status linux --server root@203.0.113.10            # 查看就绪状态、路由连接数、证书余量与月度流量
   pnpm latch relay uninstall linux --server root@203.0.113.10         # 停止并卸载系统服务（加 --purge-data 一并删除密钥目录）
   ```

升级时只给 SSH 目标，命令会按远端节点 ID 查找本机的原配置，沿用公网地址和端口。同一节点有多份配置时用 `--name` 选择，配置保存在其他目录时用 `--out` 指定原文件。

**手动或容器方式部署。** 也可先用 `pnpm exec tsx apps/relay/scripts/bundle-linux.ts --arch amd64 --out /绝对路径/relay.tar.gz` 打出独立包，或使用容器方式：

```sh
pnpm relay init --data-dir /srv/latch-relay --domain relay.example.com
# 或反代回环模式：pnpm relay init --data-dir /srv/latch-relay --domain relay.example.com --behind-proxy
# 或自有证书模式：pnpm relay init --data-dir /srv/latch-relay --domain relay.example.com --port 8443 --cert /etc/ssl/relay/fullchain.pem --key /etc/ssl/relay/key.pem
```

`init` 生成随机节点 ID、32 字节注册令牌与 32 字节 Ed25519 中继签名种子，不打印任何秘密。默认只计量中继自身转发字节（`quotaSource: 'relay'`，每月 500 GiB、用到 90% 停发新流量，创建时即完成 0 字节基准校准，同机其他服务的流量不会计入）；显式传入 `--iface <网卡>` 时改为计量整块 Linux 网卡字节（默认每月 100 GiB，需运行 `quota set-used` 校准当前计费周期已用字节）。

| 设置 | `init` 写入 |
| --- | --- |
| `quota` | 默认中继自身字节每月 500 GiB（加 `--iface` 时网卡字节每月 100 GiB）、每月 1 日重置、UTC、收发都计；用到 90% 停发新流量。空闲时攒下的最多 `burstBytes`（64 MiB） |
| `maxConnections`、`maxRoutes`、`maxPerPrefix`、`maxStateBytes` | 256、64、64、1 MiB |
| `gateway` | 握手并发 64、每秒 20、突发 32、每前缀 25%（`--behind-proxy` 不使用） |
| `memory`、`registrationWork` | 缓冲 16 MiB、预算 256 MiB；一个计算槽，难度 0–16 位 |
| `fairness` | 每前缀每日至多用掉配额的一半 |

字段与数值约束以 [config.ts](../apps/relay/src/config.ts) 和 [registration-work.ts](../apps/relay/src/registration-work.ts) 为准。默认只有持有注册令牌的 Host 能登记；`openRegistration` 是运营公共中继时才明确选择的设置。

```sh
pnpm relay check --data-dir /srv/latch-relay
pnpm relay start --data-dir /srv/latch-relay
pnpm relay status --data-dir /srv/latch-relay
pnpm relay health --data-dir /srv/latch-relay
```

其他子命令：`drain`（不再接新连接，排空现有连接）、`reload-tls`（续期后重读证书）、`quota set-used <字节>`（校准已用额度）；`pnpm relay --help` 列出全部。个人或小团队容器方式可直接用带默认值的 [compose.standalone.yaml](../apps/relay/deploy/compose.standalone.yaml)；严格生产容器编排用 [Dockerfile](../apps/relay/deploy/Dockerfile)、[compose.yaml](../apps/relay/deploy/compose.yaml)、[install.sh](../apps/relay/deploy/install.sh) 与 [upgrade.sh](../apps/relay/deploy/upgrade.sh)。

**中继文件。** 手动部署时从已检查的配置导出（默认导出 v2 `relayKey` 格式；加 `--legacy-spki` 导出旧版 v1 固定证书格式）：

```sh
pnpm relay profile --data-dir /srv/latch-relay --url https://relay.example.com --output /srv/latch-relay/latch-connection.json
```

`--url` 是 https origin（小写域名或 IPv6、可选端口，不带路径、`?`、`#` 或下划线），`--output` 是新文件的绝对路径，以 0600 写出，命令只打印写入结果与 8 位密钥短哈希，供在 Mac 的确认窗口里对照。

### 方式 B：自己的 Cloudflare 账户（edge）

适合自己和少数受邀者共用。默认只有持有注册令牌的 Mac 能登记。Latch 未实现按人限额。开放登记只在你明确把 `OPEN_REGISTRATION` 设为 `true` 且不设注册令牌时才有，部署命令不提供。

在 Latch 的源码目录依次运行（设置里的「Cloudflare Workers」给出同样的两条命令，名称与位置在页面上填）：

1. **登录**：`wrangler login`，在自己的终端由你本人完成。Free 计划可以运行：节点对象从不休眠，一个节点一天约用 10,800 GB-s，Free 每天 13,000 GB-s 与 100,000 次对象请求（收到的消息按 20 条计 1 次），超出后到 UTC 0 点前连接失败；长期使用选 Workers Paid（[价格](https://developers.cloudflare.com/durable-objects/platform/pricing/)）。Free 计划上，陌生人只要知道地址、每秒约 1.2 次升级请求就能用完当天的请求额度（被拒绝的升级同样计数）。Latch 不替你登录，也不读、不存 Cloudflare 的令牌。部署命令要求 wrangler 4.164.0，不在 PATH 上就停下，不代装。
2. **部署并验收**：`pnpm latch relay setup cloudflare --name home`。名称自己起（小写字母、数字与连字符，至多 40 个字符），它决定中继文件名、部署目录与 Worker 名（`latch-relay-home`）。`--location <位置>` 是 Cloudflare 的位置提示（`apac`、`apac-ne`、`apac-se`、`wnam`、`enam`、`sam`、`weur`、`eeur`、`oc`、`afr`、`me`），只是偏好；不给时不设提示，Cloudflare 把节点放在离第一次请求最近的地方。命令构建两个 Worker，部署注册挑战校验 Worker 与节点，生成中继密钥、注册令牌与管理令牌，经同一个加固的 wrangler 调用器从标准输入写进 secret（不进命令行参数、屏幕或日志），填好地址与节点标识后再部署一次，检查 `/healthz`，写出中继文件 `~/.latch/relays/home.json` 与旁边的 `home.json.admin-header`（都是新建的 0600 文件，已存在时在部署前停下，不覆盖；`--out <绝对路径>` 把中继文件写到别处），然后对刚部署的节点运行验收，逐项打印通过、失败或跳过，不打印令牌或地址。有失败项时退出码为 1，不要添加这个中继。各项见下文「Workers 的界限与验收」。
3. **添加**：打开这台 Mac 的「设置 › 连接转发」，找到标有「未添加」的 Worker，点「核对并连接」。对照配置文件、系统确认窗口与部署时的密钥短哈希。对于本机发现的文件，页面只提交文件选择和节点标识，由 Host 读取注册令牌。其他位置的文件可从「添加转发服务 › 已有配置文件」选择。

`pnpm relay-edge:setup --name home [--location <位置>]` 与 `pnpm relay-edge:accept --name home` 是这一流程的两步，可分开运行；早先的 `--region ne|se` 仍可用，等同 `--name ne --location apac-ne` 与 `--name se --location apac-se`，沿用原来的部署目录。安装版的 `latch relay setup cloudflare` 尚未实现：安装包不带 Workers 部署包。

**你的中继文件放在哪里。** 默认目录是 `~/.latch/relays/`。`~/.latch` 与 `relays` 都是本人所有的 0700 目录。主列表也识别主目录下原有的 `~/latch-relay-<名称>.json`。自动发现只读自己的私有普通连接文件，跳过符号链接和管理文件，不联系 Cloudflare。相同节点只显示一次，优先使用标准目录的配置。

| 文件 | 内容 | 添加之后 |
| --- | --- | --- |
| `<名称>.json` | 中继文件：地址、节点身份、注册令牌 | 可以删除：Host 已保存需要的部分；要给另一台 Mac 用或重新验收时再保留 |
| `<名称>.json.admin-header` | Workers 中继的管理令牌（`Authorization` 头） | 留着：查看状态与排空要用；重新验收还需要中继文件 |
| `<名称>/deploy/` | 部署命令生成的 wrangler 配置与 Worker 副本，不含秘密 | 留着，`wrangler deploy -c` 或 `wrangler delete` 时用 |

部署目录按名称命名，因为 Worker 按名称命名（`latch-relay-<名称>`）：同一名称再次部署就是重新部署同一个 Worker。早先版本把部署目录放在 `~/.latch-relay/latch-relay-<地区>`，中继文件放在 `--out` 指定处；新位置没有这个名称的部署目录时，部署命令照常使用旧目录并打印一行搬移命令，从不自动移动或删除。日常连接不需要迁移部署目录或管理令牌。运营者如需连同部署工具搬移，以东京节点为例：

```sh
(umask 077 && mkdir -p ~/.latch/relays/ne) && mv -n ~/latch-relay-ne.json ~/.latch/relays/ne.json && mv -n ~/latch-relay-ne.json.admin-header ~/.latch/relays/ne.json.admin-header
mv -n ~/.latch-relay/latch-relay-ne ~/.latch/relays/ne/deploy && rmdir ~/.latch-relay
```

- 再次运行部署命令会换新的中继密钥、注册令牌与节点标识，旧中继文件随之失效：这也是收回某人使用权的办法，之后只把新文件交给仍要用的人。默认位置已有 `ne.json` 或 `ne.json.admin-header` 时它在部署前停下：先在 Mac 上移除旧中继并删除这两个文件，或用 `--out` 把新文件写到别处。
- 保留节点身份和令牌的更新会短暂断开连接，Mac 可用原配置重新登记。若同名 setup 已换身份，各台 Mac 需导入新文件，手机也要经直连或其他仍可用的路径取得新连接簿。删除：先在 Mac 上移除这个中继，再 `wrangler delete --name latch-relay-ne`。
- 自定义域名作为同一节点的另一个地址尚未接入部署命令。

### 几个人共用一个 Workers 中继

这条路径需要支持 Workers 中继的原生 iOS App；当前仓库提供源码，尚无公开安装入口。

1. 运营者保留一个已验收、凭注册令牌登记的节点。已有节点无需重新部署；同名 `setup` 会更换节点身份和令牌。通过私密渠道把 `<名称>.json` 交给受邀者，另行核对节点地址和密钥短哈希。`.admin-header` 留在运营者手中，受邀者无需 Cloudflare 账号或管理令牌。
2. 每位受邀者在自己的 Mac 上打开「设置 › 连接转发」。已发现的配置可直接核对；收到的其他文件从「添加转发服务 › 已有配置文件」选择。核对地址与短哈希，在系统窗口确认。每个 Host 独立生成路由密钥，注册令牌只授予在中继上登记路由的资格。
3. 每人的手机先与自己的 Mac 配对。若此前已配对，在原有可用路径上连一次，让手机取得含中继的签名连接簿。要验证异网接入，保持 Mac 在线，将手机切到蜂窝网络，从手机读取自己 Mac 上的会话。Mac 上「测试」成功只证明 Mac 到中继的这一段。只让一台测试手机打开会话，可在 Mac 上用 `pnpm latch traffic --json --data-dir <测试 Host 的数据目录>` 查看仍在打开的事件流（`connections` 中没有 `closedAt` 的项）；`listener` 为 `native-direct` 或 `native-relay` 表明该流实际经过的入口。

同一节点的持有人共用注册令牌，目前没有逐人撤销或逐人额度。收回一人的登记资格需要轮换并给其余 Mac 更新配置；仅从某台 Mac 移除中继并不能收回已经发出的文件。若需要不同组能独立退出，可以部署不同名称的节点，每组一份文件。Cloudflare 的 Workers 和 Durable Objects 可分别配置账户级支出限额，达到限额会影响该产品在账户里的其他服务；账单提醒只发送通知。[Cloudflare 支出限额与提醒](https://developers.cloudflare.com/billing/manage/spend-management/)

### 在 Mac 上添加

选中页面列出的配置文件，或用「选择文件」读入一个之后，出现核对卡：方式、地址、密钥短哈希（v1 配置显示证书公钥 SPKI 的 SHA-256 前 8 位十六进制，v2 配置显示中继 Ed25519 公钥的 SHA-256 前 8 位）；注册令牌只写「已包含」。选「确认并连接」后这台 Mac 弹出系统确认，窗口写明第一个地址、地址总数与同一个密钥短哈希，对照后再确认。之后一行进度：连上、密钥相符、注册、签发连接信息。Host 签好包含当前中继配置的连接簿后显示「这台 Mac 已签发」。手机收到和使用连接簿的状态需要手机端的证据。任一步失败就停在那一步，写明原因并给「重试」（原 requestId 与原 profile，不重复添加）；结果未知时关闭对话框仍在本页内存中保留原请求，展示用的密钥短哈希不进入请求体。

- 首屏的「未添加」表示找到本机文件。隐藏后仍可从「添加转发服务 › 已有配置文件」找回。这里不枚举 Cloudflare 账户中的部署。
- 手选文件或连接旧位置的文件，Host 在身份核验和登记通过后默认归档一份 0600 的连接配置。旧文件优先用原名称，手选文件按节点 ID 命名；同名冲突时按节点 ID 保存，同内容的私有文件可复用，已有文件不会被覆盖。归档和 Host 登记是两次写入：归档成功后如果 Host 的保存结果待确认，可继续原请求；如果只失败在归档，页面会报告已连接及归档失败。
- 「从这台 Mac 移除」从本 Host 收回中继连接并隐藏首页的本机文件。导出的配置仍可重新添加。云端 Worker 及其他 Mac 的连接不受影响。启停和移除都不用 Cloudflare 账户权限。
- 只有这台 Mac 上有 `admin` 的设备能添加、停用、移除；其他有 `admin` 的设备只看得到列表与状态。
- 网页打开「连接转发」时定期刷新状态。离开该分类后停止刷新，返回时读最新状态。
- 每个节点只能添加一次，至多四个自己的中继；存在多个中继时手机按列表从上到下的顺序依次尝试连接，本机管理员可在「设置 › 连接转发」中直接拖动（或经菜单上移、下移）调整优先顺序并重新签发连接簿，已建立的控制连接不断开。
- 中继文件使用完整、规范化的 HTTPS 来源地址，例如 `https://relay.example.com/` 或 `https://relay.example.com:8443/`，保留末尾的 `/`。域名小写，IPv6 用方括号。设置、`latch relay add` 与 Host 都核对地址（[relay-endpoint.ts](../packages/protocol/src/relay-endpoint.ts)）。
- Host 停止时可用 `latch relay add --data-dir <目录>`（读 `~/.latch/relays` 里唯一的中继文件；`--name <名称>` 选其中一个，`--file <中继文件>` 指定其他位置）、`relay list` 和 `relay remove <节点标识>`。源码运行使用 `pnpm latch`。添加时终端列出每个地址与密钥短哈希，核对后输入 y，非交互用 `--expect-key <密钥短哈希>`。先写审计再保存为待核对，Host 启动后节点证明密钥并接受登记，才可进入签名连接簿。离线 `relay list` 会标出「已停用」与「待核对」。Host 运行时可用 `relay test <节点标识>` 检查连通性、身份与登记，并查看 Host 签发状态。源码目录运行 `pnpm latch relay setup linux` 可经 SSH 一键把自包含中继部署到 Linux 服务器、完成端到端验收并写出 `~/.latch/relays/<名称>.json`。

**Host 做什么。**

1. 先审计，再在现有出站规则下锁定解析出的地址。
2. 按配置版本核对节点身份。v1 验证 TLS 证书、域名或 IP 以及固定的 SPKI。v2 验证 WebPKI 证书和中继密钥对挑战的签名。有多个地址时，先通过签名检查的地址胜出。
3. 实际登记一条随配置保存的真实路由。
4. 只有登记成功且配置与回执都已写入，才在签名连接簿里发布。

「测试」先记 `native.relay.test` 审计（节点与配置的哈希），再登记这个中继当天专用的测试路由，不影响正在用的那条；同一天重复测试复用同一条路由，同一时间只运行一项测试，Host 停止时不再开始；审计失败时不解析地址或连接，等待期间与每次写前复核权限及所测配置。文件已替换而目录同步未知时（503 `native-relay-write-unknown`）先确认那次保存。移除与放弃都先尝试留审计，再替换配置；审计写失败时仍完成收紧；CLI 移除或关闭也容忍审计打开失败，并在终端报告审计失败。启用一个中继与添加一样，审计写不进就不做。局域网或内网的中继需要本机管理员先在出站规则里放行对应的 `host:port`。每条控制与数据连接持有其实际来源和锁定 IP 的出站许可；撤销许可后只关闭失去许可的连接。

### 手机怎样得到新中继

手机不需要做任何事。Mac 每次发连接簿都按当前设置重新签名；只要手机连着 Mac，Mac 在中继新增、停用、移除或拖动调整顺序时会通过快照与事件流的 `relayEpoch` 提示手机立即在后台拉取新连接簿，若手机当前正走次优中继，还会在连接空闲时后台静默切到新的第 1 顺位中继（不断会话）；当时不在线的手机下次连上 Mac（同一网络，或经仍可用的中继）时同样会自动取得新连接簿。移除的中继不再出现在之后的连接簿里。只在其他网络、而且旧连接簿里没有可用中继的手机，要先回到同一网络连一次。Workers 中继需要包含这一版本的 App：之前的版本跳过连接簿里的 Workers 地址。

## Workers 的界限与验收

节点对象只按自己持有和交给 `send()` 的东西设界限，不依赖平台的关闭或积压信号（[buffers.ts](../apps/relay-edge/src/buffers.ts)）。其中只有前两条是内存上限：

- 收到后待处理的数据与前三秒填充队列是节点自己的内存：每连接 512 KiB / 512 条，每对象 8 MiB / 8192 条，超出即关闭连接。
- 未认证且有填充的连接（手机与 DATA 腿；Host 的控制连接没有填充）全对象同时最多 16 个，每个在认证前最多交给平台 512 KiB。满了不拒绝新连接，而是关闭「未认证连接最多的那个前缀」里最旧的一个：一个或几个前缀占着名额时，别的前缀的手机与 Host 仍能进来。
- 连接槽：全对象 1024 个，每个 /24 或 /48 前缀最多 64 个（开着的加上关闭后按时钟保留 5 秒的）。槽满时，槽最多的前缀先让出一个保留中的槽或最旧的未认证连接；只有新连接自己的前缀已占满份额且没有可让出的，才拒绝它。
- 每个连接交给平台的字节按速率计，超出即关闭：
  - 已认证并已接合的连接（手机与它的 DATA 腿）：8 MiB 起，每秒补 16 MiB，显式传输按网速走（约 130 Mbit/s 以内）。发送方须自己限速在这以下。
  - 其他连接（未认证的、Host 的控制连接）不变：1 MiB 起，每秒补 768 KiB（活跃填充网格每秒约 400 KiB），认证前最多 512 KiB。
  - 这是速率，不是内存上限：一个持有通行证、停止读取的手机仍能让平台的发送缓冲按每秒 16 MiB 增长，除非平台在 `bufferedAmount` 报告积压且积压会回落，那时积压上限是更早的那道关闭。
- 平台报告的 `bufferedAmount` 是合法数值时只用于提前关闭：已接合的连接积压超过 6 MiB（大块传输的 HTTP/2 连接窗口 4 MiB 加上单元与帧）、其他连接超过 1 MiB，或全对象合计超过 32 MiB 时关闭最大的。它从不释放预算；探测时平台读到过这个数值，但是否随慢读者回落没有测过。
- 这些数值是部署变量 `LIMITS`（JSON）里的 `joinedSendBytes`、`joinedSendRate`、`joinedBacklogBytes`、`objectBacklogBytes`，以及原有的 `maxBacklogBytes`；不设时用上面的默认值（[node.ts](../apps/relay-edge/src/node.ts) 的 `limits()`）。
- 每个节点对象最多在内存中持有 16,384 个 DENY 标签，每条路由最多 8192 个。恢复时只读取剩余额度允许的标签，满额时拒绝登记或关闭无法完整记录 DENY 的路由。

平台本身的几件事无法在本地验证，由验收命令在真实部署上检查，或说明最坏情况：

| 行为 | 怎样处理 |
| --- | --- |
| 帧经过边缘是否完整、不分片不合并；子协议原样回显 | 已在自己的账户实测：完整（2026-11-17）；验收「前三秒填充」再查一次 |
| 节点对象落在哪里 | 已实测：`apac-ne` 在东京，`apac-se` 在新加坡 |
| 平台在 JavaScript 之前组装消息，单条最多 32 MiB（[文档](https://developers.cloudflare.com/workers/runtime-apis/websockets/)） | 设计上无法限制，而且可以反复发生：任何知道地址的人都能在未认证的 3–4 秒内送进几条接近 32 MiB 的消息（一台上行约 300 Mbit/s 的服务器即可），对象超过平台的内存上限就被重置，所有连接断开，Mac 重新登记、手机重连；对方每次对象重启后都能再来一次。会话正文不受影响。验收「超限消息」送 4 条 8 MiB 的消息并核对对象没有重置，不覆盖 32 MiB 的情况 |
| 关闭后平台何时释放连接的发送队列 | 不依赖：连接槽按时钟保留，交给平台的字节按速率计。验收「未认证连接被关闭」核对大量未认证连接都被关闭、对象没有重置、仍能登记 |
| 已接合连接的实际速率 | 验收「按线速传输」在填充窗口之后让一对已接合连接每个方向送 32 MiB（每秒 8 MiB），速率须远高于每秒 768 KiB、两腿都不被关闭；你自己的上行比这慢时这一项也会失败，详情里有两个方向的实测速率 |
| 不读的手机：平台是否报告并回落积压 | 只有平台报告积压时节点才能按积压关闭它；否则平台缓冲按已接合连接的速率（每秒 16 MiB）增长到对象被重置。能这样做的只有持有通行证的已配对设备。验收「不读的手机在新预算下被关闭」以每秒 4 MiB（高于旧预算、低于新预算）发给停止读取的手机，最多 64 MiB，检查节点是否关闭它；失败表示这一界限在你的部署上不成立 |
| 平台内存与消息速率 | 本地无法验证：平台的发送缓冲是否计入每个 isolate 的 128 MB，以及 16 KiB 的 DATA 在高速传输时每秒上千条消息是否触到每对象约每秒 1,000 次的软上限。节点自己持有的 8 MiB 加上 32 MiB 的积压上限远低于 128 MB；验收的两项会显示对象是否被重置 |
| 健康检查、管理接口 | 验收「健康检查」「管理接口只认令牌」：`/healthz` 200，`/admin/status` 无令牌或错误令牌时 404 |
| 中继密钥与注册令牌 | 验收「错误密钥与令牌被拒绝」「用中继文件登记」 |

- 验收先用管理令牌取 `/admin/status`，得到 200 才继续，所以只能对你自己的中继施压。它的路由按中继与日期派生，重复运行复用同一条，不留新的 24 小时路由；两次运行之间隔半分钟。
- 尚未处理：升级被拒绝时的 503 让同一前缀的人能粗略看出节点上未认证连接的多少。
- 验收命令的各项也在本地 Workers 适配器上运行（`apps/relay-edge/test/accept.test.ts`），那里的通过不能代替真实部署上的结果。

## 按状态排查

| 状态 | 含义 | 怎么办 |
| --- | --- | --- |
| 直连 可用 / 未开启 | 这台 Mac 现在有没有等待同一网络手机的局域网入口 | 没有配对的手机或没有局域网时不开启 |
| 连接中 | Mac 正在连接或登记 | 等几秒 |
| 已连接 · 延迟 | Mac 已在节点登记，手机可经它连接 | — |
| 密钥不符 | 节点给出的密钥或证书与中继文件不一致 | 确认文件来自这个中继；重新生成文件后移除再添加 |
| 连不上 | 连不上节点或连接中断，Mac 在退避重试（下次重试的时间在悬停里） | 检查地址、DNS、出站规则；`/healthz`、`/admin/status` |
| 注册被拒绝 | 节点拒绝了这台 Mac：注册令牌不对或缺失、节点已满 | 重新导出中继文件后移除再添加 |
| 已停用 | 你在 ⋯ 里停用了它 | 需要时启用 |
| 尚未实现 | 这个版本关闭了 Workers 中继 | 可停用或移除已有配置 |
| 需要检查 | 同一天两次报告路由冲突 | 移除后重新添加 |
| 地址无效 | 早先保存的地址不符合连接簿格式（带 `?`、`#`、下划线等），不拨号、不进连接簿，其他中继照常签发 | 移除后用新的中继文件添加 |

公开的 `/healthz` 只说明节点接受连接（Linux）或 Worker 已配置（Workers）；Workers 节点是否可用看 `/admin/status`（`curl -H @"$HOME/.latch/relays/ne.json.admin-header" <地址>/admin/status`）。完整的验证要用手机在另一个网络实际连接、重连与撤销。
