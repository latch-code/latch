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

大文档预览的首屏预算与逐页截图，在真实 Chromium 里用产品的渲染路径测量。渲染规则见 [DOCUMENT-PREVIEWS.md](DOCUMENT-PREVIEWS.md)。

## 输入

`performanceDocumentFixtures(zip)`（`packages/testkit/src/documents.ts`）在内存里生成真实内容，不依赖原应用，不提交第三方文档：

| 格式 | 内容 |
| --- | --- |
| PPTX | 30 页，含 master、layout、theme、逐页文本和图形 |
| PDF | 200 页，含实际页树、内容流和字节精确的交叉引用表 |
| XLSX | 一张 12,001 行、8 列的工作表；压缩后至少 10 MiB，工作表 XML 不超过 32 MiB，不用空条目、注释或 ZIP padding 撑大 |

结构检查（ZIP、关系图、页数、PDF xref、单元格数与大小边界）不是 Office 的完整 XSD 校验，也不是原应用打开验收。

## 运行

```sh
# 纯 Node 的输入检查，把三个输入写到 test-results/document-performance/input.*
pnpm exec vitest run --config vitest.config.ts apps/web/test/document-performance-fixtures.test.ts --maxWorkers=4

# 真实 Chromium 基准：先 pnpm build（取得产品的 Office 框和 PDF 字体资源），独占浏览器窗口串行运行
LATCH_BROWSER_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' pnpm exec vitest run --config e2e/vitest.config.ts e2e/document-performance.e2e.ts
```

- 用例把独立的测试宿主构建为生产 bundle，输出到被忽略的 `test-results/document-performance/harness/`，不覆盖 `dist/web`。
- 它使用产品的 `DocumentPreview`、`FileSandbox`、PDF worker 和 Office 框，经只监听 127.0.0.1、端口 0 的输入服务读取字节；PDF 走实际的 Range 接口。

## 预算

首屏预算固定，超出就失败，不根据机器或当次结果放宽：

| 格式 | 预算 | 终点的标记 |
| --- | --- | --- |
| PPTX | 1500 ms | 沙箱 DOM 出现第一页标题 |
| PDF | 1000 ms | canvas 完成后生成的文字层出现 |
| XLSX | 3000 ms | 出现实际数据行 |

- **起点**在测试宿主交付文件元数据、开始产品读取之前；**终点**是真实内容出现后的两个动画帧。
- 计入：输入的 HTTP 读取、解压、解析、必要的按需块与 worker 初始化、绘制。不计入：夹具生成、宿主构建、浏览器和主界面冷启动。
- 性能断言是 soft assertion，超预算时仍生成逐页材料；渲染或读取失败则中止并留下原因。
- 报告记录浏览器版本、CPU、平台、输入字节与 SHA-256。

## 逐页材料与指标

- PPTX 的 30 页和 PDF 的 200 页逐一滚动到实际内容并保存 PNG，同时核对虚拟页与 DOM 上界；XLSX 核对行数、有限网格 DOM 以及首、末窗口。截图为 1 倍像素，固定名称覆盖上一轮。
- 各格式的 JSON 记录三次 Chrome CDP 的 JS heap 与 DOM 计数：打开前、首屏、走完页面后。主页面和可附加的 Office target 分开列出，可能覆盖同一进程，不相加；没有对应 target 时记录 unavailable。

## 不证明什么

- 测的是本地渲染路径，不测 Host 认证、远程网络或原生连接。
- PDF worker、GPU 与 canvas 的原生分配和进程 RSS 不在指标内；三次样本不是内存峰值的上界。
- **保真。** 没有所有者参照时，JSON 标为 `unverified-original-application-fidelity`。自截图或部分比较都不是 PowerPoint、Keynote、Excel 或系统 PDF 的保真验收。

## 所有者参照

把原应用导出的逐页 PNG 放在独立目录，以 `LATCH_DOCUMENT_REFERENCE_DIR` 指定：

- 名称：`pptx-page-001.png` 至 `030`、`pdf-page-001.png` 至 `200`，XLSX 的两个网格窗口为 `xlsx-page-001.png` 和 `xlsx-page-12001.png`。
- 参照必须与实际 PNG 的像素尺寸一致，用例不缩放。单张限 8 MiB、二百万像素。
- 像素差异（YIQ 0.1，排除抗锯齿）、尺寸不符、参照缺失或无法读取都只写报告，不决定通过。有部分参照时报告列出比较数量和 `completeReferenceSet`。
