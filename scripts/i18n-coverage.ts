import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseAst } from 'vite'

const SCOPE = ['apps/web/src', 'packages/ui/src', 'apps/desktop/src'] as const
const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/u
const DECLARATION = /\.d\.[cm]?ts$/u
const HAN = /\p{Script=Han}/u

const ALLOWANCES = [
  {
    path: 'apps/web/src/core/contentHash.ts',
    text: /^\n…（内容过长，已截断）$/u,
    reason: 'Recognizes the suffix ACP appends to a clipped diff side.',
  },
  {
    path: 'apps/web/src/core/contentHash.ts',
    text: /^新内容哈希$/u,
    reason: 'Names a line shared with the signed confirmation preview.',
  },
  {
    path: 'apps/web/src/panel/changes/model.ts',
    text: /^分离于$/u,
    reason: 'Recognizes the Host label for a detached HEAD.',
  },
  {
    path: 'apps/web/src/core/agentCreation.ts',
    text: /^无法读取$/u,
    reason: 'The request ID sentinel used when local creation state cannot be read.',
  },
  {
    path: 'apps/web/src/core/enrollment.ts',
    text: /^(浏览器|Mac 上的 Latch| 上的 )$/u,
    reason: 'Default enrollment names passed to the Host and shown on the signed confirmation.',
  },
  {
    path: 'apps/web/src/core/sessionDrafts.ts',
    text: /^（引用时文件：$/u,
    reason: 'Recognizes an embedded reference in draft text.',
  },
  {
    path: 'apps/web/src/forkChoice.ts',
    text: /^请接着这个会话继续。$/u,
    reason: 'The model receives this default continuation prompt verbatim.',
  },
  {
    path: 'apps/desktop/src/computers.cjs',
    text: /^这台 Mac$/u,
    reason: 'Fallback for the local computer DTO. The client labels it by the local flag.',
  },
  {
    path: 'apps/desktop/src/main.cjs',
    text: /^无法创建命令行链接，请检查 ~\/\.local\/bin 的权限。$/u,
    reason: 'The shell response keeps its source wording. Settings select language by the CLI link failure code.',
  },
  {
    path: 'apps/desktop/src/proxy.cjs',
    text: /^（位置参数）$/u,
    reason: 'The rejected positional argument label used in startup diagnostics.',
  },
]

/** Exact fragments in stored references, tool reports, and model input. New UI text in these files is still checked. */
const SOURCE_FRAGMENTS: Readonly<Record<string, { reason: string; values: readonly string[] }>> = {
  'apps/web/src/agents/opening.ts': {
    reason: 'These are the canonical prompts inserted into the Agent chat draft.',
    values: [
      '」上次运行得怎么样？结果在哪？',
      '」每次会做什么？',
      '每个工作日早上 9 点，帮我',
      '看看「',
      '」里有什么，挑要紧的说。',
      '你的文件夹里现在有什么？列给我看。',
      '帮我跑一下 ',
      '记住：',
      '你能帮我做什么？举三个例子。',
      '你在这台电脑上能用哪些文件和工具？',
    ],
  },
  'apps/web/src/agents/scheduleModel.ts': {
    reason: 'Carries the original quotation and truncation markers into a new conversation.',
    values: ['…（已截断）', '文件：', '上次成果「'],
  },
  'apps/web/src/plugin-pages/AppFrame.tsx': {
    reason: 'Stable frame diagnostics recorded by the Host; presentation uses a separate phase.',
    values: [
      '页面 15 秒内没有显示',
      '页面框 15 秒内没有就绪',
      '页面框离开了运行环境',
      '页面代码超过 2 MiB',
      '页面代码取不到',
      '页面发来无法识别的消息',
      '页面消息无法读取',
    ],
  },
  'apps/web/src/plugin-pages/AppsPage.tsx': {
    reason: 'These two prefixes annotate raw plugin diagnostics that are sent to the Host.',
    values: ['数据更新失败：', '新版本没有打开，回到上一个版本：'],
  },
  'apps/web/src/plugin-pages/parentBridge.ts': {
    reason: 'Sent only as a diagnostic; the plugin receives the original error code.',
    values: ['等你处理的会话请从列表打开'],
  },
  'apps/web/src/plugin-pages/previewBridge.ts': {
    reason: 'Fixed fictional sessions returned by the page preview bridge in place of user records.',
    values: ['整理发布说明', '示例项目', '修复登录页的报错', '检查依赖更新', '另一个项目'],
  },
  'apps/web/src/settings/NewAppCard.tsx': {
    reason: 'The generated app instructions and build diagnostics go to the model as a draft.',
    values: [
      'Latch 构建 latch-app/ 没通过（',
      ' 条）。请按下面的诊断修改，只改 latch-app/ 里的文件：\n\n```\n',
      '\n…另有 ',
      ' 条',
      '做一个页面：',
      '\n\n按 latch-app/README.md 写这个 Latch 应用，只改 latch-app/ 里的文件。',
    ],
  },
  'apps/web/src/components/ClientPluginPanel.tsx': {
    reason: 'The plugin receives this fixed API error after its panel closes.',
    values: ['面板已关闭。'],
  },
  'apps/web/src/components/InlineConfirm.tsx': {
    reason: 'Matches the signed server-authorization preview label.',
    values: ['授权服务器'],
  },
  'apps/web/src/components/SubagentRow.tsx': {
    reason: 'Recognizes the original unnamed-subagent placeholder before selecting display copy.',
    values: ['子 Agent'],
  },
  'apps/web/src/components/Transcript.tsx': {
    reason: 'The model receives this continuation instruction verbatim.',
    values: ['请接着这个会话继续。'],
  },
  'apps/web/src/settings/PluginsSettings.tsx': {
    reason: 'Matches the original label and description of a registered built-in plugin before local presentation.',
    values: [
      '向你提问',
      '内置 Agent 的选择题与多题向导；回答仅交回当前会话。',
      '浏览器',
      '内置 Agent 经这台 Mac 的 Latch 桌面端操作「浏览器」页签：只在本机地址上。',
      '设备',
      '内置 Agent 经 xcrun simctl 与 devicectl 查看和操作这台 Mac 上的 iOS 模拟器；点按与按键只给完全访问的外部 Harness 会话，不启动或关闭设备。',
      '项目文件',
      '列出、读取和编辑项目各文件夹中的文件；每次写入需要审批，节点私有数据不可访问。',
      '安全文件工具',
      '需要审批的报告写入，以及固定 30 秒的可取消任务；文件只能写入执行节点的 artifacts 目录。',
      '确定性演示模型',
      '无需 API Key；通过真实工具、审批与文件产物验证执行流程。用量为演示值。',
    ],
  },
  'apps/web/src/composer/ApprovalDrawer.tsx': {
    reason: 'Recognizes existing tool headings and a Harness plan prefix.',
    values: ['写入 ', '写入文件 ', '计划：', '该工具可能修改项目文件或产生外部副作用，需要你确认本次操作。', '拒绝', '写入文件'],
  },
  'apps/web/src/composer/slash-match.ts': {
    reason: 'These are pinyin sorting anchors for the Chinese slash index.',
    values: [
      '阿',
      '八',
      '嚓',
      '哒',
      '妸',
      '发',
      '旮',
      '哈',
      '讥',
      '咔',
      '垃',
      '妈',
      '拿',
      '噢',
      '啪',
      '期',
      '然',
      '撒',
      '塌',
      '挖',
      '昔',
      '压',
      '匝',
    ],
  },
  'apps/web/src/panel/browser/BrowserPanel.tsx': {
    reason: 'Generated screenshot filenames are preserved in the draft.',
    values: ['元素', '截图'],
  },
  'apps/web/src/panel/browser/model.ts': {
    reason: 'These markers belong to the page evidence inserted into a draft.',
    values: [
      '[已隐藏]',
      '（页面提供的内容）',
      '浏览器控制台',
      '浏览器网络',
      '页面：',
      '选择器：',
      '标签：',
      '文字：',
      '尺寸：',
      '元素 · ',
      '（页面提供的内容）\n\n```text\n',
    ],
  },
  'apps/web/src/panel/delivery/model.ts': {
    reason: 'These terms are written to an editable, model-bound Git draft.',
    values: [
      '合并',
      '变基',
      '拣选',
      '还原',
      '，退出码 ',
      '推送前的钩子 ',
      ' 没通过',
      '，没有推送：',
      '提交钩子 ',
      '，没有生成提交：',
      '行内评论',
      '审阅',
      '评论',
      '批准',
      '要求修改',
      '已撤销的审阅',
      ' 的检查 ',
      ' 失败',
      '（没有正文）',
      '\n（还有 ',
      ' 个没有列出）',
      '仓库正在',
      '，这些文件有冲突：\n\n',
      '\n\n请解决这些冲突，保留两边需要的改动；解决后暂存这些文件并完成这次',
      '），再告诉我结果。不要中止，也不要强制推送。',
      '分支 ',
      ' 与上游 ',
      ' 已分叉：这里有 ',
      ' 个上游没有的提交，上游有 ',
      ' 个这里没有的提交。请把上游的提交整合进来，用合并还是变基先问我；有冲突就解决。不要强制推送。',
    ],
  },
  'apps/web/src/panel/device/annotate.ts': {
    reason: 'Generated attachment filenames are part of existing references.',
    values: ['-标注.'],
  },
  'apps/web/src/panel/terminal/TerminalPanel.tsx': {
    reason: 'Identifies a terminal excerpt inserted into a draft.',
    values: ['终端 '],
  },
  'apps/web/src/panel/terminal/model.ts': {
    reason: 'Marks earlier output omitted from a quoted terminal transcript.',
    values: ['（较早的输出未包含）'],
  },
  'apps/web/src/preview/csv.ts': {
    reason: 'The canonical sheet name remains stable in quotes and copied text.',
    values: ['表格'],
  },
  'apps/web/src/preview/office-frame.ts': {
    reason: 'Notes extraction keeps its canonical marker when the visible controls change language.',
    values: ['备注'],
  },
  'apps/web/src/preview/quote.ts': {
    reason: 'The draft carries these stable file and document reference markers.',
    values: ['选中内容', '第 ', ' 页', '[引用 ', '时间未知', '\n（引用时文件：', ' bytes，更新于 '],
  },
  'apps/web/src/preview/xlsx.ts': {
    reason: 'The display maps these original sheet and cell values separately from quotes.',
    values: ['工作表 ', '无缓存值'],
  },
}

const SOURCE_SYMBOLS: Readonly<Record<string, readonly string[]>> = {
  // Browser-provider results are serialized for the Agent. Its separate activity copy is translated.
  'apps/desktop/src/browser-agent.cjs': ['agentWorld', 'targetName', 'note', 'TOOLS'],
  // These are codes' raw diagnostics. Electron sends the same source text and the Web layer reads the code.
  'apps/desktop/src/computers.cjs': ['nameFromOrigin', 'READ_ONLY', 'add'],
  'apps/desktop/src/credentials.cjs': ['NO_SECURE_STORAGE'],
  'apps/desktop/src/folders.cjs': ['UNPRINTABLE_MESSAGE', 'INVALID_MESSAGE'],
  'apps/desktop/src/host.cjs': ['inspectHostState'],
  'apps/desktop/src/main.cjs': ['deviceNameHere'],
  'apps/desktop/src/proxy.cjs': ['NOT_ENROLLED', 'HOST_UNAVAILABLE', 'LINK_MANAGED', 'COPY_FAILED'],
  'apps/desktop/src/remote-proxy.cjs': ['REMOTE_MANAGED', 'STATE_MESSAGES', 'STATE_UNAVAILABLE'],
}
const DESKTOP_WIRE_CALLS = new Set(['Error', 'ProxyError', 'RemoteError', 'errorResponse', 'refusal'])

const LOG_METHODS = new Set(['log', 'info', 'warn', 'error', 'debug'])
const TYPE_WRAPPERS = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression'])

type Node = { type: string; start: number; [field: string]: unknown }
const isNode = (value: unknown): value is Node => typeof value === 'object' && value !== null && typeof (value as Node).type === 'string'

function isLogCall(node: Node): boolean {
  if (node.type !== 'CallExpression' || !isNode(node.callee) || node.callee.type !== 'MemberExpression') return false
  const { object, property } = node.callee
  if (!isNode(object) || object.name !== 'console' || !isNode(property)) return false
  const method = node.callee.computed ? property.value : property.name
  return typeof method === 'string' && LOG_METHODS.has(method)
}

function keyOf(node: Node): unknown {
  const key = node.key
  return isNode(key) ? (key.name ?? key.value) : undefined
}

function isSourceText(path: string, node: Node): boolean {
  const callee = isNode(node.callee) ? node.callee.name : undefined
  if (!path.startsWith('apps/desktop/src/')) return false
  if (node.type === 'CallExpression' && callee === 'log') return true
  if (node.type === 'CallExpression' && callee === 'fatal' && path === 'apps/desktop/src/main.cjs') return true
  if ((node.type === 'CallExpression' || node.type === 'NewExpression') && typeof callee === 'string' && DESKTOP_WIRE_CALLS.has(callee))
    return true
  const declaration = node.type === 'FunctionDeclaration' || node.type === 'VariableDeclarator' ? node.id : undefined
  return isNode(declaration) && typeof declaration.name === 'string' && (SOURCE_SYMBOLS[path]?.includes(declaration.name) ?? false)
}

function wireMessage(node: Node, property: unknown): boolean {
  return (
    node.type === 'ObjectExpression'
    && isNode(property)
    && keyOf(property) === 'message'
    && Array.isArray(node.properties)
    && node.properties.some(item => isNode(item) && keyOf(item) === 'error')
  )
}

/** Finds Chinese string, template and JSX text outside the bilingual copy tables. */
export function pendingText(path: string, source: string): Array<{ line: number; text: string }> {
  const found: Array<{ line: number; text: string }> = []

  const add = (node: Node, text: string) => {
    if (
      !HAN.test(text)
      || SOURCE_FRAGMENTS[path]?.values.includes(text)
      || ALLOWANCES.some(allowance => allowance.path === path && allowance.text.test(text))
    )
      return
    found.push({ line: source.slice(0, node.start).split('\n').length, text })
  }

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const node of value) visit(node)
      return
    }
    if (!isNode(value)) return
    if (TYPE_WRAPPERS.has(value.type)) {
      visit(value.expression)
      return
    }
    if (value.type.startsWith('TS') || value.type === 'ImportDeclaration' || value.type === 'ImportExpression') return
    if ((value.type === 'ExportNamedDeclaration' || value.type === 'ExportAllDeclaration') && value.source) return
    if (
      isSourceText(path, value)
      || isLogCall(value)
      || (value.type === 'CallExpression' && isNode(value.callee) && value.callee.name === 'defineCopy')
    )
      return

    if (value.type === 'Literal' && typeof value.value === 'string') add(value, value.value)
    else if (value.type === 'JSXText') add(value, value.value as string)
    else if (value.type === 'TemplateElement') {
      const { cooked, raw } = value.value as { cooked: string | null; raw: string }
      add(value, cooked ?? raw)
    }

    for (const [field, child] of Object.entries(value)) {
      if (field === 'typeAnnotation' || field === 'returnType' || field === 'typeArguments' || field === 'typeParameters') continue
      if (value.type === 'Property' && field === 'key' && !value.computed) continue
      if (field === 'properties' && path.startsWith('apps/desktop/src/') && Array.isArray(child)) {
        for (const property of child) if (!wireMessage(value, property)) visit(property)
        continue
      }
      visit(child)
    }
  }

  visit(parseAst(source, { lang: path.endsWith('x') ? 'tsx' : 'ts' }))
  return found
}

async function sourcesUnder(root: string, directory: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = posix.join(directory, entry.name)
    if (entry.isDirectory() && !entry.name.startsWith('.runtime')) files.push(...(await sourcesUnder(root, path)))
    else if (entry.isFile() && SOURCE.test(entry.name) && !DECLARATION.test(entry.name)) files.push(path)
  }
  return files
}

export async function scanPending(root: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  for (const directory of SCOPE) {
    for (const path of (await sourcesUnder(root, directory)).sort()) {
      const count = pendingText(path, await readFile(join(root, path), 'utf8')).length
      if (count > 0) counts[path] = count
    }
  }
  return counts
}

type Counts = Readonly<Record<string, number>>
type Change = { path: string; previous: number; current: number }

/** Counts can go down per file. A reduction elsewhere cannot pay for new pending copy. */
export function comparePending(previous: Counts, current: Counts): { increased: Change[]; reduced: Change[] } {
  const increased: Change[] = []
  const reduced: Change[] = []
  const paths = new Set([...Object.keys(previous), ...Object.keys(current)])
  for (const path of [...paths].sort()) {
    const before = Object.hasOwn(previous, path) ? previous[path]! : 0
    const after = Object.hasOwn(current, path) ? current[path]! : 0
    if (after > before) increased.push({ path, previous: before, current: after })
    else if (after < before) reduced.push({ path, previous: before, current: after })
  }
  return { increased, reduced }
}

async function check(root: string, args: readonly string[]): Promise<boolean> {
  const path = join(root, 'scripts/i18n-pending.json')
  const counts = await scanPending(root)
  const json = JSON.stringify(counts, null, 2) + '\n'
  if (args.includes('--report')) {
    process.stdout.write(json)
    return true
  }
  if (args.includes('--init')) {
    await writeFile(path, json, { flag: 'wx' })
    return true
  }

  const previous = JSON.parse(await readFile(path, 'utf8')) as Counts
  const { increased, reduced } = comparePending(previous, counts)
  for (const { path, previous, current } of increased) console.error(`${path}: ${previous} → ${current} 处待迁移文案`)
  if (increased.length > 0) return false
  if (args.includes('--write')) {
    await writeFile(path, json)
    return true
  }
  if (reduced.length === 0) return true
  console.error('待迁移文案已减少。请运行 pnpm i18n:coverage -- --write 更新名单。')
  return false
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (!(await check(fileURLToPath(new URL('..', import.meta.url)), process.argv.slice(2)))) process.exitCode = 1
}
