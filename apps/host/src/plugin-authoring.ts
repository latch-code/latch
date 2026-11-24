// Offline material for an explicit 创造模式 session. These references never become part of an imported draft.
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createPluginPackageTemplate } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import catalog from '../../../examples/latch.catalog.json' with { type: 'json' }
import { APP_GUIDE, APP_SDK_DTS, appSkeleton } from './app-sdk-types.ts'

const CREATOR_SKILL = `---
name: latch-plugin-authoring
description: 在 Latch 创造模式里，把会话中的工作方法、工具或交互需求写成可预览或审阅的本地插件草稿。
---

# 为这次对话制作插件

先读人的需求和当前草稿。确认谁在什么场景使用、第一次如何调用、怎样判断结果。目标明确就直接开始；缺少会改变做法的信息时再提问。修改已有作品时沿用它的插件标识、入口和已有逻辑。

## 先找能直接用的插件

读本文件旁边的 \`plugin-examples.json\`。它列出随当前版本提供的精选插件、适用任务和第一次怎么用。这里是公开目录，不代表用户已安装或启用。若已有插件基本符合需要，告诉用户插件名、哪部分能直接用，以及在「插件市场」试用的步骤。如果用户要改变已有流程或添加缺少的能力，再按需求制作或调整草稿。目录找不到匹配项时，继续下面的创作步骤。

## 选一种交付形式

- **技能**：需要让 Agent 学会可复用的工作方法。写 \`latch-plugin/latch-plugin.json\`（formatVersion 1）和清单 \`skills[].file\` 指向的 Markdown。说明适用场景、操作步骤、输出形式和完成条件。参考 \`latch-authoring/examples/skill/\`。技能正文是模型指令；能否送达由 Harness 的技能支持决定。
- **工具组合包**：需要 Agent 反复执行一项确定的操作。写同一个格式 1 清单，\`host\` 指向包内自包含的 ESM \`.mjs\`，默认导出含 \`activate(ctx)\` 的对象。在这里调用 \`ctx.registerTool\`；处理输入校验、取消与错误，完成后返回 \`{ text }\`。可以同时提供 \`skills\` 教 Agent 何时使用工具，或用 \`dataPanels\` 展示有限的文本、列表和表格。参考 \`latch-authoring/examples/tool/\`。工具供 Latch 内置 Agent 调用；该模块激活时是本机可信代码，人要先审阅源码并确认。制作不等于运行，不要自行导入、执行或安装草稿。
- **独立页面**：需要人看列表、操作按钮、输入数据，或从界面发起 Agent 会话。写 \`latch-app/latch-app.json\`（formatVersion 2，带 apps）和页面源码。参考 \`latch-authoring/examples/page/\`、\`latch-authoring/PAGES.md\` 与 \`latch-authoring/sdk.d.ts\`。使用隔离框和声明过的页面能力。这个交付目录不包含 Host 或 React 面板模块。

把能在同一包提供的技能、工具和面板放在一起。如果用户还需要一个独立的隔离页面，可以在同一会话另写页面草稿，为两个包选不同的 id，并告诉用户分别审阅和应用。保持包内相对路径，技能和有限数据不需要可执行代码。输入图像、鉴权信息、真实会话内容和本机绝对路径不作为样例打包。页面和包都不下载依赖。只改这次会话的作品，在得到本机确认的步骤由人操作。为插件选择描述其用途的稳定 id，指定名称、版本、说明，并保证清单所有入口确实存在。

## 把工作方式留给自己的 Agent

当用户说“组合工具和提示词，做自己的模式”，把反复使用的提示词写成技能；需要确定性操作时在同一个包里声明 host 工具，并在技能里写清工具名、调用条件和预期结果。工具包审阅并应用后，引导用户到「我的 Agent」打开或新建一个 Agent，在它的「设置 › 技能」选中这个技能。使用内置 Harness 的 Agent，在「可以使用」选择提供工具的插件；已经选了「全部已启用的插件」时无需再勾。用一个实际输入开始会话，核对技能和工具各自的结果。外部 Harness 只在支持 Latch 技能时接收技能，不会因此获得包里的内置工具。这个方案交付一个可重复使用的 Agent 工作方式；界面的全局模式选择由 Latch 本身定义。

## 自查并交给人

1. 逐项对照人的场景，用一个具体输入说明用户和 Agent 各做什么、会看到什么。用样例数据验证；页面只声明实际调用的能力。
2. 检查产物路径、入口、引用、UTF-8 文本与 JSON。把实际写好的文件留在工作区，不只在消息里贴一段代码。Host 的导入、页面构建和运行时审阅由 Latch 执行。
3. 告诉人插件名称、用途、可使用的 Harness，在哪里试第一次，以及本次验证到哪一步。技能或工具写好后，回到创作会话输入框旁点「审阅插件草稿」，检查正文或源码再应用。页面在同处点「查看页面草稿」，点「构建」取得样例预览，核对后再应用。也可以在本会话的「改动」里找到这些草稿。还没导入、预览或应用时如实说明。根据反馈继续修改同一份草稿。
`

const PAGE = `import { useState } from 'react'
import { defineApp, type PageProps } from '@latch/app-sdk'

function Page({ ui }: PageProps) {
  const [done, setDone] = useState(false)
  return <ui.Group title="发布检查">
    <ui.Button onClick={() => setDone(!done)}>{done ? '已核对 · 重置' : '标记已核对'}</ui.Button>
  </ui.Group>
}
export default defineApp({ page: Page })
`

/** Called only by the allocator for a freshly made folder. Publish the complete reference directory in one rename. */
export async function writePluginAuthoring(folder: { path: string }): Promise<void> {
  const staging = await mkdtemp(join(folder.path, '.latch-authoring-'))
  try {
    const write = (name: string, value: string) =>
      writeFile(join(staging, name), value, { flag: 'wx', mode: name.startsWith('examples/') ? 0o600 : 0o400 })
    await write('SKILL.md', CREATOR_SKILL)
    const listings = catalog.plugins.map(({ id, zh, en }) => ({
      id,
      zh: { name: zh.name, kind: zh.kind, summary: zh.summary, use: zh.use },
      en: { name: en.name, kind: en.kind, summary: en.summary, use: en.use },
    }))
    await write('plugin-examples.json', JSON.stringify(listings, null, 2) + '\n')
    await write('PAGES.md', APP_GUIDE)
    await write('sdk.d.ts', APP_SDK_DTS)
    await mkdir(join(staging, 'examples'))
    for (const kind of ['skill', 'tool'] as const) {
      const directory = `examples/${kind}`
      const template = createPluginPackageTemplate(kind, `example-${kind}`, kind === 'skill' ? '工作方法' : '标题格式')
      if (kind === 'tool') {
        template.manifest.skills = [{ id: 'titles', name: '标题格式', description: '把英文标题改成全大写。', file: 'SKILL.md' }]
        template.files.push({
          path: 'SKILL.md',
          content: '# 英文标题\n\n用户要求将英文标题转成全大写时，用 example_tool_uppercase 工具处理提供的文字，保留标点并报告结果。\n',
        })
      }
      await mkdir(join(staging, directory))
      await write(`${directory}/latch-plugin.json`, JSON.stringify(template.manifest, null, 2) + '\n')
      for (const file of template.files) await write(`${directory}/${file.path}`, file.content)
    }
    await mkdir(join(staging, 'examples/page'))
    await write('examples/page/latch-app.json', appSkeleton('example-page'))
    await write('examples/page/index.tsx', PAGE)
    await rename(staging, join(folder.path, 'latch-authoring'))
  } catch {
    await rm(staging, { recursive: true, force: true })
    throw new AppError(409, 'app-draft-folder', '没有写好这个会话的插件创作指南。请重试。')
  }
}
