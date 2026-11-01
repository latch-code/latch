# AGENTS.md

Latch 是跨电脑与手机的 AI Agent 工作台。Node Host（`apps/host`）持有会话、执行权限、密钥、设备登记与审计；Electron 桌面端经 `host.sock`、浏览器经回环地址、手机经运营者提供证书的 HTTPS 连接同一个 Host（HTTP + SSE）。会话组合 Harness（内置 `standard`，或经 ACP 接入的开源 Agent）、模型服务与项目目录；Provider、Tool 与 HarnessDriver 都以 Cordis 插件注册。安全优先：拿不准时拒绝。

## 开始之前

1. 运行 `git status`，保留已有的未提交改动。
2. 编辑某目录前，先读该目录及其上层目录中的 `AGENTS.md`（Claude Code 经 `CLAUDE.md` 读取），再按「改动前先读」打开文档；以源码与测试为准，不凭记忆推断现状。
3. 不停止、重启或连接用户正在运行的 Host，也不使用默认数据目录（见「本机运行安全」）。

## 代码地图

| 路径 | 职责 |
| --- | --- |
| `apps/host/` | Host 组合根、插件与命令 |
| `apps/web/` | 浏览器与桌面共用页面，构建到 `dist/web` |
| `apps/desktop/` | `@latch/desktop`：Electron 主进程与 preload（CommonJS） |
| `packages/link-wire/` | 原生连接的纯编码、KDF 与恢复日志 |
| `packages/link-client/` | 原生 TLS、Go 组件与中继 |
| `apps/relay/` | 自建盲中继底座 |
| `packages/protocol/` | 共用 DTO、预设与安全文本 |
| `packages/ui/` | `@latch/ui`：令牌、层叠层与原语 |
| `packages/sdk/` | `@latch/sdk`：插件作者面与 `AppError` |
| `packages/core/` | Cordis、执行循环、快照与 Node 工具 `./node-kit` |
| `packages/harness-acp/` | ACP 驱动与权限预设 |
| `packages/testkit/` | Host、确认后端、安全向量与假 ACP 测试夹具 |
| `e2e/` | `@latch/e2e`：全部 `*.e2e.ts`，Vitest 内用 Playwright 驱动浏览器与 Electron |
| `tests/` | 根项目的用例：`@latch/core`、`@latch/sdk`、兼容入口与仓库脚本 |
| `src/` | `latch/plugin-sdk`、`latch/harness-sdk`，再导出 `@latch/sdk` |
| `scripts/` | 仓库工具：检查、文档与技能、安全扫描、依赖边界（项目表 `boundaries.ts`）、供应链、工作流 |
| `native/` | macOS 本机确认与目录组件；`ios/` 含独立 Swift 核心、iPhone/iPad App 与互操作夹具 |
| `docs/`、`examples/` | 机制文档（见「改动前先读」）；插件示例 |
| `.agents/skills/` | `latch-verify`、`latch-security-review`、`latch-ui-check`；`.claude/skills/` 由 `pnpm agents:sync` 生成 |
| `tsconfig.*.json`、`.oxlintrc.json`、`.oxfmtrc.json`、`knip.json`、`lefthook.yml` | 类型检查的各运行环境、lint、格式、依赖检查、Git 钩子 |

依赖只向下：`apps/host` → `harness-acp` → `core` → `sdk` → `protocol`（箭头指向被依赖的包）；`apps/web` 运行时只用 `protocol` 与 `ui`，`apps/desktop` 只用 `protocol`；`testkit` 与 `e2e` 只能写在 devDependencies。矩阵在 `scripts/boundaries.ts` 的 `PROJECTS`（仓库根也在其中），由 `pnpm check:boundaries`、`pnpm knip` 与 `pnpm lint` 执行；违规在边界上修，不加例外。

## 命令

需要 Node.js 24.22.1（`.node-version`；`engines` 只接受含 2026-10-20 安全修复的版本，其他版本下 pnpm 命令直接失败，用 `fnm use` 切换）与 pnpm 11.28.6（`packageManager` 固定版本与 sha512），构建原生组件需要 Go 1.26.10（`.go-version`）。

```sh
pnpm install
pnpm check:quick                             # fmt:check、lint、typecheck、check:boundaries、check:agents，几秒内完成
pnpm check                                   # check:quick 加 knip 与 test，逐项汇报
pnpm check -- --plan                         # 按改动路径列出要运行与不需要运行的检查；--base <ref> 指定比较的提交
pnpm fmt                                     # oxfmt 写入格式；不处理 Markdown 与 packages/testkit/vectors/
pnpm test --project @latch/host              # 只跑一个项目（项目名见 vitest.config.ts）
pnpm exec vitest run --config vitest.config.ts <目录>/<name>.test.ts
pnpm build                                   # build:host + build:web + build:presence；e2e 使用 dist/web
LATCH_BROWSER_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' pnpm test:e2e
LATCH_ELECTRON_E2E=1 pnpm exec vitest run --config e2e/vitest.config.ts e2e/desktop.e2e.ts
                                             # 仅 macOS，先 pnpm build；用例不碰钥匙串与桌面端数据
pnpm latch --help                            # 列出子命令；调用时都加 --data-dir <临时目录>
pnpm start:demo -- --port 0 --data-dir <临时数据目录> --workspace <临时工作区>
pnpm stop -- --data-dir <同一数据目录>
LATCH_DATA_DIR=<临时目录> pnpm dev:web        # 仅开发；按 Vite 打印的 http://h-<hostId>.localhost:<端口>/link/ 打开
```

其余命令见 [docs/TESTING.md](docs/TESTING.md#命令)。

每个克隆手动运行一次 `pnpm exec lefthook install` 与 `git config blame.ignoreRevsFile .git-blame-ignore-revs`；Git 已设置 `core.hooksPath` 时不加 `--force` 或 `--reset-hooks-path`，做法见 [docs/TESTING.md](docs/TESTING.md#git-钩子)。

## 不变量（违反即缺陷）

项目专用的不变量见该项目的 `AGENTS.md`。

**会话与界面**

- Host 是会话状态的唯一权威；网络连接、任务执行与客户端阅读位置分别建模。
- 取消必须等执行端真实结算后才确认；写请求超时保持「结果未知」并复用原 `requestId`，审批与取消回执随会话持久化。
- 流式消息在完成、失败、取消时沿用同一 ID；切换会话、重连与迟到的响应不得回滚新状态或重复追加历史。
- 真实 Provider 失败必须报错，不得回退到演示模型；演示模式必须显式启用并在界面标注。
- 会话与审批 ID 全局唯一；新增的持久化字段必须加入对应 zod schema：多数 schema 会丢弃未知字段，`policy.json`、设备与登记文件、审计 detail 的 schema 是 strict，会拒绝未知字段。
- 插件与 ACP Agent 是可信本机代码；应用层审批、路径检查与出站策略不是 OS 沙箱，文档与界面不得暗示隔离。
- [兼容标识](docs/ARCHITECTURE.md#兼容标识)改名须附带迁移：旧包名 `harness-link` 与浏览器旧键仍可用；`/link/`、旧 `.runtime`、`openai-compatible` 不改；Cookie `harness_link` 只识别需重新确认的浏览器。

**安全**

- **秘密不外泄。** 设备凭据、邀请码、离线登记码与模型密钥不进入标准输出、日志、环境变量、命令行参数、URL、SSE、错误信息、Git 或截图。URL 里的邀请码只出现在配对链接的 `#pair=` 片段中，页面读取后立即从地址栏移除；`pnpm latch` 只把邀请与离线码显示在交互终端，或写入新建的 0600 `--code-file`。Host 的每行日志都经过 `redactSecrets`，新增秘密格式时同步补充模式。
- **磁盘上只存哈希。** 凭据与离线登记码只保存 SHA-256；邀请只在内存中、也只存哈希。模型密钥只在数据目录的 0600 文件中，不返回浏览器；`LATCH_API_KEY` 只在内存中使用。
- **本机确认只经 `PresenceService`。** 测试确认后端（`@latch/testkit`）只通过 `startServer({ presence })` 注入。只有测试（`tests/`、`e2e/` 与各项目的 `test/`）导入 testkit 与测试目录中的文件，其他用法由 `pnpm check:boundaries`、`pnpm lint` 与 Host 构建拒绝；构建后 `grep -rnE 'createTestPresence|startHostFixture|latch-test\.localhost|(tests?|e2e)/(helpers|fixtures)|packages/testkit|@latch/testkit' dist/` 必须为空。
- **只有 `host.sock` 算这台电脑**（`isLocalListener`）：本机确认只由桌面端发起（登记例外）；L3 运行或等待时只放行 `PRESENCE_ACTIONS` 标为 `proceed` 的确认。
- **Host 与 `pnpm latch` 不响应 SIGUSR1。** 启动 Host 的脚本、桌面端与 `pnpm latch` 都带 `--disable-sigusr1`，否则同用户进程可以用 `process._debugProcess` 让持有秘密的进程打开调试端口；新增启动 Host 或处理秘密的入口时同样加上。
- **依赖供应链。** 依赖以精确版本写在 `pnpm-workspace.yaml` 的 `catalog`，`package.json` 只写 `catalog:`；新版本须发布满 7 天。放宽 `pnpm-workspace.yaml` 的供应链设置、新增例外（格式见 [docs/TESTING.md](docs/TESTING.md#供应链金丝雀)）或 `allowBuilds` 条目都要所有者同意；改依赖、`pnpm-workspace.yaml` 或 `packageManager` 后运行 `pnpm check:supply`。
- **共享安全编码。** 修改 base32、指纹、`canonicalJson`、确认预览与 previewHash、`hashDisplay`、`escapeSecurityText` 或签名文本时，同时更新 `packages/testkit/vectors/security-v1.json`、`native/macos/LatchPresence.swift` 与各处实现（`apps/host/src/crypto.ts`、`auth.ts`（签名文本）、`presence*.ts`（确认预览）、`packages/core/src/node-kit/digest.ts`、`packages/protocol/src/text.ts`、`apps/web/src/core/deviceKey.ts`、`contentHash.ts`、`apps/desktop/src/credentials.cjs`），再 `pnpm build:presence` 并运行 `presence.test.ts`（自检用例对旧组件失败）。

## 本机运行安全

- 不停止、重启或向已运行的 Host 发信号，不读取、修改或删除 `.runtime*/`。
- 每个命令都显式指定临时目录：`pnpm start` / `start:demo` 带 `--data-dir`、`--workspace` 与 `--port 0`；`pnpm latch`、`pnpm stop` 带同一个 `--data-dir`；`pnpm dev:web` 用 `LATCH_DATA_DIR`。省略时会落到用户的数据：当前目录的旧 `.runtime/`、平台默认数据目录（macOS 为 `~/Library/Application Support/Latch/Host`）、`~/Latch/workspace` 与端口 4317。
- 只停止自己启动的节点：`pnpm stop -- --data-dir <目录>` 经 `host.sock` 核对后才发 SIGTERM，有运行中或等待审批的会话时拒绝（`--force` 仍然停止）。不删除其他节点的 `host.lock` 与 `.host-lock-*`（见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#hostjson-与数据目录锁)）。
- 不运行 `git clean -x`、`git clean -X` 与 `git stash -a`：被忽略的目录里有用户的数据，后者还会把它们写进对象库。
- 审阅外部 PR（所有者以外的人的改动）时，在独立的 worktree 中检出，每个 git 命令都带 `-c core.hooksPath=/dev/null`（如 `git -c core.hooksPath=/dev/null worktree add <临时目录> <提交>`），因为已安装的钩子执行检出内容中的 `lefthook.yml`。不在该目录运行 `pnpm install`、任何 `pnpm` 脚本、测试或构建，也不在该目录启动 Agent：PR 可以修改包脚本、依赖与安装策略、构建与测试配置和 Agent 指令，运行其中任何一项都会执行 PR 作者的代码。改动这类文件的 PR 由所有者审阅（`.github/CODEOWNERS`）。
- 测试与调试只用临时目录、端口 0、本地假模型服务与假 ACP Agent。不调用付费模型，不对真实 Agent CLI 发送提示。不运行 `pnpm desktop`（它使用系统钥匙串与默认桌面端数据目录），桌面端用 Electron e2e 验证。
- `pnpm build` 会更新 `dist/web`，正在运行的旧 Host 会直接提供新页面；客户端必须能在缺少 `snapshot.catalog` 与 `snapshot.host`（旧 Host）时降级运行。修改 `LatchPresence.swift` 后的构建会改变确认组件签名，使用这份代码的已运行 Host 的本机确认随之不可用，需要用户停止 Host 后运行 `pnpm latch presence repin`，完成时告知用户。

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
| 用户可见的启动参数、手机接入、`pnpm latch` 命令 | [README.md](README.md) |

## 产品规则

- 蓝白为主：蓝色只给执行与勾选，琥珀只表示警告与等你处理，红色只表示真实风险或失败，都配文字；令牌只在 `packages/ui/src/tokens.css`。应用图标为 `apps/web/public/icon.png`（源图 `build/icon.png`），不改动图形。
- 密钥、Agent 的命令与环境变量、放宽安全策略、批准 R2 与开启 L3 会话只在执行端电脑上处理：桌面端经本机确认（预置地址的密钥与 Agent 定义免确认），或 Host 停止时的 `pnpm latch` 离线命令；不为远程设备提供绕过路径。
- Harness 预设只收录可在本机安装运行、许可证可核对的开源 Agent，并记录许可证；预设使用已安装的命令，不在运行时下载代码。
- 只展示真实能力：不在界面或文档中声称未实现的功能、集成或隔离；未实现的写明「尚未实现」与原因。

## 完成标准

1. `pnpm build` 与 `pnpm check` 通过，先构建：`presence.test.ts` 的自检用例对比源码旧的确认组件失败并说明要先构建；构建后 `dist/` 中没有测试代码（见「安全」）。
2. 其余检查由 `pnpm check -- --plan` 按改动列出，技能 `latch-verify` 按它运行并汇报：连接、登记、审批、取消或流式状态跑 `pnpm test:e2e`；`apps/desktop/` 或桌面启动脚本跑 Electron 用例；依赖、`pnpm-workspace.yaml` 或 `packageManager` 跑 `pnpm check:supply`；安全模块跑 [docs/TESTING.md](docs/TESTING.md#按改动选择回归) 对应的定向用例。
3. UI 改动在手机、平板、桌面宽度检查真实渲染，覆盖正常、进行中、失败或等待状态与深色模式（`e2e/design.e2e.ts`、`e2e/visual.e2e.ts` 的截图）。测试夹具、测试确认后端与演示模型不等于真实模型、Touch ID 或真机验收；系统确认表单只能由用户本人用 `pnpm latch presence test` 人工检查。
4. 行为变化时运行 `pnpm docs:affected`，更新对应的 `docs/` 机制文档与 `AGENTS.md`。
5. 汇报时区分已执行与未执行的检查。

## 约定

- 测试只用 Vitest（Playwright 仅作驱动）；为新行为添加聚焦用例；不为配置、清单或文档的字面内容写测试。
- 代码风格：严格 TypeScript，边界处用 zod 校验，错误用 `AppError(status, code, 中文消息)`；标识符与注释用英文，注释只写不显而易见的原因。只用作类型的导入写 `import type`（`verbatimModuleSyntax`）。格式以 `pnpm fmt` 的结果为准；只改格式的提交单独提交，并把它的完整哈希加入 `.git-blame-ignore-revs`。
- 运行环境：每个项目在 `package.json` 中声明 `latch.env`，只用该环境有的全局变量与模块；`apps/desktop/src/*.cjs` 是 CommonJS，其余是 ES 模块。新增目录时加入对应的 `tsconfig.*.json` 与 `.oxlintrc.json` 覆盖规则；新增 workspace 项目时另写 `latch.env` 并登记到 `PROJECTS`，规则与上层不同时写 `AGENTS.md` 与内容为 `@AGENTS.md` 的 `CLAUDE.md`。
- workspace 项目只经包名导入（不用相对路径进入 `apps/`、`packages/`、`e2e/`），依赖写成 `workspace:*`；只有 `packages/core/src/registry.ts` 导入 `cordis`。用例放在所测项目的 `test/`，由 `vitest.config.ts` 的 project 运行。
- 工程技能只写在 `.agents/skills/<名称>/SKILL.md`，改动后运行 `pnpm agents:sync`；技能只调用脚本，规则以脚本为准。包示例放 `examples/<包>/SKILL.md`。
- Git 只跟踪产品代码与机制文档：分析报告、设计稿、工作记录与安全分析不进入 Git，不引用其他产品作设计参考。提交信息只写改动与原因。
- 提交信息使用 Conventional Commits（`feat`、`fix`、`docs`、`design`、`refactor`、`test`、`chore`），scope 为项目名。
