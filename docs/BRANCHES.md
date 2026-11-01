---
description: Host 只读分支元数据、受限 Git worktree 验证与非阻塞摘要缓存。
sources:
  - apps/host/src/branch-reader.ts
  - apps/host/src/hub.ts
  - apps/host/test/branch-reader.test.ts
  - packages/protocol/src/types.ts
  - apps/web/src/shell/ConversationHeader.tsx
  - apps/web/src/components/Inspector.tsx
  - apps/web/src/core/useHarness.ts
---
# 只读分支

`TaskSummary.branch` 是 Host 临时生成的展示字段。普通 HEAD 返回分支名，分离 HEAD 返回「分离于 3f2a1c9」；没有可验证元数据时省略，不把失败说成当前没有分支。它不写入会话存储，Hub 会移除 Driver 自报的值，由同一读取器装饰列表、摘要和详情。前端把它放在来源行与环境主文件夹旁，旧 Host 缺少字段时保持原显示。

只读取 Git 元数据，不调用 Git，不读配置或 hooks；无法验证时输入框页脚不显示分支，标题行项目弹层写「读不到分支」。

`readGitLayout` 返回这次检查得到的工作树与 Git 目录；改动记录（[CHANGES.md](CHANGES.md)）只在通过检查的布局上以只读方式运行 Git，分支读取本身仍不调用 Git。

`BranchReader.decorate()` 同步返回缓存，不让列表等待磁盘。每个 Host 最多缓存 256 个根、1,024 个会话观察值，最多四个实际读取且不排队，同根请求合并。摘要再次被消费且缓存满 30 秒时刷新；观察到一轮结束或工作目录改变时立即失效重读。读取期间再次失效会丢弃旧结果，并在原读取真实结算后重读。只有值变化才通知 Host 更新列表，关闭等待实际读取结束并禁止迟到结果发布。页面可见时每 30 秒请求现有快照/同步即可驱动刷新；不可见页面无需新增轮询。
