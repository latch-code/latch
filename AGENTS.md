# AGENTS.md

Latch 是跨电脑与手机的 AI Agent 工作台。Node Host（`apps/host`）持有会话、执行权限、密钥、设备登记与审计。Electron 经 `host.sock`、浏览器经回环、手机经运营者证书的 HTTPS 接入同一 Host（HTTP + SSE）。会话组合 Harness（内置 `standard` 或 ACP 本机 Agent）、模型与项目目录。Provider、Tool、HarnessDriver 经 Cordis 注册。拿不准则拒绝。

## 开始之前

1. 先 `git status`，保留未提交改动。
2. 编辑前读当前及上层目录的 `AGENTS.md` 和「改动前先读」的对应文档。以源码与测试为准。
3. 遵守「本机运行安全」，不碰用户 Host 与数据。

## 代码地图

| 路径 | 职责 |
| --- | --- |
| `apps/host/` | Host 组合根、插件与命令 |
| `apps/web/` | 浏览器与桌面共用页面，构建到 `dist/web` |
| `apps/desktop/` | `@latch/desktop`：Electron 主进程与 preload（CommonJS） |
| `packages/link-wire/`、`packages/link-client/`、`apps/relay/` | 原生连接：编码与 KDF、TLS 与 Go、盲中继 |
| `packages/protocol/` | 共用 DTO、预设与安全文本 |
| `packages/ui/` | `@latch/ui`：令牌、层叠层与原语 |
| `packages/sdk/` | `@latch/sdk`：插件作者面与 `AppError` |
| `packages/app-sdk/` | 插件页面框内的桥与运行时 |
| `packages/core/` | Cordis、执行循环、快照与 Node 工具 `./node-kit` |
| `packages/harness-acp/` | ACP 驱动与权限预设 |
| `packages/testkit/` | Host、确认后端、安全向量与假 ACP 测试夹具 |
| `e2e/` | `@latch/e2e`：全部 `*.e2e.ts`（Playwright） |
| `tests/` | 根项目的用例：`@latch/core`、`@latch/sdk`、兼容入口与仓库脚本 |
| `src/` | `latch/plugin-sdk`、`latch/harness-sdk`，再导出 `@latch/sdk` |
| `scripts/` | 仓库工具：检查、文档与技能、安全扫描、依赖边界、供应链、工作流 |
| `native/` | macOS 本机确认与目录组件；`ios/` 含独立 Swift 核心、iPhone/iPad App 与互操作夹具 |
| `docs/`、`examples/` | 机制文档；插件示例 |
| `tsconfig.*.json`、`.oxlintrc.json`、`.oxfmtrc.json`、`knip.json`、`lefthook.yml` | 类型检查的各运行环境、lint、格式、依赖检查、Git 钩子 |

依赖只向下：`apps/host` → `harness-acp` → `core` → `sdk` → `protocol`；`apps/web` 运行时只用 `protocol`、`ui` 与 `app-sdk`，`apps/desktop` 只用 `protocol`；`testkit` 与 `e2e` 只能写在 devDependencies。矩阵在 `scripts/boundaries.ts` 的 `PROJECTS`，由 `check:boundaries`、`knip` 与 `lint` 执行；违规在边界修，不加例外。

## 命令

需要 Node.js 24.22.1（`.node-version`；`engines` 拒收缺修复的版本）与 pnpm 11.28.6（`packageManager` 固定版本），构建原生组件需要 Go 1.26.10（`.go-version`）。

```sh
pnpm install
pnpm check:quick                 # fmt:check、lint、typecheck、check:boundaries、check:agents
pnpm check                       # check:quick 加 knip 与 test，逐项汇报
pnpm check -- --plan             # 按改动列出该跑的检查；--base <ref> 指定比较的提交
pnpm exec vitest run --config vitest.config.ts <目录>/<name>.test.ts
pnpm build                       # 含 host、web 与 presence；e2e 用 dist/web
LATCH_BROWSER_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' pnpm test:e2e
LATCH_ELECTRON_E2E=1 pnpm exec vitest run --config e2e/vitest.config.ts e2e/desktop.e2e.ts
                                 # 仅 macOS，先 pnpm build；用例不碰钥匙串与桌面端数据
pnpm latch --help                # 列出子命令；都加 --data-dir <临时目录>
pnpm start:demo -- --port 0 --data-dir <临时数据目录> --workspace <临时工作区>
pnpm stop -- --data-dir <同一数据目录>
LATCH_DATA_DIR=<临时目录> pnpm dev:web  # 仅开发；打开 Vite 打印的 /link/ 地址
```

每个克隆运行一次 `pnpm exec lefthook install` 与 `git config blame.ignoreRevsFile .git-blame-ignore-revs`；Git 已设置 `core.hooksPath` 时不加 `--force` 或 `--reset-hooks-path`，见 [docs/TESTING.md](docs/TESTING.md#git-钩子)。

## 不变量（违反即缺陷）

项目专用的不变量见该项目的 `AGENTS.md`。

**会话与界面**

- Host 是会话状态的唯一权威；网络连接、任务执行与客户端阅读位置分别建模。
- 我的 Agent 与通用由 Host 持久确定一条聊天；首条消息可重试，历史会话和定时运行保留。见 [CUSTOM-AGENTS](docs/CUSTOM-AGENTS.md#唯一聊天)。
- 取消须等执行端真实结算后才确认；写请求超时保持「结果未知」并复用原 `requestId`，只由 Host 的证据或人放弃结束，审批与取消回执随会话持久化。
- 流式消息在完成、失败、取消时沿用同一 ID；切换会话、重连与迟到响应不得回滚新状态或重复追加历史。
- 真实 Provider 失败必须报错，不得回退到演示模型；演示模式须显式启用并在界面标注。
- 会话与审批 ID 全局唯一；新增持久化字段必须加入对应 zod schema：多数 schema 丢弃未知字段，`policy.json`、设备与登记文件、审计 detail 的 schema 是 strict，拒绝未知字段。
- 插件与 ACP Agent 是可信本机代码；应用层审批、路径检查与出站策略不是 OS 沙箱，文档与界面不得暗示隔离。
- [兼容标识](docs/ARCHITECTURE.md#兼容标识)改名须附带迁移：旧包名 `harness-link` 与浏览器旧键仍可用；`/link/`、旧 `.runtime`、`openai-compatible` 不改；Cookie `harness_link` 只识别需重新确认的浏览器；旧助手会话只读，数据与审计保留。

**安全**

- **秘密不外泄。** 设备凭据、邀请码、离线连接码、模型密钥、MCP 秘密值与令牌不进标准输出、日志、环境变量、命令行参数、URL、SSE、错误信息、Git 或截图。URL 里的邀请码只在配对链接的 `#pair=` 片段，页面读后即从地址栏移除；`pnpm latch` 只把邀请与离线码显示在交互终端，或写入新建的 0600 `--code-file`。Host 每行日志经 `redactKnownSecrets`，新增秘密格式时补充模式。网关凭据 `lmg1.`、`lbt1.` 只给所属 Agent 进程，不进参数、URL、日志与 SSE。
- **磁盘上只存哈希。** 凭据与离线连接码只保存 SHA-256；邀请只在内存、只存哈希。模型密钥与 MCP 秘密值只在数据目录的 0600 文件中，不返回设备；`LATCH_API_KEY` 只在内存使用。
- **本机确认只经 `PresenceService`。** 测试确认后端（`@latch/testkit`）只经 `startServer({ presence })` 注入。只有测试（`tests/`、`e2e/` 与各项目的 `test/`）导入 testkit 与测试目录的文件，其他用法由 `pnpm check:boundaries`、`pnpm lint` 与 Host 构建拒绝；构建后 `grep -rnE 'createTestPresence|startHostFixture|latch-test\.localhost|(tests?|e2e)/(helpers|fixtures)|packages/testkit|@latch/testkit' dist/` 必须为空。
- **信任在连接时建立一次。** 设备凭 scope 工作：开始会话、放宽模式、批准 R2、预设模型地址与 Harness 命令（预设表原样命令与参数、无变量、在 PATH、未另绑）不弹确认，只留审计；审批是看管程度，不是边界。`PRESENCE_ACTIONS` 只留新设备与扩权、自填模型或出站地址、插件代码与页面能力变宽、新增或放宽 MCP 与其他 Harness 命令；只由 `host.sock` 发起（`isLocalListener`，登记例外），L3 运行或等待时全部拒绝。
- **Host 不运行仓库里的程序，交付除外。** Host 的 Git 都经受限运行器（钩子含配置钩子、filter、传输全关）；只有人按下的提交、推送与有 filter 的暂存以你的账户运行 Git：先审计并复查权限，远端只取仓库配置，不强制推送（[文档](docs/GIT-DELIVERY.md)）。
- **插件页面只凭已批准的能力行事。** 只在不透明隔离框运行、不拿凭据，草稿只经 Host 固定工具在沙箱构建；Host 按已应用清单核对每次页面调用（`via`）；页面会话只用项目默认权限、无私有上下文，人放宽后页面不能继续（[文档](docs/APP-PAGES.md)）。
- **自定义是数据。** 只写允许的令牌，安全界面不可改（[文档](docs/CUSTOMIZATION.md)）。
- **CLI 存储与凭据。** Latch 不读写；外部会话只经 ACP 适配器，一律私有，删除或清空从不删原会话。仅两处例外，Host 只读：为额度读 dsh 预设的 DeepSeek 密钥，只在内存、不刷新，只发官方地址（[文档](docs/HARNESSES.md#额度)）；为不报 tokens 的预设（非 Claude）按 ID 读 Latch 所启会话日志的 tokens 数，不列目录（[文档](docs/HARNESSES.md#deepseek-harness-的会话日志)）。
- **其他电脑互不相通。** 桌面端经各自来源与分区，凭据按来源选取，绑定证书与身份（[文档](docs/ARCHITECTURE.md#桌面端与其他电脑)）。
- **Host 与 `pnpm latch` 不响应 SIGUSR1。** 启动 Host 的脚本、桌面端与 `pnpm latch` 都带 `--disable-sigusr1`，否则同用户进程能用 `process._debugProcess` 让持有秘密的进程打开调试端口；新增启动 Host 或处理秘密的入口同样加上。
- **依赖供应链。** 依赖以精确版本写在 `pnpm-workspace.yaml` 的 `catalog`，`package.json` 只写 `catalog:`；新版本须发布满 7 天。放宽 `pnpm-workspace.yaml` 的供应链设置、新增例外（[格式](docs/TESTING.md#供应链金丝雀)）或 `allowBuilds` 条目都要所有者同意；改依赖、`pnpm-workspace.yaml` 或 `packageManager` 后跑 `pnpm check:supply`。
- **共享安全编码。** 改 base32、指纹、`canonicalJson`、确认预览与 previewHash、`hashDisplay`、`escapeSecurityText` 或签名文本时，同时更新 `packages/testkit/vectors/security-v1.json`、`native/macos/LatchPresence.swift` 与各处实现（`apps/host/src/crypto.ts`、`auth.ts`（签名文本）、`presence*.ts`（确认预览）、`packages/core/src/node-kit/digest.ts`、`packages/protocol/src/text.ts`、`apps/web/src/core/deviceKey.ts`、`contentHash.ts`、`apps/desktop/src/credentials.cjs`），再 `pnpm build:presence` 并运行 `presence.test.ts`（自检用例对旧组件失败）。

## 本机运行安全

- 不停止、重启或向已运行的 Host 发信号，不读取、修改或删除 `.runtime*/`。
- 每个命令显式指定临时目录：`pnpm start` / `start:demo` 带 `--data-dir`、`--workspace` 与 `--port 0`；`pnpm latch`、`pnpm stop` 带同一个 `--data-dir`；`pnpm dev:web` 用 `LATCH_DATA_DIR`。省略时落到用户数据：当前目录的旧 `.runtime/`、平台默认数据目录（macOS 为 `~/Library/Application Support/Latch/Host`）、`~/Latch/workspace` 与端口 4317。
- 只停自己启动的节点：`pnpm stop -- --data-dir <目录>` 经 `host.sock` 核对后才发 SIGTERM，有运行中或待审批的会话时拒绝（`--force` 仍停止）。不删其他节点的 `host.lock` 与 `.host-lock-*`（[文档](docs/ARCHITECTURE.md#hostjson-与数据目录锁)）。
- 不运行 `git clean -x`、`git clean -X` 与 `git stash -a`：被忽略的目录里有用户数据，后者还会把它们写进对象库。
- 审阅外部 PR 时，在独立 worktree 检出，每个 git 命令都带 `-c core.hooksPath=/dev/null`，因为已装的钩子执行检出的 `lefthook.yml`。该目录里不运行 `pnpm install`、任何 `pnpm` 脚本、测试、构建或 Agent：PR 能改包脚本、依赖、安装策略、构建测试配置和 Agent 指令，运行任一项都执行 PR 作者的代码。改这类文件的 PR 由所有者审阅（`.github/CODEOWNERS`）。
- 测试与调试只用临时目录、端口 0、本地假模型服务与假 ACP Agent。不调付费模型，不向真实 Agent CLI 发提示。不运行 `pnpm desktop`（它用系统钥匙串与默认桌面端数据），桌面端用 Electron e2e 验证。
- `pnpm build` 会更新 `dist/web`，运行中的旧 Host 直接给新页面。上线前不为旧 Host 写降级：Host 字段变了要重启 Host 并告知用户。改 `LatchPresence.swift` 后构建会换确认组件签名，运行中 Host 的本机确认失效：告知用户停止 Host 后运行 `pnpm latch presence repin`。

## 改动前先读

| 改动 | 文档 |
| --- | --- |
| 模块边界、Harness 路由、持久化、HTTP API、路径与项目目录 | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| 终端 | [docs/TERMINAL.md](docs/TERMINAL.md) |
| ACP Agent 接入、项目配置、权限模式读回、取消与恢复 | [docs/HARNESSES.md](docs/HARNESSES.md) |
| SSE、fetch 事件流、重连、消息身份、审批顺序、取消、阅读位置 | [docs/STREAMING.md](docs/STREAMING.md) |
| Provider、Tool（风险分级）、插件生命周期、HarnessDriver | [docs/PLUGIN-DEVELOPMENT.md](docs/PLUGIN-DEVELOPMENT.md) |
| 布局、配色、图标、组件与交互，设备与权限界面 | [docs/DESIGN.md](docs/DESIGN.md) |
| 选择测试范围、编写测试、测试 Host 与共享向量、仓库检查 | [docs/TESTING.md](docs/TESTING.md) |
| MCP 服务器与 `latch-mcp` | [docs/MCP.md](docs/MCP.md) |
| 用户可见的启动参数、手机接入、`pnpm latch` 命令 | [README.md](README.md) |

## 产品规则

- 蓝白为主，主色只给执行与勾选，琥珀只表示警告与等你处理，红色只表示真实风险或失败，都配文字；令牌只在 `packages/ui/src/tokens.css`；应用图标不改图形（[DESIGN](docs/DESIGN.md)）。
- 模型密钥只在这台 Mac 填写，不返回任何设备；其他事设备凭 scope 都能做。Latch 不替人预选宽松档位。
- Harness 只收录开源或厂商官方命令，记录许可，不下载修改程序。接入不改原 CLI 配置或注册全局 hooks；覆盖只经请求、进程或 Latch 私有配置。登录只给原生命令，Claude 除外。
- 界面与文档只展示真实功能、集成与隔离能力。缺失的写明「尚未实现」及原因。

## 完成标准

1. 先 `pnpm build` 再 `pnpm check`，都通过（确认组件自检需先构建）；构建后 `dist/` 无测试代码。
2. 按 `pnpm check -- --plan` 和 `latch-verify` 跑并汇报 e2e、Electron、`check:supply` 与[定向安全用例](docs/TESTING.md#按改动选择回归)。
3. UI 在手机、平板、桌面宽度检查真实渲染，覆盖正常、进行中、失败或等待与深色（`e2e/design.e2e.ts`、`e2e/visual.e2e.ts`）。夹具、测试确认和演示模型无法替代真实模型、Touch ID 或真机验证。系统确认只由本人用 `pnpm latch presence test` 检查。
4. 行为变化时运行 `pnpm docs:affected`，更新对应 `docs/` 机制文档与 `AGENTS.md`。
5. 汇报时区分已执行与未执行的检查。

## 约定

- 测试只用 Vitest（Playwright 仅作驱动）；为新行为添加聚焦用例；不为配置、清单或文档的字面内容写测试。
- 代码风格：严格 TypeScript，边界处用 zod 校验，错误用 `AppError(status, code, 中文消息)`；标识符与注释用英文，注释只写不显而易见的原因。只用作类型的导入写 `import type`。格式以 `pnpm fmt` 为准；只改格式的提交单独提交，完整哈希加入 `.git-blame-ignore-revs`。
- 运行环境：每个项目在 `package.json` 声明 `latch.env`，只用该环境的全局变量与模块；`apps/desktop/src/*.cjs` 是 CommonJS，其余是 ES 模块。新增目录时加入对应 `tsconfig.*.json` 与 `.oxlintrc.json` 覆盖规则；新增 workspace 项目时另写 `latch.env` 并登记到 `PROJECTS`，规则与上层不同时写 `AGENTS.md` 与内容为 `@AGENTS.md` 的 `CLAUDE.md`。
- workspace 项目只经包名导入（不用相对路径进入 `apps/`、`packages/`、`e2e/`），依赖写成 `workspace:*`；只有 `packages/core/src/registry.ts` 导入 `cordis`。用例放在所测项目的 `test/`，由 `vitest.config.ts` 的 project 运行。
- 工程技能只写在 `.agents/skills/<名称>/SKILL.md`，改动后运行 `pnpm agents:sync`；技能只调用脚本，规则以脚本为准。包示例放 `examples/<包>/SKILL.md`。
- Git 只跟踪产品代码与机制文档：分析报告、设计稿、工作记录与安全分析不进 Git，不引用其他产品作设计参考。提交信息只写改动与原因，用 Conventional Commits，scope 为项目名。
