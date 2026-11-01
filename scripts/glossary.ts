import { readdir, readFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { parseAst } from 'vite'

/**
 * The words the product's interface never uses (`docs/DESIGN.md`). Scans what a person can read: string literals,
 * template text and JSX text. Identifiers, comments, type positions, imports and log calls are not interface, and
 * documentation is for developers and keeps these words. Latin words match case-sensitively, so an identifier-like
 * string such as `host-desktop` is not a hit.
 */
export const BANNED_WORDS = [
  '引擎',
  '自动化',
  '例行',
  '变更',
  '助手',
  '群聊',
  '回复者',
  '工作区',
  '启动目录',
  '只聊天',
  'Provider',
  'ACP',
  '预设',
  '执行端',
  'Host',
  '本机',
  '指纹',
  '核对码',
  '回环',
  '中继',
  '直连',
  '域名',
  '出站白名单',
  '审计',
  '权限上限',
  '数据范围',
  '登记',
  '邀请',
  '启动指纹',
  '哈希',
  '只对话',
  '开发版',
  '运行 Latch 的电脑',
] as const

/** A finding's `key` is the path of names around the text: `FIXED.enrollment-denied`, or `<file>` at no name. */
export interface GlossaryAllowance {
  file: string
  /** The key, or a key prefix ending in `.` or `-`. */
  key: string
  /** Only these words are allowed there; all of them when left out. */
  words?: readonly string[]
  why: string
}

export interface GlossaryFinding {
  path: string
  line: number
  key: string
  word: string
  text: string
}

type Node = { type: string; start: number; [field: string]: unknown }

const isNode = (value: unknown): value is Node => typeof value === 'object' && value !== null && typeof (value as Node).type === 'string'
const TYPE_WRAPPERS = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression'])
const LOG_METHODS = new Set(['log', 'info', 'warn', 'error', 'debug'])

function isLogCall(node: Node): boolean {
  if (node.type !== 'CallExpression' || !isNode(node.callee) || node.callee.type !== 'MemberExpression') return false
  const { object, property } = node.callee
  return isNode(object) && object.name === 'console' && isNode(property) && LOG_METHODS.has(property.name as string)
}

/** The name a node gives what it holds: a declaration's, or a property's own (never read as text itself). */
function nameOf(node: Node): string | undefined {
  if ((node.type === 'VariableDeclarator' || node.type === 'FunctionDeclaration') && isNode(node.id))
    return node.id.name as string | undefined
  if (node.type === 'Property' && !node.computed && isNode(node.key)) {
    return node.key.type === 'Identifier' ? (node.key.name as string) : String(node.key.value)
  }
  return undefined
}

/** The readable text of one TypeScript or TSX file, each piece with the path of names around it. */
export function readableText(path: string, source: string): Array<{ key: string; line: number; text: string }> {
  const found: Array<{ key: string; line: number; text: string }> = []
  const add = (node: Node, names: readonly string[], text: string) => {
    found.push({ key: names.join('.') || '<file>', line: source.slice(0, node.start).split('\n').length, text })
  }
  const visit = (value: unknown, names: readonly string[]): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, names)
      return
    }
    if (!isNode(value)) return
    if (TYPE_WRAPPERS.has(value.type)) {
      visit(value.expression, names)
      return
    }
    if (value.type.startsWith('TS') || value.type === 'ImportDeclaration' || value.type === 'ImportExpression' || isLogCall(value)) return
    if ((value.type === 'ExportNamedDeclaration' || value.type === 'ExportAllDeclaration') && value.source) return
    if (value.type === 'Literal' && typeof value.value === 'string') add(value, names, value.value)
    else if (value.type === 'JSXText' && (value.value as string).trim() !== '') add(value, names, (value.value as string).trim())
    else if (value.type === 'TemplateElement') add(value, names, (value.value as { raw: string }).raw)
    const name = nameOf(value)
    const inner = name === undefined ? names : [...names, name]
    for (const [field, child] of Object.entries(value)) {
      if (field === 'typeAnnotation' || field === 'returnType' || field === 'typeArguments' || field === 'typeParameters') continue
      if (value.type === 'Property' && field === 'key' && !value.computed) continue
      visit(child, inner)
    }
  }
  visit(parseAst(source, { lang: path.endsWith('x') ? 'tsx' : 'ts' }), [])
  return found
}

/** 「在新会话中继续」 reads 中 + 继续, not 中继. */
const contains = (text: string, word: string) => (word === '中继' ? /中继(?!续)/u.test(text) : text.includes(word))

const allows = (allowance: GlossaryAllowance, path: string, key: string, word: string) =>
  allowance.file === path
  && (/[.-]$/u.test(allowance.key) ? key.startsWith(allowance.key) : key === allowance.key)
  && (allowance.words === undefined || allowance.words.includes(word))

export function scanGlossary(path: string, source: string, allowances: readonly GlossaryAllowance[] = []): GlossaryFinding[] {
  return readableText(path, source).flatMap(({ key, line, text }) =>
    BANNED_WORDS.filter(word => contains(text, word) && !allowances.some(allowance => allows(allowance, path, key, word))).map(word => ({
      path,
      line,
      key,
      word,
      text,
    })),
  )
}

const COPY_FILE = 'apps/web/src/core/securityCopy.ts'
const PERSONAL_COPY = 'The shell still names the personal pages; these go when those pages are removed.'
const PERSONAL_WORDS = ['助手', '群聊'] as const
const CHAT_MODE = 'The chat-only mode keeps its name until it is removed.'

/** The directories the scan covers: every page, except the personal pages. */
export const GLOSSARY_SCOPE = {
  directories: ['apps/web/src'],
  skip: ['apps/web/src/personal/'],
} as const

export const GLOSSARY_ALLOWANCES: readonly GlossaryAllowance[] = [
  {
    file: COPY_FILE,
    key: 'DEVICES_COPY.savedRelay',
    words: ['中继'],
    why: 'A relay saved by an earlier build is named only behind 「关于连接」, beside the way to remove it.',
  },
  ...['FIXED.native-relay-duplicate'].map(key => ({
    file: COPY_FILE,
    key,
    words: ['中继'],
    why: 'Only a person adding relay nodes reads it.',
  })),
  {
    file: 'apps/web/src/palette/ShellPalette.tsx',
    key: 'SETTINGS_ROWS.keywords',
    words: ['自动化'],
    why: 'Never drawn: someone searching the other common name still finds 定时任务.',
  },
  {
    file: 'apps/web/src/core/contentHash.ts',
    key: 'CONTENT_HASH_LABEL',
    words: ['哈希'],
    why: 'A line of the signed confirmation preview, shared with the macOS helper.',
  },
  ...(
    [
      ['apps/web/src/composer/Footer.tsx', 'MoreMenu', '只聊天'],
      ['apps/web/src/composer/Footer.tsx', 'FoldMenu', '只聊天'],
      ['apps/web/src/newSession/NewSessionSheet.tsx', 'NewSessionSheet', '只聊天'],
      ['apps/web/src/components/Pickers.tsx', 'ModeSwitch.title', '只对话'],
    ] as const
  ).map(([file, key, word]) => ({ file, key, words: [word], why: CHAT_MODE })),
  ...(
    [
      ['apps/web/src/settings/SettingsPage.tsx', 'sections.label'],
      ['apps/web/src/shell/ConversationView.tsx', 'ConversationView'],
      ['apps/web/src/shell/Overlays.tsx', 'Overlays.label'],
      ['apps/web/src/shell/Overlays.tsx', 'Overlays.label.'],
      ['apps/web/src/shell/useSessionController.ts', 'useSessionController.gate.text'],
      ['apps/web/src/shell/useSessionController.ts', 'useSessionController.harnessName'],
    ] as const
  ).map(([file, key]) => ({ file, key, words: PERSONAL_WORDS, why: PERSONAL_COPY })),
]

async function sourcesUnder(root: string, directory: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(join(root, directory), { withFileTypes: true, recursive: true })
  } catch {
    // A listed directory may not exist yet.
    return []
  }
  return entries
    .filter(entry => entry.isFile() && /\.tsx?$/u.test(entry.name))
    .map(entry => posix.join(entry.parentPath.slice(root.length).replaceAll('\\', '/').replace(/^\//u, ''), entry.name))
}

/** Every banned word in the scope, as the test reports them. */
export async function scanRepository(root: string): Promise<GlossaryFinding[]> {
  const directories = await Promise.all(GLOSSARY_SCOPE.directories.map(directory => sourcesUnder(root, directory)))
  const paths = directories.flat().filter(path => !GLOSSARY_SCOPE.skip.some(prefix => path.startsWith(prefix)))
  const scanned = await Promise.all(
    paths.map(async path => scanGlossary(path, await readFile(join(root, path), 'utf8'), GLOSSARY_ALLOWANCES)),
  )
  return scanned.flat()
}
