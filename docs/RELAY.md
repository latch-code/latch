---
description: 手机在其他网络连回 Mac 的中继：何时需要、官方中继、自建中继（Linux 服务器或自己的 Cloudflare 账户）、在 Mac 上添加、手机如何得到、两种类型的身份与谁能看到什么、按状态排查。
sources:
  - apps/relay/src/cli.ts
  - apps/relay/src/config.ts
  - apps/relay/deploy/compose.yaml
  - apps/relay/deploy/install.sh
  - apps/relay/deploy/upgrade.sh
  - apps/relay-edge/src/node.ts
  - apps/relay-edge/src/edge.ts
  - apps/relay-edge/deploy/wrangler.jsonc
  - apps/relay-edge/deploy/README.md
  - apps/relay-edge/scripts/profile.ts
  - packages/link-wire/src/relay-identity.ts
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

有两种来源，可以并存：**官方中继**（Latch 提供）与**自己的中继**。自己的中继又有两种运行方式：Linux 服务器（`self`）或自己的 Cloudflare 账户（`edge`）。

## 官方中继

- 运行在 Cloudflare Workers 上：东京与新加坡各一个节点，Mac 测得哪个更近，手机就先试哪个。
- **尚未部署。** Host 里的官方列表（`apps/host/src/relay/official.ts` 的 `OFFICIAL_EDGE_DEPLOYMENT`）在所有者部署并填入节点公钥前是空的；空着时没有任何 Host 使用官方中继。
- **谁能看到什么。** Cloudflare 终止外层 TLS，它和运营者都能看到：两端 IP、时间、填充后的大小与方向、路由标识、通行证字段、路由令牌与准入证明。Cloudflare 自己的边缘日志不在 Latch 控制之内；Latch 的代码不写日志、不存完整 IP（只用 /24 或 /48 前缀做公平限额），部署模板关闭日志与观测。看不到：会话正文、Host 身份、设备授权，它们都在端到端的内层。
- **关闭。** 设置 › 设备 › 关于连接 › 中继 的「官方中继」开关，或 Host 停止时 `pnpm latch relay official off --data-dir <目录>`。关闭后 Mac 不再向它登记，新的连接簿也不再含它；自己的中继照常使用。
- 手机可以同时有官方与自己的中继；「优先使用」选官方或自己的，一个选项决定先试哪边（`pnpm latch relay order official|own`）。

## 两种中继类型的身份

| | `self`（Linux 服务器） | `edge`（Cloudflare Workers） |
| --- | --- | --- |
| 外层 TLS | 运营者自己的证书，在自己的机器终止 | Cloudflare 的证书，在 Cloudflare 终止 |
| 节点身份 | 固定证书公钥（SPKI SHA-256） | 中继自己的 Ed25519 密钥：每条连接先发随机数，节点用私钥签名后才继续 |
| 准入证明 | v1，不绑定这条连接 | v2，绑定节点在这条连接上的随机数，只能用一次 |
| 地址 | 一个 | 一到四个，手机与 Mac 竞速，先通过签名检查的胜出 |

签名文本、证明文本与消息格式写在 [relay-identity.ts](../packages/link-wire/src/relay-identity.ts) 与 [pass.ts](../packages/link-wire/src/pass.ts)，共享向量在 `packages/testkit/vectors/link-v1.json`（`edgeRelay`、`addressBookV4`）。

- 一个 edge 节点可以有多个地址（`workers.dev` 与自定义域名），因为绑定连接与节点的是签名，不是主机名：一个地址答出别的密钥，只会在竞速中输掉。
- edge 的签名不绑定 TLS 会话：能为这个域名终止 TLS 的一方可以把它实时转发。它保证节点的密钥参与了这条连接，并让每个准入证明只能用一次；再在 WebSocket 里加一层对节点密钥的加密尚未实现。
- self 保持 v1 证明：已部署的自建节点与旧手机只认 v1，客户端也分不出升级过的节点，绑定需要一次不存在的协商。

## 自己的中继

### 方式 A：Linux 服务器（self）

在公网 Linux 上运行 Latch Relay。

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

### 方式 B：自己的 Cloudflare 账户（edge）

把官方中继用的同一份 Workers 模板部署到自己的账户。完整步骤见 [apps/relay-edge/deploy/README.md](../apps/relay-edge/deploy/README.md)，要点：

1. **前提。** Cloudflare 账户与 Workers Paid 计划；自己终端里的 wrangler（`npx wrangler`，不装进本仓库）；本仓库 `pnpm install`。
2. **构建。** `pnpm build:relay-edge`，之后在 `dist/relay-edge/` 里运行 wrangler。一个节点即可（例如只部署 `--env ne`）。
3. **中继密钥。** `pnpm --silent relay-edge:keygen | npx wrangler secret put RELAY_SIGNING_SEED --env ne`：私钥经管道进 secret，屏幕上只有公钥与一个新节点标识。
4. **变量。** 在 `wrangler.jsonc` 填 `NODE_HOSTS`（`latch-relay-ne.<子域>.workers.dev`）、`RELAY_ID`；`OPEN_REGISTRATION` 保持 `false`。没有花费上限，在 Cloudflare 设账单提醒。
5. **中继文件与注册令牌。** 自己的中继默认只让持有中继文件的 Host 登记：
   ```sh
   pnpm --silent relay-edge:profile --relay-id <relayId> --relay-key <relayKey> \
     --url https://latch-relay-ne.<子域>.workers.dev/ --output /absolute/path/latch-relay.json \
     | npx wrangler secret put REGISTRATION_TOKEN --env ne
   ```
   文件（版本 2，0600，新文件）含节点标识、所有地址、中继公钥与注册令牌；同一个令牌经管道进 secret，不出现在屏幕上。要让任何 Host 都能登记才加 `--open`（并把 `OPEN_REGISTRATION` 设为 `true`）：开放登记意味着别人的 Host 也能占用你的节点与额度，所以不是默认。既没有令牌也没有明确开放时，节点拒绝服务。
6. **管理令牌与部署。** 见部署说明的第 4、5 步；`/healthz` 返回 200 即可。
7. **更新。** 每次部署都会让经过这个节点的所有连接断开一次（约 300 秒内），Mac 自动重新登记，手机自动重连。少部署，选使用少的时候。
8. **删除。** 先在 Mac 上移除这个中继，再 `npx wrangler delete --env ne`。

### 在 Mac 上添加

桌面端「设置 › 设备 › 关于连接」的中继一节选「添加自己的中继」，选中继文件（两种类型都可以），核对地址后选「验证并添加」，再在这台 Mac 的系统窗口确认。系统窗口写明第一个地址、地址总数与密钥短哈希（edge 是中继公钥 SHA-256 的前 8 位十六进制，self 是证书公钥 SHA-256 的前 8 位），与页面上的卡片对照后再确认；页面卡片另列每个地址、节点标识与完整公钥。注册令牌只交给 Host，不显示。

- 只能由这台 Mac 上有 `admin` 的设备添加、移除、开关与排序；其他有 `admin` 的设备只看得到状态。
- 每个节点只能添加一次，至多四个自己的中继。连接簿最多放四个中继：官方在前时是两个官方节点加前两个自己的。
- 命令行（Host 已停止）：`pnpm latch relay add --file <中继文件> --data-dir <目录>`，终端列出每个地址与密钥短哈希，核对后输入 y（非交互用 `--expect-key <密钥短哈希>`）；`relay list`、`relay remove <节点标识>`、`relay official on|off`、`relay order official|own`。命令行添加的中继先标为待核对，Host 启动后节点证明了自己的密钥并接受登记，才进入发给手机的连接簿。

**Host 做什么。**

1. 先审计，再在现有出站规则下锁定解析出的地址。
2. 核对节点身份：self 是 TLS 证书、服务器名与公钥指纹；edge 是 WebPKI 证书加中继密钥对挑战的签名。
3. 实际登记一条随配置保存的真实路由。
4. 只有登记成功且配置与回执都已写入，才在签名连接簿里发布。

网络或写入失败后页面继续同一个待确认请求，重试复用原路由种子；文件已替换而目录同步未知时（503 `native-relay-write-unknown`）先确认那次保存。放弃会阻止未完成的请求发布。移除与放弃都先尝试留审计，再替换配置；审计写失败时仍完成收紧，响应标明审计失败。局域网或内网的中继需要本机管理员先在出站规则里放行对应的 `host:port`。

### 手机怎样得到新中继

手机不需要做任何事（只要 App 支持连接簿 v4：含 edge 中继的连接簿，旧版本的 App 读不了，需要先更新 App）。Mac 每次发连接簿都按当前设置重新签名；已配对的手机下次连上 Mac（同一网络，或经仍可用的中继）时取得新连接簿，之后在其他网络就会用到新中继。移除的中继不再出现在之后的连接簿里。只在其他网络、而且旧连接簿里没有可用中继的手机，要先回到同一网络连一次。

## 未实测，按文档与保守值

edge 节点上下列行为没有经过实际测量，取保守值，都是可调的常量或配置：

| 假设 | 取值与位置 |
| --- | --- |
| 边缘可能在约 100 秒空闲后关闭 WebSocket | 未接合的连接每 20 秒发应用层 PING，节点回 PONG；节点关闭 75 秒无消息的连接，客户端 60 秒（`EDGE_RELAY`，link-wire） |
| 单个节点对象的容量（文档软上限约每秒 1,000 个请求） | 每对象最多 40 对已接合的连接，满了以 4302 拒绝新的手机连接；分片字段已在格式里，扩容靠加分片，部署用 1 个（`LIMITS.maxPairs`、`SHARDS`） |
| 连接可能随时被切断 | Mac 退避重连并重新登记，手机退避重连并显示「重新连接」，不报错 |
| 部署后约 300 秒内重置节点对象 | 每次部署都让经过它的所有连接断开一次；分节点部署，先排空 |
| 发送端没有背压（平台无 `bufferedAmount`，已实测） | 每连接接收队列字节上限；节点发出的前三秒填充与自建中继同样的队列与帧上限；每连接每秒发出字节上限，跟不上的读者被断开而不是替它缓存 |

已实测：经边缘的帧完整、不分片不合并；带 `apac-ne` 与 `apac-se` 提示的对象分别落在东京与新加坡。

## 按状态排查

| 状态 | 含义 | 怎么办 |
| --- | --- | --- |
| 尚未部署 | 这个版本的官方列表为空 | 用自己的中继 |
| 正在连接 | Mac 正在连接或登记 | 等几秒 |
| 已连接 | Mac 已在节点登记，手机可经它连接 | — |
| 无法连接 | 连不上节点或连接中断，Mac 在退避重试 | 检查地址、DNS、出站规则；`/healthz`、`/admin/status` |
| 登记被拒绝 | 节点拒绝了这台 Mac：注册令牌不对或缺失、节点已满 | 重新导出中继文件后先移除再添加；查看节点状态 |
| 需要检查 | 同一天两次报告路由冲突 | 在 Mac 上移除后重新添加 |
| 已关闭 | 官方中继被关掉 | 需要时打开 |

公开的 `/healthz` 只说明 Worker 已配置（edge）或节点接受连接（self）；edge 节点是否可用看 `/admin/status`。完整的验证要用手机在另一个网络实际连接、重连与撤销。
