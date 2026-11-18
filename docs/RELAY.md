---
description: 手机在其他网络连回 Mac：先直连，否则经自己的中继（Linux 服务器或自己的 Cloudflare 账户），部署、验收、在 Mac 上核对与测试、两种类型的身份与谁能看到什么、按状态排查。
sources:
  - apps/relay/gateway/main.go
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

跨网络接入使用你自己的中继：Linux 服务器，或你自己 Cloudflare 账户上的 Workers 中继。Latch 没有官方中继。设置 › 连接转发 第一行是直接连接的状态（同一网络的手机现在能否直接连这台 Mac，原因在悬停里），下面是你的中继，每行有方式、地址、状态和 ⋯（测试、停用 / 启用、移除），底部是「添加转发服务」。

- **谁能看到什么。** 中继的运营者（你自己）与平台（服务器所在的云，或 Cloudflare）能看到：两端 IP、时间、填充后的大小与方向、路由标识、哪条路由被接通、通行证字段、路由令牌与准入证明。看不到：会话正文、Host 身份、设备授权，它们都在端到端的内层。Latch 的中继代码不写日志、不存完整 IP；Cloudflare 自己的边缘日志不在 Latch 控制之内，部署时关闭了 Workers 的日志与观测。
- 当前没有官方中继的行、开关与「优先使用」设置。

## 中继协议的身份

| | `self`（Linux 服务器） | `edge`（Cloudflare Workers） |
| --- | --- | --- |
| 外层 TLS | 运营者自己的证书，在自己的机器终止 | Cloudflare 的证书，在 Cloudflare 终止 |
| 节点身份 | 固定证书公钥（SPKI SHA-256） | 中继自己的 Ed25519 密钥：每条连接先发随机数，节点用私钥签名后才继续 |
| 准入证明 | v1，不绑定这条连接 | v2，绑定节点在这条连接上的随机数，只能用一次 |
| 地址 | 一个 | 一到四个，手机与 Mac 竞速，先通过签名检查的胜出 |

签名文本、证明文本与消息格式写在 [relay-identity.ts](../packages/link-wire/src/relay-identity.ts) 与 [pass.ts](../packages/link-wire/src/pass.ts)，共享向量在 `packages/testkit/vectors/link-v1.json`（`edgeRelay`、`addressBookV4`）。

- 一个 edge 节点可以有多个地址（`workers.dev` 与自定义域名），因为绑定连接与节点的是签名，不是主机名：一个地址答出别的密钥，只会在竞速中输掉。
- iOS 的路径轮次取消时，每个来源停止拨号或准入，并等待 NIOTS 通道结束。换网或替换轮次等待上一轮退出。
- iPhone 上同一节点的几个地址同时只有一个发送准入证明。它 4 秒内没有接合就关闭连接、放弃这次准入，其间被拒的地址再拨一次，所以一个卡住的地址不会拖到整轮超时。
- edge 的签名不绑定 TLS 会话：能为这个域名终止 TLS 的一方可以把它实时转发。它保证节点的密钥参与了这条连接，并让每个准入证明只能用一次；再在 WebSocket 里加一层对节点密钥的加密尚未实现。
- self 保持 v1 证明：已部署的自建节点与旧手机只认 v1，客户端也分不出升级过的节点，绑定需要一次不存在的协商。

## 自己的中继

### 方式 A：Linux 服务器（self）

「添加转发服务」› Linux 服务器同样是三步：登录（`ssh` 到你的服务器）、部署（下面的命令，在服务器上运行）、连接（用 `scp` 把中继文件取回这台 Mac 的 `~/.latch/relays`，再拖进来）。部署命令需要在服务器上的 Latch 源码目录运行，应复制到登录服务器的终端。安装版用「已有配置文件」导入。在公网 Linux 上运行 Latch Relay：

**准备服务器。** 需要一台可直达的 Linux 服务器、指向它的域名与证书。

- **证书。** 证书链须受 Mac 与手机的系统信任，名称与中继地址一致。用同一把证书密钥续期时公钥指纹不变；公钥变了要重新导出并导入配置。
- **TLS 由 Latch 的 Go 网关直接处理**（`latch-relay-tls`）。域名指向这台服务器的服务端口（`init` 写出的是 8443），也可以由操作者核对后在同机配置 TCP 转发。公网连接或私有 Unix socket 任一端断开，网关关闭另一端，等待两个转发方向结束后释放连接槽。
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

`--url` 是 https origin（小写域名或 IPv6、可选端口，不带路径、`?`、`#` 或下划线：手机连接簿只认这种地址），证书须与主机名相符；`--output` 是新文件的绝对路径，以 0600 写出，命令只打印写入结果与密钥短哈希，供在 Mac 的确认窗口里对照。文件（版本 1）含地址、节点 ID、证书公钥指纹，没有开放登记时还含注册令牌。`--output` 没有默认值：这个命令以服务用户身份读私有数据目录，那个用户的主目录不是你的。

取回到这台 Mac 的 `~/.latch/relays`（名称用域名，点换成连字符）：

```sh
(umask 077 && mkdir -p ~/.latch/relays) && scp user@server:/srv/latch-relay/latch-connection.json ~/.latch/relays/relay-example-com.json
```

### 方式 B：自己的 Cloudflare 账户（edge）

给你自己和少数持有中继文件的人用。只有持有注册令牌（在中继文件里）的 Mac 能登记；Latch 不设花费上限，也不做多用户公平分摊，在 Cloudflare 为账户设账单提醒。开放登记只在你明确把 `OPEN_REGISTRATION` 设为 `true` 且不设注册令牌时才有，部署命令不提供。

在 Latch 的源码目录依次运行：

1. **登录**：`wrangler login`，在自己的终端由你本人完成。Free 计划可以运行：节点对象从不休眠，一个节点一天约用 10,800 GB-s，Free 每天 13,000 GB-s 与 100,000 次对象请求（收到的消息按 20 条计 1 次），超出后到 UTC 0 点前连接失败；长期使用选 Workers Paid（[价格](https://developers.cloudflare.com/durable-objects/platform/pricing/)）。Free 计划上，陌生人只要知道地址、每秒约 1.2 次升级请求就能用完当天的请求额度（被拒绝的升级同样计数）。Latch 不替你登录，也不读、不存 Cloudflare 的令牌。部署命令要求 wrangler 4.164.0，不在 PATH 上就停下，不代装。
2. **部署**：`pnpm relay-edge:setup --region ne`（`se` 为新加坡）。它构建两个 Worker，部署注册挑战校验 Worker 与节点，生成中继密钥、注册令牌与管理令牌，经同一个加固的 wrangler 调用器从标准输入写进 secret（不进命令行参数、屏幕或日志），填好地址与节点标识后再部署一次，检查 `/healthz`，最后写出中继文件 `~/.latch/relays/ne.json` 与旁边的 `ne.json.admin-header`（都是新建的 0600 文件，已存在时在部署前停下，不覆盖）。`--out <绝对路径>` 把中继文件写到别处。屏幕上只有进度、中继密钥短哈希和下一步命令。
3. **验收**：`pnpm relay-edge:accept --name ne`。`~/.latch/relays` 里只有一个中继文件时可省略 `--name`；有几个时它只列出名称；其他位置用 `--file <绝对路径>`。在任何 Mac 添加它之前对刚部署的节点运行，逐项打印通过、失败或跳过，不打印令牌或地址；有失败项时退出码为 1，不要添加这个中继。各项见下文「Workers 的界限与验收」。
4. **添加**：在 Mac 的「设置 › 连接转发 › 添加转发服务 › 已有配置文件」选 `~/.latch/relays/ne.json`（访达隐藏这个文件夹：`open ~/.latch/relays` 后拖进来，或在选择窗口按 ⌘⇧G 输入路径），对照核对卡、系统确认窗口与第 2 步打印的密钥短哈希。

**你的中继文件放在哪里。** 都在 `~/.latch/relays`：`~/.latch` 与 `relays` 都是 0700，命令逐级创建，是链接、不归你或组与其他用户可访问时拒绝使用。

| 文件 | 内容 | 添加之后 |
| --- | --- | --- |
| `<名称>.json` | 中继文件：地址、节点身份、注册令牌 | 可以删除：Host 已保存需要的部分；要给另一台 Mac 用或重新验收时再保留 |
| `<名称>.json.admin-header` | Workers 中继的管理令牌（`Authorization` 头） | 留着：查看状态与排空要用；重新验收还需要中继文件 |
| `<地区>/deploy/` | 部署命令生成的 wrangler 配置与 Worker 副本，不含秘密 | 留着，`wrangler deploy -c` 或 `wrangler delete` 时用 |

部署目录按地区命名，因为 Worker 按地区命名（`latch-relay-ne`）：同一地区再次部署就是重新部署同一个 Worker。早先版本把部署目录放在 `~/.latch-relay/latch-relay-<地区>`，中继文件放在 `--out` 指定处；新位置没有这个地区的部署目录时，部署命令照常使用旧目录并打印一行搬移命令，从不自动移动或删除。以东京节点为例，搬移是两条命令：

```sh
(umask 077 && mkdir -p ~/.latch/relays/ne) && mv -n ~/latch-relay-ne.json ~/.latch/relays/ne.json && mv -n ~/latch-relay-ne.json.admin-header ~/.latch/relays/ne.json.admin-header
mv -n ~/.latch-relay/latch-relay-ne ~/.latch/relays/ne/deploy && rmdir ~/.latch-relay
```

- 再次运行部署命令会换新的中继密钥、注册令牌与节点标识，旧中继文件随之失效：这也是收回某人使用权的办法，之后只把新文件交给仍要用的人。默认位置已有 `ne.json` 或 `ne.json.admin-header` 时它在部署前停下：先在 Mac 上移除旧中继并删除这两个文件，或用 `--out` 把新文件写到别处。
- 每次部署都会让经过这个节点的连接断开一次，Mac 自动重新登记，手机自动重连。删除：先在 Mac 上移除这个中继，再 `wrangler delete --name latch-relay-ne`。
- 设置里的「Cloudflare Workers」方式在源码目录运行的 Latch 里给出同样的命令。安装版的 `latch relay setup cloudflare` 尚未实现：安装包不带 Worker 部署包；在源码目录部署后仍可用「已有配置文件」添加。
- 自定义域名作为同一节点的另一个地址尚未接入部署命令。

### 在 Mac 上添加

读入中继文件后出现核对卡：方式、地址、密钥短哈希（Linux 中继是证书公钥 SHA-256 的前 8 位十六进制，Workers 中继是中继公钥 SHA-256 的前 8 位）；注册令牌只写「已包含」。选「确认并连接」后这台 Mac 弹出系统确认，窗口写明第一个地址、地址总数与同一个密钥短哈希，对照后再确认。之后一行进度：连上、密钥相符、注册、签发连接信息。Host 签好包含当前中继配置的连接簿后显示「这台 Mac 已签发」。手机收到和使用连接簿的状态需要手机端的证据。任一步失败就停在那一步，写明原因并给「重试」（原 requestId 与原 profile，不重复添加）；结果未知时关闭对话框仍在本页内存中保留原请求，展示用的密钥短哈希不进入请求体。

- 只有这台 Mac 上有 `admin` 的设备能添加、停用、移除；其他有 `admin` 的设备只看得到列表与状态。
- 每个节点只能添加一次，至多四个自己的中继。
- 地址只接受连接簿的格式：`https://` 加小写域名或 IPv6、可选端口，末尾至多一个 `/`。设置、`latch relay add` 与 Host 都按同一份规则拒绝其他写法（[relay-endpoint.ts](../packages/protocol/src/relay-endpoint.ts)）。
- Host 停止时可用 `latch relay add --data-dir <目录>`（读 `~/.latch/relays` 里唯一的中继文件；`--name <名称>` 选其中一个，`--file <中继文件>` 指定其他位置）、`relay list` 和 `relay remove <节点标识>`。源码运行使用 `pnpm latch`。添加时终端列出每个地址与密钥短哈希，核对后输入 y，非交互用 `--expect-key <密钥短哈希>`。先写审计再保存为待核对，Host 启动后节点证明密钥并接受登记，才可进入签名连接簿。Host 运行时可用 `relay test <节点标识>` 检查连通性、身份与登记，并查看 Host 签发状态。`relay setup linux` 显示服务器发布物尚未提供，Linux 源码部署流程见上文。

**Host 做什么。**

1. 先审计，再在现有出站规则下锁定解析出的地址。
2. 核对节点身份：Linux 中继是 TLS 证书、服务器名与公钥指纹；Workers 中继是 WebPKI 证书加中继密钥对挑战的签名，几个地址竞速，先通过签名检查的胜出。
3. 实际登记一条随配置保存的真实路由。
4. 只有登记成功且配置与回执都已写入，才在签名连接簿里发布。

「测试」先记 `native.relay.test` 审计（节点与配置的哈希），再登记这个中继当天专用的测试路由，不影响正在用的那条；同一天重复测试复用同一条路由，同一时间只运行一项测试，Host 停止时不再开始；审计失败时不解析地址或连接，等待期间与每次写前复核权限及所测配置。文件已替换而目录同步未知时（503 `native-relay-write-unknown`）先确认那次保存。移除与放弃都先尝试留审计，再替换配置；审计写失败时仍完成收紧；CLI 移除或关闭也容忍审计打开失败，并在终端报告审计失败。启用一个中继与添加一样，审计写不进就不做。局域网或内网的中继需要本机管理员先在出站规则里放行对应的 `host:port`。每条控制与数据连接持有其实际来源和锁定 IP 的出站许可；撤销许可后只关闭失去许可的连接。

### 手机怎样得到新中继

手机不需要做任何事。Mac 每次发连接簿都按当前设置重新签名；已配对的手机下次连上 Mac（同一网络，或经仍可用的中继）时取得新连接簿，之后在其他网络就会用到新中继。移除的中继不再出现在之后的连接簿里。只在其他网络、而且旧连接簿里没有可用中继的手机，要先回到同一网络连一次。Workers 中继需要包含这一版本的 App：之前的版本跳过连接簿里的 Workers 地址。

## Workers 的界限与验收

节点对象只按自己持有和交给 `send()` 的东西设界限，不依赖平台的关闭或积压信号（[buffers.ts](../apps/relay-edge/src/buffers.ts)）。其中只有前两条是内存上限：

- 收到后待处理的数据与前三秒填充队列是节点自己的内存：每连接 512 KiB / 512 条，每对象 8 MiB / 8192 条，超出即关闭连接。
- 未认证且有填充的连接（手机与 DATA 腿；Host 的控制连接没有填充）全对象同时最多 16 个，每个在认证前最多交给平台 512 KiB。满了不拒绝新连接，而是关闭「未认证连接最多的那个前缀」里最旧的一个：一个或几个前缀占着名额时，别的前缀的手机与 Host 仍能进来。
- 连接槽：全对象 1024 个，每个 /24 或 /48 前缀最多 64 个（开着的加上关闭后按时钟保留 5 秒的）。槽满时，槽最多的前缀先让出一个保留中的槽或最旧的未认证连接；只有新连接自己的前缀已占满份额且没有可让出的，才拒绝它。
- 每个连接交给平台的字节按速率计：1 MiB 起，每秒补 768 KiB（活跃填充网格每秒约 400 KiB），超出即关闭。这是速率，不是内存上限：一个持有通行证、停止读取的手机仍能让平台的发送缓冲按这个速率增长，除非平台在 `bufferedAmount` 报告积压且积压会回落。
- 平台报告的 `bufferedAmount` 是合法数值时只用于提前关闭：单个连接积压超过 1 MiB，或合计超过 16 MiB 时关闭最大的。它从不释放预算；探测时平台读到过这个数值，但是否随慢读者回落没有测过。
- 每个节点对象最多在内存中持有 16,384 个 DENY 标签，每条路由最多 8192 个。恢复时只读取剩余额度允许的标签，满额时拒绝登记或关闭无法完整记录 DENY 的路由。

平台本身的几件事无法在本地验证，由验收命令在真实部署上检查，或说明最坏情况：

| 行为 | 怎样处理 |
| --- | --- |
| 帧经过边缘是否完整、不分片不合并；子协议原样回显 | 已在自己的账户实测：完整（2026-11-17）；验收「前三秒填充」再查一次 |
| 节点对象落在哪里 | 已实测：`apac-ne` 在东京，`apac-se` 在新加坡 |
| 平台在 JavaScript 之前组装消息，单条最多 32 MiB（[文档](https://developers.cloudflare.com/workers/runtime-apis/websockets/)） | 设计上无法限制，而且可以反复发生：任何知道地址的人都能在未认证的 3–4 秒内送进几条接近 32 MiB 的消息（一台上行约 300 Mbit/s 的服务器即可），对象超过平台的内存上限就被重置，所有连接断开，Mac 重新登记、手机重连；对方每次对象重启后都能再来一次。会话正文不受影响。验收「超限消息」送 4 条 8 MiB 的消息并核对对象没有重置，不覆盖 32 MiB 的情况 |
| 关闭后平台何时释放连接的发送队列 | 不依赖：连接槽按时钟保留，交给平台的字节按速率计。验收「未认证连接被关闭」核对大量未认证连接都被关闭、对象没有重置、仍能登记 |
| 不读的手机：平台是否报告并回落积压 | 只有平台报告积压时节点才能按积压关闭它；否则平台缓冲按每连接速率增长到对象被重置。能这样做的只有持有通行证的已配对设备。验收「不读的手机」检查节点是否关闭它；失败表示这一界限在你的部署上不成立 |
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
