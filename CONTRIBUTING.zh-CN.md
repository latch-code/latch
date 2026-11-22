# 参与贡献 Latch

[English](CONTRIBUTING.md) · 简体中文

Latch 由一个人维护，审阅时间是瓶颈。

- **缺陷修复**：欢迎附上清楚的复现步骤。小修复直接提 PR，大的先开 Issue。
- **新功能、新 Harness、新依赖**：先开 Issue，等回复后再写代码。专门的工作流也许更适合做成[插件](docs/PLUGIN-DEVELOPMENT.md)。
- **安全问题**：发邮件到 [nirvanaxiaojie@gmail.com](mailto:nirvanaxiaojie@gmail.com)，不要开公开 Issue。

## 准备环境

需要 macOS，以及 Node.js 24.22.1、pnpm 11.28.6（经 Corepack）、Go 1.26.10 和 Xcode 命令行工具。单元测试也能在 Linux 上运行。

```sh
corepack pnpm install
corepack pnpm exec lefthook install
```

`pnpm install` 不会安装 Git 钩子，所以要运行第二条命令。其余命令见 [AGENTS.md](AGENTS.md#命令)。

## 不碰自己的数据

不显式给出路径时，Latch 用的是你真实的数据目录、工作区和端口。开发时始终给出临时的：

```sh
export DATA=$(mktemp -d) WORK=$(mktemp -d)
pnpm build && pnpm start:demo -- --port 0 --data-dir "$DATA" --workspace "$WORK"
pnpm stop -- --data-dir "$DATA"   # 在另一个终端运行
```

`--demo` 使用模拟模型。测试只用临时目录、假模型和假 ACP Agent，不要在测试里调用付费模型或真实的 Agent CLI。

## 提交 PR

- **一个 PR 只解决一个问题。** 重构和格式化另开 PR。
- **守住 [AGENTS.md](AGENTS.md) 的规则**，尤其是不变量。改到的每个目录，都先读其中的 `AGENTS.md`。
- **只跑受影响的检查。** `pnpm check -- --plan` 会列出这次改动要跑的检查，至少要跑 `pnpm check:quick`。
- **证明它能用。** 写清你测了什么、看到了什么，界面改动附改前改后的截图。只写「测试通过」不够。
- **提交标题**用 Conventional Commits，scope 写项目名，例如 `fix(web): …`、`feat(host): …`。
- **不要放进秘密**：提交、截图和 PR 描述里都不要出现连接码、密钥、设备凭据或未检查过的日志。

改依赖、脚本、钩子、工作流或 Agent 指令需要所有者审阅（`.github/CODEOWNERS`）。

提交贡献即表示你同意它以 [MIT 许可证](LICENSE)发布。
