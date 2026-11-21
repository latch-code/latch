<p align="center"><img src="apps/web/public/icon.png" width="80" height="80" alt="Latch"></p>

<h1 align="center">Latch</h1>

<p align="center">把你电脑上已经装好的 Agent 放进一个工作台，在桌面、浏览器和手机上接着干。</p>

<p align="center">
  <a href="README.en.md">English</a> ·
  <a href="docs/USAGE.md">使用说明</a> ·
  <a href="docs/HARNESSES.md">Harness</a> ·
  <a href="docs/RELAY.md">中继</a> ·
  <a href="docs/PLUGIN-DEVELOPMENT.md">插件开发</a>
</p>

<!-- 主图位置：.github/readme/hero.webp，全宽。画面是桌面窗口，右下角叠一台手机，两者都是同一个 Host 的真实界面。
<p align="center">
  <img src=".github/readme/hero.webp" width="100%" alt="Latch 桌面端的一个会话与它的改动，右下角是手机上的同一个会话">
</p>
-->

Latch 在你的 Mac 上运行一个 Host，驱动本机已登录的 Agent（Latch 里叫 Harness）。在桌面端开始一个会话，离开座位后在手机上看进度、批准下一步。

支持 [Codex](https://github.com/openai/codex)、[Claude Agent](https://github.com/agentclientprotocol/claude-agent-acp)（运行 Claude Code）、[pi](https://github.com/earendil-works/pi)、[OpenCode](https://github.com/anomalyco/opencode)、[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)、[Qwen Code](https://github.com/QwenLM/qwen-code)、[goose](https://github.com/block/goose)、[Cursor](https://cursor.com/docs/cli/acp)、[Antigravity](https://antigravity.google/docs/ide/extensions/acp/)、[Grok Build](https://docs.x.ai/build)、Latch 内置的执行循环，以及你自己填写的 ACP 命令。安装与登录方式见[使用说明](docs/USAGE.md#先装好一个-harness)。

## 你会得到什么

- **用你自己的订阅。** Latch 不转售额度，不下载也不修改 Agent，不改它们的配置；每个 Harness 用它自己的登录。
- **所有 Agent 在一个地方。** 对话中途换一个 Harness，它带着前面的记录接着做。一件事可以分给最多 8 个成员同时做，结果交回原来的会话。
- **Harness 与模型分开选。** 部分 Harness 可以经 Latch 的模型网关使用你添加的模型服务，见 [HARNESSES](docs/HARNESSES.md#经-latch-使用模型服务)。
- **桌面、浏览器和手机。** 三端连同一个 Host，看同一份进度，批准同一个操作。关掉页面不会取消任务，断线后从 Host 的状态恢复。
- **Git 就在会话里。** 每轮的改动可以查看和撤销；可以在新的工作树里开始会话，然后暂存、提交、推送、开 PR。
- **信任只建立一次。** 新设备与扩大权限要在这台 Mac 上用 Touch ID 确认，之后的日常操作不再弹窗，只留审计记录。模型密钥只在 Mac 上填写，不返回任何设备。
- **没有账号，没有云端。** 设备、权限与会话都由你 Mac 上的 Host 决定。其他网络经你自己的中继接入，中继读不到正文。
- **可以扩展。** MCP 服务器、插件与插件页面、自定义外观，以及带长期记忆和定时任务的「我的 Agent」。

Agent 与插件以 Host 的权限运行，Latch 不提供操作系统沙箱；审批决定你看管得多紧，不是隔离。见[安全边界](docs/USAGE.md#安全边界)。

## 安装与启动

需要 macOS、Node.js 24.22.1、pnpm 11.28.6、Xcode 命令行工具与 Go 1.26.10（构建用），以及至少一个已安装并登录的 Harness。

```sh
corepack pnpm install
corepack pnpm build
corepack pnpm desktop
```

第一次打开，桌面端会列出在这台 Mac 上找到的 Harness。想先不配模型体验流程，运行 `corepack pnpm desktop -- --demo`（演示模型，界面会标注）。

正式签名的安装包尚未提供。`pnpm package:desktop` 可生成供本机使用的应用，用你自己的 Developer ID 签名与公证见[使用说明](docs/USAGE.md#正式签名与公证)。

## 手机接入

- **iPhone 与 iPad App。** 源码在 [`native/ios`](native/ios)，在桌面端「设置 → 设备 → 连接手机」扫码配对。尚未上架，真机验收还没有做完。
- **手机浏览器。** 用你自己的 HTTPS 证书启动 Host，运行 `pnpm latch device invite` 扫码，再在 Mac 上确认一次。见[手机接入](docs/USAGE.md#手机接入https)。
- **不在同一个网络。** 经你自己的中继（Linux 服务器或你自己的 Cloudflare 账户）接入，见 [RELAY](docs/RELAY.md)。

## 文档

- [使用说明](docs/USAGE.md)：安装、启动参数、手机接入、`pnpm latch`、数据目录与限制
- [HARNESSES](docs/HARNESSES.md)：接入本机 Agent、权限模式、额度、模型服务
- [MCP](docs/MCP.md) · [RELAY](docs/RELAY.md) · [CUSTOMIZATION](docs/CUSTOMIZATION.md)
- 插件：[PLUGIN-DEVELOPMENT](docs/PLUGIN-DEVELOPMENT.md) · [APP-PAGES](docs/APP-PAGES.md) · [TRANSPORT-PLUGINS](docs/TRANSPORT-PLUGINS.md)
- 机制：[ARCHITECTURE](docs/ARCHITECTURE.md) · [STREAMING](docs/STREAMING.md) · [DESIGN](docs/DESIGN.md) · [TESTING](docs/TESTING.md)

参与开发前先读 [AGENTS.md](AGENTS.md)。

## 许可证

源代码以 [MIT License](LICENSE) 授权。"Latch" 名称与图标不在该许可范围内。随产品分发的第三方组件与品牌图标保留各自的许可证，说明见 [apps/web/public/licenses/README.txt](apps/web/public/licenses/README.txt)。
