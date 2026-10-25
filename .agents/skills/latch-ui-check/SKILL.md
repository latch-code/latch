---
name: latch-ui-check
description: 验证 Latch 的布局、组件或交互改动，检查真实截图、响应式与深色模式，并比较已有视觉基线。
---

# Latch 界面验收

规则以仓库 [DESIGN.md](../../../docs/DESIGN.md) 与 [TESTING.md](../../../docs/TESTING.md#视觉截图) 为准。

1. 运行 `pnpm exec tsx scripts/ui-check.ts --plan` 查看检查范围，再运行 `pnpm exec tsx scripts/ui-check.ts`。脚本只启动测试夹具，截图包含手机、平板与桌面、浅色与深色，以及控件总览。
2. 有画板映射时添加 `--boards <映射 JSON>`；有已有基线时运行 `pnpm exec tsx scripts/ui-check.ts --baseline <基线目录>`；基线放在 `test-results/visual` 与 `test-results/visual-diff` 之外。只有预期逐像素相同的复验才加 `--strict`，设计改动按报告逐项解释差异。
3. 查看脚本产出的 `test-results/visual/index.json`、`test-results/design` 与 `test-results/visual-diff/report.json`。索引的 board 字段映射已有画板；没有画板的真实功能按机制文档验收，当前产品行为优先。
4. 对照正常、加载、等待、失败、空内容、只读与减少动效状态，检查点击命中、键盘与焦点归还、窄屏返回、溢出和阅读位置。修复后重跑失败检查与受影响场景，不放宽断言或截图阈值。
5. 汇报执行结果、截图绝对路径与人工检查范围。测试确认后端与夹具不代表真实 Touch ID、真实模型或真机通过；系统确认表单由所有者验收。
