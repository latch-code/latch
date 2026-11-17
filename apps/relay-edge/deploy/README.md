# 部署官方中继（edge）

两个地区节点：东京 `ne`（`apac-ne`）与新加坡 `se`（`apac-se`），各是一个独立的 Worker（`latch-relay-ne`、`latch-relay-se`），另有一个没有公网地址的校验 Worker `latch-relay-work`。节点在 `workers.dev` 上的地址是 `https://latch-relay-ne.<子域>.workers.dev/` 与 `https://latch-relay-se.<子域>.workers.dev/`。

为什么一个节点一个 Worker：部署会重置这个 Worker 的全部节点对象。分开以后可以先排空、部署一个节点，确认健康后再做另一个，手机与 Mac 在此期间走另一个节点。

机制、谁能看到什么、未实测的假设见 [docs/RELAY.md](../../../docs/RELAY.md)。

## 前提

- Cloudflare 账户与 Workers Paid 计划（Durable Objects 与每月用量）。
- 在自己的终端用自己的 wrangler（例如 `npx wrangler`，不装进本仓库）；`npx wrangler login` 由你本人完成。
- 本仓库已 `pnpm install`。

## 1. 构建

```sh
pnpm build:relay-edge
cd dist/relay-edge        # worker.js、work.js、wrangler.jsonc、work.wrangler.jsonc；下面的命令都在这里运行
```

## 2. 生成每个节点的中继密钥

每个节点一把。私钥经管道直接交给 `wrangler secret put`，不落盘、不出现在屏幕或命令行参数里；命令只在标准错误打印公钥与一个新的节点标识。标准输出是终端时命令拒绝运行。

```sh
pnpm --silent relay-edge:keygen | npx wrangler secret put RELAY_SIGNING_SEED --env ne
pnpm --silent relay-edge:keygen | npx wrangler secret put RELAY_SIGNING_SEED --env se
```

记下每次打印的 `relayKey`（公钥）与 `relayId`（节点标识），二者都是公开数据。

## 3. 填写变量

编辑 `dist/relay-edge/wrangler.jsonc`（模板在 `apps/relay-edge/deploy/`）：

- `NODE_HOSTS`：把 `<子域>` 换成账户的 workers.dev 子域。以后加自定义域名时，取消注释 `routes` 并把那个主机名用逗号加进 `NODE_HOSTS`。
- `RELAY_ID`：上一步的 `relayId`。
- `DAILY_MESSAGES`、`MONTHLY_MESSAGES`：每个节点收到的 WebSocket 消息上限（平台按 20 条计 1 次请求）。超出后节点拒绝新连接并断开已接合的连接（协议码 4304），到下一个 UTC 日或月恢复。
- `SHARDS` 保持 `1`。

## 4. 管理令牌

管理接口（状态与排空）要一个不少于 32 字符的令牌，也只作为 secret：

```sh
(umask 077; openssl rand -hex 32 | tr -d '\n' > ~/.latch-relay-admin)
npx wrangler secret put ADMIN_TOKEN --env ne < ~/.latch-relay-admin
npx wrangler secret put ADMIN_TOKEN --env se < ~/.latch-relay-admin
```

令牌文件留在本机、权限 0600，用于下面的管理命令。

## 5. 部署

```sh
npx wrangler deploy -c work.wrangler.jsonc     # 先部署校验 Worker
npx wrangler deploy --env ne
npx wrangler deploy --env se
```

模板关闭了 observability、日志与 Logpush；代码不输出日志。Cloudflare 自己的边缘日志不在我们控制之内。

## 6. 验证

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://latch-relay-ne.<子域>.workers.dev/healthz     # 200
curl -s -H "Authorization: Bearer $(cat ~/.latch-relay-admin)" https://latch-relay-ne.<子域>.workers.dev/admin/status
```

`healthz` 只答 200 或 503。`admin/status` 给出路由数、连接数、接合数与花费计数，不含 IP 或秘密。令牌不对时一律 404。

## 7. 把公钥填进 Host

在 `apps/host/src/relay/official.ts` 的 `OFFICIAL_EDGE_DEPLOYMENT` 填入两个节点：`relayId`、`relayKey`、地区与地址（workers.dev 地址在前）。它为空时 Host 不使用官方中继。提交、构建并重启 Host 后，已配对的手机在下次取得连接簿时得到新的中继。

## 部署对现有连接的影响

- 节点对象不休眠。按平台文档，部署后约 300 秒内对象会被重置：经这个节点的所有连接都会断开一次，内存里的路由清空。
- Mac 会在几秒内重新登记；手机自动重连，界面短暂显示「重新连接」，会话状态都在 Mac 上，不丢失。写入请求按原 `requestId` 保持「结果未知」直到 Host 给出结果。
- 所以：不要频繁部署，选在使用少的时间；两个节点分开做。

## 排空与回退

部署某个节点前先排空它，已登记的 Mac 收到 GOAWAY 并改走另一个节点，新连接被拒绝：

```sh
curl -s -X POST -H "Authorization: Bearer $(cat ~/.latch-relay-admin)" https://latch-relay-ne.<子域>.workers.dev/admin/drain
npx wrangler deploy --env ne
curl -s -o /dev/null -w '%{http_code}\n' https://latch-relay-ne.<子域>.workers.dev/healthz
```

部署会重置节点对象，排空状态随之结束。回退：`npx wrangler rollback --env ne`（或在控制台选上一个版本），同样会断开一次连接。

## 轮换中继密钥

重新生成并 `secret put` 新私钥后，旧公钥立刻失效：先在 Host 的 `OFFICIAL_EDGE_DEPLOYMENT` 换上新公钥、发布 Host，再换节点的私钥。两步之间这个节点不可用，手机走另一个节点。
