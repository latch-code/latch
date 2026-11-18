# 部署自己的 Cloudflare Workers 中继

给自己和少数人用的中继：只有持有中继文件（含注册令牌）的 Mac 能登记。机制、谁能看到什么与内存界限见 [docs/RELAY.md](../../../docs/RELAY.md#方式-b自己的-cloudflare-账户edge)。

## 顺序

在 Latch 的源码目录（已 `pnpm install`）：

```sh
wrangler login                                        # 你本人在终端完成；Free 可用，长期用 Workers Paid
pnpm latch relay setup cloudflare --name home         # 部署并验收，写出 ~/.latch/relays/home.json 与 home.json.admin-header
```

名称自己起（小写字母、数字与连字符）；`--location <位置>` 是 Cloudflare 的位置提示（如 `apac-ne`），不给时由 Cloudflare 放在离第一次请求最近的地方。验收通过后，Mac 的「设置 › 连接转发 › 添加转发服务」会列出 `home`，对照密钥短哈希后确认。添加之后可以删除 `home.json`；`home.json.admin-header` 留着，查看状态要用。部署配置在 `~/.latch/relays/home/deploy/`。`pnpm relay-edge:setup --name home` 与 `pnpm relay-edge:accept --name home` 是同一流程的两步。文件、权限与从旧位置（`~/.latch-relay`）搬移的两条命令见 [docs/RELAY.md](../../../docs/RELAY.md#方式-b自己的-cloudflare-账户edge)。

- **部署**只打印进度、`中继密钥短哈希 xxxxxxxx` 与下一步命令。秘密（中继私钥、注册令牌、管理令牌）只经 `scripts/wrangler.ts` 的调用器从标准输入写进 Workers secret：固定 wrangler 4.164.0，子进程环境净化，诊断与结构化日志写入空设备，写秘密时两个输出都丢弃。不要用其他方式手动 `wrangler secret put` 这些值。[Wrangler 环境变量](https://developers.cloudflare.com/workers/wrangler/system-environment-variables/)、[Wrangler 4.164.0 日志实现](https://github.com/cloudflare/workers-sdk/blob/wrangler%404.164.0/packages/wrangler/src/utils/log-file.ts)
- **验收**每项一行，`✓` 通过、`✗` 失败、`·` 跳过，不打印令牌或地址；有失败时退出码为 1。约一分钟，会在节点上制造未认证连接、超限消息与一个不读的连接，所以在任何 Mac 使用它之前运行。它需要旁边的 `.admin-header`（0600，你自己的文件），先用它取 `/admin/status`，得到 200 才继续：只对你自己的中继施压。它的路由按中继与日期派生，重复运行不会留下新路由；两次运行之间隔半分钟。约上传 40 MiB。
  - 健康检查：`/healthz` 返回 200。
  - 管理接口只认令牌：`/admin/status` 无令牌或错误令牌时 404，正确令牌时报告每个分片的启动时间。
  - 错误密钥与令牌被拒绝：期望另一把中继密钥的客户端在签名检查处拒绝节点；错误的注册令牌被节点拒绝。
  - 用中继文件登记：正确的密钥与令牌登记成功。
  - 前三秒填充：未认证的连接收到约三秒、每 40 ms 一批 4 KiB 的填充，帧完整，之后被关闭。
  - 未认证连接被关闭：一批从不读取、从不认证的连接 6 秒内都被拒绝或被节点关闭，节点对象没有重置（启动时间不变），之后仍能登记。
  - 超限消息（8 MiB × 4）：四条未认证的 8 MiB 消息，连接被关闭，`/healthz` 仍答 200，节点对象没有重置。通过不代表平台单条上限 32 MiB 的情况：知道地址的人仍能用接近 32 MiB 的消息反复让对象重置。
  - 不读的手机：已接合的连接停止读取、Host 持续发送时，节点关闭它且对象没有重置。失败说明平台没有报告积压：每连接发送预算只限速率，不读的已配对手机能让平台缓冲增长。
- 失败时不要添加这个中继；可再运行一次确认，或删除：`wrangler delete --name latch-relay-ne`（校验 Worker 为 `latch-relay-work`）。重新部署前删除 `~/.latch/relays/ne.json` 与 `ne.json.admin-header`，否则部署命令在动手前停下。

## 之后

- 状态：`curl -s -H @"$HOME/.latch/relays/ne.json.admin-header" https://latch-relay-ne.<子域>.workers.dev/admin/status`，令牌只在这个 0600 文件里。排空：同一头部 `-X POST …/admin/drain`。
- 再次运行部署命令会换新的密钥、令牌与节点标识，旧文件失效；只把新文件交给仍要用的人。
- 每次部署都会让经过节点的连接断开一次。Latch 不设花费上限，在 Cloudflare 为账户设账单提醒。Free 计划上，知道地址的陌生人每秒约 1.2 次升级请求就能用完当天的请求额度。
- `deploy/wrangler.jsonc` 与 `work.wrangler.jsonc` 是部署命令所用配置的参考，`pnpm build:relay-edge` 把它们与 Worker 一起放进 `dist/relay-edge/`。
