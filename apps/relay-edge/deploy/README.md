# 部署 edge 中继（Cloudflare Workers）

在自己的 Cloudflare 账户上运行自己的中继，给自己与少数人的 Mac 使用。下面写给「中继运营者」。主路径是注册令牌：只有持有你生成的中继文件的 Mac 能登记；开放登记见文末，不建议。

机制、谁能看到什么、未实测的假设见 [docs/RELAY.md](../../../docs/RELAY.md)。

## 结构

- 每个地区节点是一个独立的 Worker：`latch-relay-ne`（东京，`apac-ne`）与 `latch-relay-se`（新加坡，`apac-se`）。自己的中继通常一个节点就够（只做 `ne` 或只做 `se`）。
- 另有一个没有公网地址的校验 Worker `latch-relay-work`，只经服务绑定计算注册挑战。
- 节点地址：`https://latch-relay-ne.<子域>.workers.dev/`。地址只是地址：手机与 Mac 认节点靠它的中继公钥签名，所以以后可以再加自定义域名作为同一节点的另一个地址。
- 为什么一个节点一个 Worker：部署会重置这个 Worker 的全部节点对象。分开以后可以先排空、部署一个节点，确认健康后再做另一个，其间手机与 Mac 走另一个节点。

## 前提

- Cloudflare 账户与 Workers Paid 计划（Durable Objects 与用量）。
- 在自己的终端用自己的 wrangler（例如 `npx wrangler`，不装进本仓库）；`npx wrangler login` 由你本人完成。
- 本仓库已 `pnpm install`。

## 1. 构建

```sh
pnpm build:relay-edge
cd dist/relay-edge        # worker.js、work.js、wrangler.jsonc、work.wrangler.jsonc；之后的 wrangler 命令都在这里运行
```

## 2. 第一次部署（还没有密钥，节点答 503）

```sh
npx wrangler deploy -c work.wrangler.jsonc     # 校验 Worker
npx wrangler deploy --env ne                   # 输出里有 https://latch-relay-ne.<子域>.workers.dev
```

没有密钥与登记方式时节点一律拒绝服务，部署后暴露在外也没有风险。

## 3. 中继密钥

每个节点一把。私钥经管道直接交给 `wrangler secret put`，不落盘、不出现在屏幕或命令行参数里；命令在标准错误打印公钥 `relayKey` 与一个新的节点标识 `relayId`（都是公开数据，记下来）。标准输出是终端时命令拒绝运行。

```sh
pnpm --silent relay-edge:keygen | npx wrangler secret put RELAY_SIGNING_SEED --env ne
```

## 4. 填写变量

编辑 `dist/relay-edge/wrangler.jsonc`（模板在 `apps/relay-edge/deploy/`）：

- `NODE_HOSTS`：把 `<子域>` 换成第 2 步输出里的子域。以后加自定义域名时，取消注释 `routes` 并把那个主机名用逗号加进来。
- `RELAY_ID`：第 3 步的 `relayId`。
- 节点没有花费上限：在 Cloudflare 为账户设一个账单提醒，那就是你的上限。一台一直连着的设备每秒让节点收约 8 条消息（两边各 4 个填充单元），一天约 69.1 万条（平台按 20 条计 1 次请求）。
- `SHARDS` 保持 `1`。

## 5. 谁能登记

只有持有中继文件的 Mac 能登记。 `OPEN_REGISTRATION` 保持 `"false"`，生成中继文件，同一个注册令牌经管道进 secret：

```sh
pnpm --silent relay-edge:profile --relay-id <relayId> --relay-key <relayKey> \
  --url https://latch-relay-ne.<子域>.workers.dev/ --output /absolute/path/latch-relay.json \
  | npx wrangler secret put REGISTRATION_TOKEN --env ne
```

文件是新建的 0600 文件，含节点标识、所有地址（多个就重复 `--url`）、中继公钥与注册令牌；令牌不会显示。把文件私下带到你的 Mac（不上传到公开链接、不提交）。

## 6. 管理令牌

状态与排空接口要一个不少于 32 字符的令牌，也只作为 secret：

```sh
(umask 077; openssl rand -hex 32 | tr -d '\n' > ~/.latch-relay-admin)
npx wrangler secret put ADMIN_TOKEN --env ne < ~/.latch-relay-admin
(umask 077; printf 'Authorization: Bearer %s\n' "$(cat ~/.latch-relay-admin)" > ~/.latch-relay-admin.header)
```

之后的管理请求用 `curl -H @~/.latch-relay-admin.header`：令牌只在这个 0600 文件里，不进命令行参数（`ps` 看得到参数）。

## 7. 再部署一次（变量生效）并验证

```sh
npx wrangler deploy --env ne
curl -s -o /dev/null -w '%{http_code}\n' https://latch-relay-ne.<子域>.workers.dev/healthz     # 200
curl -s -H @"$HOME/.latch-relay-admin.header" https://latch-relay-ne.<子域>.workers.dev/admin/status
```

`healthz` 只说明这个 Worker 已配置（200）或未配置（503），不经过节点对象，不计费、不占预算。`admin/status` 给出每个分片是否可用、路由数、连接数、接合数与花费计数，不含 IP 或秘密；令牌不对时一律 404。模板关闭了 observability、日志与 Logpush，代码不输出日志；Cloudflare 自己的边缘日志不在控制之内。

## 8. 交给 Mac

- **自己的中继**：桌面端「设置 › 设备 › 关于连接」选「添加自己的中继」，选第 5 步的文件，核对地址与中继公钥，在 Mac 的系统窗口确认。或在 Host 停止时 `pnpm latch relay add --file /absolute/path/latch-relay.json --data-dir <数据目录>`。之后用手机在另一个网络（例如关掉 Wi‑Fi 用蜂窝网络）打开 Latch 验证。
- 给别人用：每人一个中继文件，私下交给对方，各自在自己的 Mac 上添加。所有文件共用同一个注册令牌；要收回某人的使用权，换令牌（见下）并把新文件只发给仍要用的人。

## 部署对现有连接的影响

- 节点对象不休眠。按平台文档，部署后约 300 秒内对象会被重置：经这个节点的所有连接都会断开一次，内存里的路由清空。把每次部署都当作「所有人断开一次」。
- Mac 几秒内重新登记；手机自动重连，界面短暂显示「重新连接」。会话状态都在 Mac 上，不丢失；写入请求按原 `requestId` 保持「结果未知」直到 Host 给出结果。
- 所以：少部署，选使用少的时间；多个节点分开做。

## 排空、回退与删除

部署某个节点前先排空它：已登记的 Mac 收到 GOAWAY 改走别的节点，新连接被拒绝。

```sh
curl -s -X POST -H @"$HOME/.latch-relay-admin.header" https://latch-relay-ne.<子域>.workers.dev/admin/drain
npx wrangler deploy --env ne
curl -s -o /dev/null -w '%{http_code}\n' https://latch-relay-ne.<子域>.workers.dev/healthz
```

部署会重置节点对象，排空状态随之结束。回退：`npx wrangler rollback --env ne`（或在控制台选上一个版本），同样断开一次。删除：先在 Mac 上移除这个中继，再 `npx wrangler delete --env ne`；`OBJECT_EPOCH` 改动后旧对象不再被使用，空闲时不会自己保持运行。

## 轮换密钥与令牌

- **中继密钥**：新私钥 `secret put` 后旧公钥立即失效：重新生成中继文件，在每台 Mac 上移除后再添加。
- **注册令牌**：重新运行第 5 步生成新文件与新 secret，在 Mac 上移除后用新文件添加。

## 开放登记（不建议）

把 `OPEN_REGISTRATION` 设为 `"true"` 且不设 `REGISTRATION_TOKEN`，任何 Host 都能登记，中继文件用 `relay-edge:profile --open` 生成。节点没有花费上限，也没有对每个用户公平的预算与接合数限制：一个滥用者就能用完你的额度或占满节点。对公众开放前需要先有这些，见 docs/RELAY.md「尚未实现」。
