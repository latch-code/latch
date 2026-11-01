---
description: 我的 Agent 与「通用」：定义、记忆、会话归属、各引擎如何收到指令、记忆和技能。
sources:
  - apps/host/src/custom-agents.ts
  - apps/host/src/agent-plans.ts
  - apps/host/src/agent-journal.ts
  - apps/host/src/routes/agents.ts
  - apps/host/src/hub.ts
  - apps/host/src/server.ts
  - packages/protocol/src/custom-agents.ts
  - packages/core/src/runtime.ts
  - packages/core/src/registry.ts
  - packages/harness-acp/src/bridge.ts
  - packages/harness-acp/src/skills-server.ts
---
# 我的 Agent

Agent 是用户使用的那个东西：名称、图标、说明、指令、技能、引擎、模型，再加记忆与默认项目。引擎（代码里仍叫 Harness）是运行它的程序，自带基础提示和工具。Agent 不替换引擎，只往上加。

`catalog.features.customAgents` 声明下面的接口。这些路由与 `/link/api/agents` 无关：后者仍指引擎定义。

| 接口 | 作用 |
| --- | --- |
| `GET /custom-agents` | 「通用」、我的 Agent 摘要与可选插件 |
| `POST /custom-agents` | 新建；图标由 Host 分配 |
| `GET`、`PATCH`、`DELETE /custom-agents/:id` | 详情（含指令、记忆、会话）、按 `baseRevision` 修改、删除；可选字段传 `null` 清除 |
| `GET`、`POST /custom-agents/:id/memories`，`PATCH`、`DELETE …/:mid` | 记忆，只有用户能写，只有这个 Agent 能用 |
| `GET`、`PATCH /custom-agents/general` | 「通用」，不能删除；记忆路由同样可用 |

快照的 `customAgents` 只有摘要（不含指令、技能和工具的内容）。写操作都带 `requestId`，重试按回执回答；结果未知时拒绝其他修改和读取，Host 每秒自己重试写入，也可以重试同一请求；这期间快照没有 `customAgents` 和 `automations`，其余照常。定义在 `agents/custom.json`。

## 字段

- `harnessId`：默认引擎。`mode`：引擎有多种模式时的默认值。
- `model`：只用于运行在 Host 模型服务上的引擎。
- `engineOptions`：外部引擎自己的默认项（模型、思考、权限），`configId` 到值。Host 只保存，由启动会话的客户端经会话配置路由设置，走该路由的检查；Host 在第一轮之前不会替客户端设置。内置引擎目前没有思考档位。
- `instructions`：指令。`skills`：`catalog.skills` 里的 `pluginId:skillId`。
- `tools`：「可以使用」，只对内置引擎生效，是可调用工具的插件 ID；缺省时不额外限制。它只收紧，不授予新能力。
- `defaultProjectId`：新会话的默认项目。

摘要里的 `available` 与 `unavailableReason` 说明现在能否开始会话，`canAutomate` 说明能否用于自动化。

## 「通用」

「通用」是内置 Agent，没有自己的引擎：选了它的会话用当次选择的引擎和模型。写给它的指令和记忆对没选别的 Agent 的会话生效，这些会话没有 `TaskSummary.agent`。

只有完整数据范围的设备发出的一轮才带上「通用」：模型的回复可能复述它，其他设备读得到的会话不能收到它。范围较小的设备照常工作，就像「通用」是空的。

一轮带上「通用」后，这个会话的 `TaskSummary.agentPrivate` 就为真，写入时机在模型收到之前，读取与继续都要完整数据范围，范围较小的设备从此看不到它，即使是它开始的。分叉一个私有会话得到的新会话同样私有，自动化的每次运行也是。

`skills` 缺省时这些会话加载全部已启用的技能，与之前一样；写成数组（包括空数组）后就只加载这些；其中插件已停用或移除的技能不再加载，不影响会话开始。

## 会话

`POST /tasks` 接受 `customAgentId`。请求里同时给的 `harnessId`、`mode`、`model`、`workspaceId` 只影响这次会话，没给的取 Agent 的默认值。一个请求的选择在第一次时写入回执，所以结果未知后的重试不会换到后来改过的引擎。

会话开始后 Agent 与引擎不再变，归属记录在 `TaskSummary.agent`。Agent 的会话内容与个人助手一样只对完整数据范围的设备开放。

## 各引擎如何收到

`HarnessInfo.agentContext` 与 `HarnessInfo.skills` 说明引擎的接收方式；两者都由 Driver 声明。没有 `agentContext` 的引擎不能运行 Agent。

**内置引擎**（`private`、`native`）：每轮的系统提示依次是 Latch 的基础提示、指令和记忆、技能。指令和记忆只在这一轮的运行里，不进消息、历史、分叉或导出；每轮按当前定义重新读取。技能目前随会话整段加载，尚未实现按需读取。Agent 删除后，它在内置引擎上的会话不再接受输入，提示在新会话中继续。

**外部引擎**（`first-turn`）：引擎的提示和工具都保留。指令和记忆作为一个带标注的文本块，在第一个真正到达引擎的轮次排在用户输入之前发送，写出后记录在那条用户消息的 `agentBrief` 上；`segments` 分开 Latch 的说明和用户写的内容，换行连接后就是发送的字符。第一轮没有到达引擎（进程没有起来、发送前取消）时，文本块留到下一轮，重启后也一样；写出后、记录落盘前崩溃时下一轮会再发一次，不会一次都没发。`Message.text` 不含它，分叉也不带它。发送过之后的轮次不再发送，改动指令不影响已开始的会话。完全访问的启动确认同时覆盖这个文本块，确认句写成「代码审阅（Codex）」。

**外部引擎的技能**（`server`）：Host 把所选技能复制到会话自己的目录，并在 `session/new`、`resume`、`load` 时附加一个 stdio MCP 服务 `latch-skills`。它只有 `list_skills` 和 `read_skill` 两个工具，不写文件、不访问网络。删除会话时一并删除这份副本。预设以 `skillServer: false` 声明不接受 MCP 的引擎（目前是 pi 与 DeepSeek Harness），这些引擎没有 `HarnessInfo.skills`，技能不发送，界面据此提示。其余预设是否实际取用技能尚未逐一验证。

`agentContext` 由 Host 构造，从不接受 HTTP 客户端传入。
