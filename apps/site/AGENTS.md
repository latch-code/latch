# @latch/site

Latch 官网：Astro 静态站。英文 `/`、`/download/`，中文 `/zh/`、`/zh/download/`；插件目录在 `/plugins/`、`/zh/plugins/`，与工作台共享 `examples/latch.catelog.json` 的条目。构建时生成 `/plugins/latch.catelog.json`、兼容的 `/plugins/catalog.json` 和按字节摘要命名的包。另有 404、`robots.txt` 与 `sitemap.xml`。不用 workspace 包，也不被其他项目导入。

- 运行环境 `browser`：`src/scripts/site.ts` 是唯一的页面脚本；`src/` 的其余文件在 Astro 构建时运行，同样不用 Node 全局变量。`astro.config.ts` 与 `scripts/` 是 Node 工具。
- 命令：根目录 `pnpm build:site`（输出 `apps/site/dist`，地址是 `https://latch.codes`，`SITE_URL` 可另设）、`pnpm dev:site`；本目录 `pnpm preview [端口]`（带 gzip 的本地服务，端口 0 自选）、`pnpm check:seo [目录]`、`pnpm measure <URL…>`（本机 Chrome 按 Lighthouse 的节流实测）。Astro 遥测由脚本关闭。
- 部署：构建后在根目录 `wrangler deploy -c apps/site/wrangler.jsonc`，Cloudflare Workers 只托管静态文件，自定义域 `latch.codes` 与 `www.latch.codes`；`wrangler login` 由所有者本人完成，配置里没有账户 ID 或秘密。
- 图片与视频：`public/img`、`public/video`、`public/og`、图标、`src/pics.json` 与 `src/hero.json` 由仓库外的生成脚本，从测试 Host 跑出的演示截图与录屏生成，不手改，`.oxfmtrc.json` 也不格式化它们。文件名带内容哈希，`public/_headers` 让 `/img`、`/video` 长期缓存；换图就换名。
- 插件市场与工作台共享 `examples/marketplace/` 的四款精选封面及其样例数据。首屏沿用「发布检查记录」的封面，其他插件按 ID 生成纹样。

## 不变量

- 只有深色，一套主题。
- 每个可见字符串在 `src/i18n.ts`，中英两套都写；页面按语言各渲染一次，搜索引擎与不运行脚本的访客拿到的已是对应语言。
- 链接只在 `src/config.ts` 的 `LINKS`。为空时按钮提示即将开放，不写假地址。
- 发布的插件包只读取目录声明的普通文件，拒绝符号链接和硬链接（`test/build.test.ts`）。
- 只展示真实功能：不编造数字、引语、用户或公司标志；`public/brands` 只放 Latch 真正支持的 Agent。
- 动画遵守 `prefers-reduced-motion`；不运行脚本时内容完整可读，脚本只切换状态，静态替代只在 html 带 js 类时隐藏。
- 性能：不加运行时框架或第三方脚本；首屏外的图片延后加载，首屏影片在页面空闲后才下载。`pnpm measure` 的手机档 LCP 不超过 1 s、CLS 为 0、TBT 不超过 50 ms；首屏不含视频不超过 250 KB，首屏影片桌面合计不超过 1.5 MB、手机不超过 1 MB。

`test/build.test.ts` 用真实 Astro 构建到临时目录，再按 `scripts/seo-check.ts` 检查：标题与描述唯一且长度合适、canonical、hreflang 三项、Open Graph、一个 h1、图片 alt、内链与锚点、sitemap、robots，404 不收录。
