---
description: 大文档的真实渲染基准、输入生成、逐页截图、Chrome 指标范围与所有者参照比较。
sources:
  - packages/testkit/src/documents.ts
  - apps/web/test/document-performance-fixtures.test.ts
  - apps/web/test/document-performance.html
  - apps/web/test/document-performance.tsx
  - e2e/helpers/document-performance.ts
  - e2e/document-performance.e2e.ts
---
# 文档性能与保真验证

`performanceDocumentFixtures(zip)` 在内存生成真实内容：30 页 PPTX 包含 master、layout、theme、逐页文本和图形；200 页 PDF 包含实际页树、内容流和字节精确的交叉引用表；XLSX 为一张 12,001 行、8 列的工作表，每个数据行包含数值、日期、记录名及五个确定生成的 256 字符 trace 字段。压缩后的 XLSX 至少 10 MiB，工作表 XML 不超过 32 MiB，不用空条目、注释或 ZIP padding 撑大。生成器不依赖原应用或新增包。

原有 `documentFixtures()` 的函数体与默认小样例保持不变。新的纯 Node Vitest 核对 ZIP 解压、关系图、页数、PDF xref/stream 长度、真实单元格数和大小边界，并把三个输入覆盖写到 ignored `test-results/document-performance/input.*`。这些结构检查不冒充 Office 完整 XSD 校验或原应用打开验收。

运行纯 Node 输入检查：

```sh
pnpm exec vitest run --config vitest.config.ts apps/web/test/document-performance-fixtures.test.ts --maxWorkers=4
```

运行真实 Chromium 基准前先完成 `pnpm build`，以取得产品的固定 Office frame 和 PDF 字体资源；在仓库规定的浏览器串行窗口内执行：

```sh
HARNESS_BROWSER_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' pnpm exec vitest run --config e2e/vitest.config.ts e2e/document-performance.e2e.ts
```

用例额外将独立测试宿主构建为生产 bundle，输出到同一 ignored 目录的 `harness/`，不覆盖 `dist/web`。它实际使用产品 `DocumentPreview`、`FileSandbox`、PDF worker 和产品的 Office frame，经仅监听 127.0.0.1、端口 0 的有限输入服务读取 200/206 字节。PDF 继续走实际 Range 接口。这里测量本地渲染路径，不测 Host 认证、远程网络或原生连接。

三个首屏目标固定为 PPTX 1500ms、PDF 1000ms、XLSX 3000ms，超出就失败，不根据机器或当次结果自动放宽。起点是在测试宿主交付文件元数据、开始产品读取之前；终点为真实内容出现后的两个动画帧。PDF 的标记须在 canvas 完成后生成的文字层出现，XLSX 须出现实际数据行，PPTX 须在沙箱 DOM 出现第一页标题。时间包含输入 HTTP 读取、解压、解析、必要 lazy chunk/worker 初始化与绘制；夹具生成、宿主构建、浏览器和主界面冷启动在测量之外。报告记录浏览器版本、CPU、平台、输入字节与 SHA-256，便于复验。

PPTX 的 30 页和 PDF 的 200 页逐一读取、滚动到实际内容并保存 PNG，同时核对虚拟页/DOM 上界；XLSX 核对行数、有限网格 DOM，以及首/末窗口。截图为 1 倍像素，固定名称覆盖上一轮，不不断创建整套副本。性能断言使用 soft assertion，让超预算时仍尽量生成逐页材料；渲染或读取失败仍会中止并留下失败原因。

各格式的 JSON 记录三次 Chrome CDP renderer-target JS heap 与 DOM 计数：打开前、首屏、走完页面后。主页面和可附加的 Office target 分开列出，可能覆盖同一进程，不相加。PDF worker、GPU/canvas 原生分配和进程 RSS 不在这些指标内；三次样本也不是总内存峰值的上界。没有相应 target 时显式记录 unavailable。

所有者可以把原应用导出的逐页 PNG 放在独立目录，以 `LATCH_DOCUMENT_REFERENCE_DIR` 指定。名称为 `pptx-page-001.png` 至 `030`、`pdf-page-001.png` 至 `200`；XLSX 的两个网格窗口为 `xlsx-page-001.png` 和 `xlsx-page-12001.png`。参照必须与实际 PNG 像素尺寸一致；用例不偷偷缩放。单张参照限 8 MiB、二百万像素。已有 YIQ 0.1/抗锯齿排除算法生成像素差异报告，差异、尺寸不符、参照缺失或无法读取都只写报告，不决定保真通过。

没有所有者参照时，JSON 明确标为 `unverified-original-application-fidelity`；有部分参照时仍列出比较数量和 `completeReferenceSet`，不把自截图或部分比较称作 PowerPoint、Keynote、Excel 或系统 PDF 的保真验收。所有产物只含本项目生成的样例，不提交第三方文档。
