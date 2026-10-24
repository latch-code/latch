@AGENTS.md

## Claude Code

- 技能：`/latch-verify` 按改动运行检查并汇报已执行与未执行的项；`/latch-security-review` 按安全不变量审阅改动，只报 P0/P1。技能只写在 `.agents/skills/`，`.claude/skills/` 是 `pnpm agents:sync` 生成的链接。
- 用 AGENTS.md「命令」中的 pnpm 脚本运行检查与工具，不直接调用 `tsx scripts/*.ts`、`tsx apps/host/scripts/*.ts`、`node dist/*.js` 或 `electron`；定向测试用 `pnpm exec vitest run --config <配置> <文件>`。
- Read、Grep、Glob 与 Bash 搜索都排除 `.runtime*/`、`node_modules/` 与 `dist/`；`.runtime*/` 里是用户的设备、密钥与审计数据，任何工具都不打开。
- 不运行真实的本机确认组件：`dist/native/latch-presence` 只经 `presence.test.ts` 以 `--self-test` 运行；不运行 `pnpm latch presence test`，也不让自己启动的 Host 弹出确认窗口。需要 Host 时优先用测试中的 `startTestHost`；必须用命令行启动时，在临时数据目录预置 `presence.backend` 为 `none` 的 `policy.json`（参照 `apps/host/test/cli.test.ts` 的 `stoppedDataDir()`），再用离线登记码登记。
- 自己启动的 Host 用 Bash 的后台模式运行，结束前用 `pnpm stop -- --data-dir <目录>` 停止并删除临时目录。
- 工具输出会进入对话记录：不要显示 `--code-file`、`providers.json` 或数据目录 `auth/` 下文件的内容；登记码只交给需要它的命令或页面。
