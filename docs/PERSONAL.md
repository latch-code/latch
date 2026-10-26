---
description: 个人助手的配置、显式私有记忆、会话归属与执行权限。
sources:
  - apps/host/src/personal-store.ts
  - apps/host/src/personal-routes.ts
  - apps/host/src/server.ts
  - packages/protocol/src/personal.ts
  - packages/core/src/runtime.ts
  - packages/core/src/registry.ts
  - apps/web/src/personal
---
# 个人助手

个人助手与项目工作共享 Harness、模型服务和插件注册表。日常会话不要求先保存项目；助手的名字、职责、Harness、模式、模型和插件选择保存在 Host。`GET /link/api/personal` 返回助手概览，助手详情包含用户明确维护的记忆和直接归属的会话。客户端仅在 `catalog.features.personal` 为真时提供入口。

`POST /personal/assistants` 创建配置，`PATCH /personal/assistants/:id` 使用 `baseRevision` 作并发检查。`/personal/assistants/:id/memories` 支持用户创建、修改和删除记忆；模型没有写入记忆的工具。每条记忆最多 4000 字、每个助手最多 128 条且正文总计不超过 256 KiB；全部定义最多 512 KiB，保证有界手机响应。`model: null` 可恢复使用默认模型。

个人助手数据只对完整数据范围的设备开放；范围不足时说明如何在电脑上允许。

Web 与桌面在导航提供「个人助手」，展示真实助手、职责、直接会话与显式记忆。创建和编辑使用 Host 声明支持私有上下文的 Harness、实际模型和已启用插件的有限元数据；普通已允许设备不需要额外管理权限来选择插件。新会话只提交助手 ID、输入和附件／引用，普通项目选择与模型覆盖不会混入。既有私有会话使用同一份对话、审批、取消和阅读位置界面；模型与执行方式回到助手配置中修改，不提供必然被 Host 拒绝的会话覆盖控件。

页面只在可见时读取职责和记忆，卸载、数据范围收紧或查看权限消失时撤下内容与编辑器，不写浏览器本地存储。刷新提示只传计数，在私有页面中合并后重新授权读取，不在流式 token 变化时反复取私有正文。配置和记忆的未知提交保留完整请求与同一个请求 ID，重试不会创建第二条记录；新对话沿用已有持久提交恢复流程。

## 创建与继续会话

`POST /link/api/tasks` 接受 `{assistantId,prompt,requestId,attachmentIds?,fileRefs?}`；助手会话不能同时传入 `workspaceId`、`harnessId`、`mode`、`model` 或 `forkOf`。Host 从已保存配置选择执行端，沿用普通创建路径的目录、风险分级、审批、出站和本机确认规则。Agent 模式在默认启动目录下沿用自有会话目录；显式配置的工作区共享行为不变。归属在执行开始之前随 `TaskSummary.personal` 持久化，Host 收到新 ID 时先保守标为私有，再保存 Host 元数据。后者失败不撤回内存分类；未知请求恢复先补写元数据，私有 Driver 在 Host 接受请求前从实际会话重建分类。目录或项目归属不代替助手归属。

`TaskSummary.pluginIds` 记录本轮选择的插件。Standard 的 `registry.acquire(providerId,{tools,pluginIds})` 只租用这些已启用插件贡献的工具和技能，空数组表示不提供 Host 工具或技能。Provider 本身独立租用，Provider 所属插件的工具不会因此自动被选中。实际工具分发也使用同一租约；这不是提示词约定。插件和外部 Agent 仍是可信本机代码，应用层选择不构成 OS 沙箱。

职责和私有记忆只放在当前运行的系统上下文中，不写入用户 `Message.text`、模型持久历史、分叉种子或导出记录。下一轮由 Host 重新读取本助手的显式记忆；其他助手、项目会话和群聊不自动继承。助手生成的可见回复仍属于用户选择查看或分享的会话内容。

Driver 必须显式声明 `personalContext: 'private'`，确保隐藏上下文不进入可分叉历史并执行所选 Host 能力边界。当前内置 Standard 实现该契约；没有声明的 ACP 或自定义 Driver 在界面中给出不可用原因，不会静默回退。更换 Harness 或模式后，原会话不能迁移执行，需创建新会话。个人会话排队尚未接入这一私有上下文契约，Host 明确拒绝，不把普通队列当作已支持。

## 持久化与未知结果

每次修改携带 `requestId`，按设备和操作内容保存哈希回执；同编号不同内容返回冲突。删除减少私有数据，审计故障仍执行并返回 `x-latch-audit: failed`。

会话启动先落盘原始 Harness、模式、模型、插件与定义摘要。派生的内部请求 ID 绑定设备，重试不会迁往后来修改的 Harness。已接纳的用户输入用 `Message.requestId` 找回原会话；尚未确认且定义变化时拒绝自动重跑，提示先同步。私有记忆正文不写入这个启动回执。

原子写在 rename 后也可能失败。此时保留本次待确认草稿与已分配 ID，拒绝其他修改和读取，直到同一请求成功确认；不会再分配第二个助手或第二条记忆。重启从持久回执恢复。已删除实体的原始创建请求返回已删除，不复活记录。修改回执和启动预留各最多 10000 条且不淘汰；容量满时新授予失败，删除仍可执行。删除不清理启动身份，避免迟到重试重新执行。

例行任务和助手群聊的 DTO 已定义；在对应调度与接力闭环实现之前，当前 HTTP 不提供假启用或假发送入口。没有邮件等插件时不会显示发送能力。


## iPhone 与 iPad

原生应用提供独立的个人助手入口，读取 Host 真实配置并编辑职责、模型、已安装插件和显式记忆；不要求先选项目。`HarnessInfo.personalContext` 只由 Driver 的真实声明发布，手机只提供已有 L1 私有上下文的执行方式。消息继续用现有 TextKit 2 对话与输入视图；所有编辑器同样使用本机、到期剪贴板，窗口过期、设备权限变化或换电脑时撤下私有内容并关闭编辑器。冷缓存只保留会话的 `personal` / `pluginIds` 等归属元数据，记忆和职责不会进入列表缓存。

手机文件预览展示真实收到字节的进度。取消会取消拥有的 Swift Task，关闭当前读取流，后续 Range 不再启动；旧任务的晚回按请求与内容代次丢弃。格式白名单仍为 UTF-8 文本与重绘 PNG/JPEG，不因个人助手入口而放开 Quick Look 格式。

自动验证包含真实 Swift 连接临时 Host 的配对、正文窗口、Mac 显式授权、配置/记忆/会话/幂等/缓存归属与删除链。SDK 构建不代表真机 Face ID、Secure Enclave 或视觉验收；无已安装模拟器运行时时不声称已有原生截图。
