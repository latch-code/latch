import { posix } from 'node:path'
import { isMap, isScalar, isSeq, parseDocument } from 'yaml'
import type { Change, Repository } from './repository.ts'

/**
 * Size limits for the agent instructions, in UTF-8 bytes. Codex joins the AGENTS.md files on the path from the
 * repository root to its working directory and silently drops whatever exceeds 32 KiB, so every such path stays well
 * below that, and the root leaves room for two levels of project instructions under it. Chinese text takes three bytes
 * a character, which is why the limits are bytes, not lines.
 */
export const BUDGET = { root: 16 * 1024, project: 4 * 1024, path: 24 * 1024 } as const

/** The whole content of a CLAUDE.md next to a project's AGENTS.md: Claude Code reads CLAUDE.md, which imports it. */
const CLAUDE_IMPORT = '@AGENTS.md\n'

/** Skills live once in `.agents/skills/<name>/`; `.claude/skills/<name>` is a relative link to that directory. */
export const SKILLS_DIR = '.agents/skills'
export const SKILL_LINKS_DIR = '.claude/skills'
export const skillLinkTarget = (name: string): string => `../../${SKILLS_DIR}/${name}`

/** File types checked by name alone (no directory): source and text files a repository path can name. */
const BARE_NAME = /\.(?:ts|tsx|mts|cts|js|mjs|cjs|swift|css|html|md|ya?ml)$/u
/** File types that make a token with a `/` a path even when its first segment does not exist. */
const PATH_EXTENSION = /\.(?:ts|tsx|mts|cts|js|mjs|cjs|json|jsonc|md|ya?ml|swift|css|html|png|svg|toml|txt)$/u
const TEST_REFERENCE = /^([^\s#]+\.(?:test|e2e)\.ts)#(.+)$/u
/** Placeholders, globs, URLs, assignments, home-relative and absolute paths are not repository paths. */
const NOT_A_PATH = /[<>*?$=~|\\]|:\/\/|^[/@#%-]|^\d/u
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const SHELL_FENCE = /^(?:sh|bash|shell|console|zsh)$/u

interface Line {
  number: number
  text: string
}

interface MarkdownParts {
  /** Lines outside the front matter and fenced code blocks. */
  prose: Line[]
  /** Lines of fenced code blocks whose info string names a shell. */
  shell: Line[]
  /** The YAML between the leading `---` lines, when the file has front matter. */
  frontmatter?: string
}

function parseMarkdown(text: string): MarkdownParts {
  const lines = text.split('\n')
  const parts: MarkdownParts = { prose: [], shell: [] }
  let start = 0
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1)
    if (end > 0) {
      parts.frontmatter = lines.slice(1, end).join('\n')
      start = end + 1
    }
  }
  let fence: { marker: string; shell: boolean } | undefined
  for (let index = start; index < lines.length; index++) {
    const content = lines[index] ?? ''
    const line = { number: index + 1, text: content }
    const opening = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/u.exec(content)
    if (fence) {
      if (opening && opening[1].startsWith(fence.marker) && content.trim() === opening[1]) fence = undefined
      else if (fence.shell) parts.shell.push(line)
      continue
    }
    if (opening) {
      fence = { marker: opening[1], shell: SHELL_FENCE.test(opening[2] ?? '') }
      continue
    }
    parts.prose.push(line)
  }
  return parts
}

/** Inline code spans of one line, and the line with each span blanked out. */
function codeSpans(text: string): { spans: string[]; rest: string } {
  const spans: string[] = []
  let rest = ''
  let index = 0
  while (index < text.length) {
    const open = text.indexOf('`', index)
    if (open < 0) break
    let length = 1
    while (text[open + length] === '`') length++
    const marker = '`'.repeat(length)
    let close = text.indexOf(marker, open + length)
    while (close >= 0 && text[close + length] === '`') close = text.indexOf(marker, close + length + 1)
    if (close < 0) {
      rest += text.slice(index, open + length)
      index = open + length
      continue
    }
    let content = text.slice(open + length, close)
    if (content.length > 2 && content.startsWith(' ') && content.endsWith(' ')) content = content.slice(1, -1)
    spans.push(content)
    rest += `${text.slice(index, open)}${' '.repeat(close + length - open)}`
    index = close + length
  }
  return { spans, rest: rest + text.slice(index) }
}

const LINK = /!?\[(?:[^[\]]|\[[^[\]]*\])*\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/gu

function markdownLinks(text: string): string[] {
  return [...text.matchAll(LINK)].map(match => match[1].replace(/^<|>$/gu, ''))
}

/** Anchors GitHub gives the headings of a Markdown file (github-slugger): lower case, punctuation removed, spaces to `-`. */
export function headingAnchors(text: string): Set<string> {
  const anchors = new Set<string>()
  const counts = new Map<string, number>()
  for (const { text: line } of parseMarkdown(text).prose) {
    const heading = /^ {0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/u.exec(line)
    if (!heading) continue
    const plain = heading[1]
      .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, '$1')
      .replace(/`+([^`]*)`+/gu, '$1')
      .replace(/\*/gu, '')
    const base = plain
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
      .replace(/ /gu, '-')
    const seen = counts.get(base) ?? 0
    counts.set(base, seen + 1)
    anchors.add(seen === 0 ? base : `${base}-${seen}`)
  }
  return anchors
}

/** `a/{b,c}.ts` → `a/b.ts`, `a/c.ts`; several groups expand in turn. */
function expandBraces(token: string): string[] {
  const match = /\{([^{}]*)\}/u.exec(token)
  if (!match) return [token]
  const head = token.slice(0, match.index)
  const tail = token.slice(match.index + match[0].length)
  return match[1].split(',').flatMap(choice => expandBraces(`${head}${choice}${tail}`))
}

/** Whitespace and CJK punctuation separate the words of a code span or a shell line. */
function words(text: string): string[] {
  return text
    .split(/[\s，。；：、（）「」《》！？]+/u)
    .map(word => word.replace(/^[('"[]+|[)'"\],.:;]+$/gu, '').replace(/^\.\//u, ''))
    .filter(word => word !== '')
}

function isAgentDoc(path: string): boolean {
  const name = posix.basename(path)
  return name === 'AGENTS.md' || name === 'CLAUDE.md' || (name === 'SKILL.md' && path.startsWith(`${SKILLS_DIR}/`))
}

const bytes = (text: string): number => Buffer.byteLength(text, 'utf8')
const directory = (path: string): string => posix.dirname(path)

/** Ancestor directories of `dir`, from the repository root (`.`) down to `dir` itself. */
function ancestry(dir: string): string[] {
  if (dir === '.') return ['.']
  const parts = dir.split('/')
  return ['.', ...parts.map((_, index) => parts.slice(0, index + 1).join('/'))]
}

/** Resolves `path` inside the repository; undefined when it would leave it. */
function inside(base: string, path: string): string | undefined {
  const joined = posix.normalize(posix.join(base, path)).replace(/\/$/u, '')
  return joined === '..' || joined.startsWith('../') ? undefined : joined === '' ? '.' : joined
}

export interface CheckOptions {
  /** Directories of the workspace projects, each of which the root AGENTS.md must name. */
  projects?: readonly string[]
}

export interface DocSources {
  path: string
  description: string
  /** Repository paths (files or directories) whose changes may call for an update of the document. */
  sources: string[]
}

/** The front matter of every `docs/*.md`: `description` and `sources`, which `pnpm docs:affected` reads. */
export async function readDocSources(repo: Repository): Promise<{ docs: DocSources[]; problems: string[] }> {
  const docs: DocSources[] = []
  const problems: string[] = []
  for (const path of [...repo.files].filter(file => /^docs\/[^/]+\.md$/u.test(file)).toSorted()) {
    const { frontmatter } = parseMarkdown(await repo.read(path))
    if (frontmatter === undefined) {
      problems.push(`${path}：缺少开头的 front matter（description 与 sources）`)
      continue
    }
    const document = parseDocument(frontmatter)
    const description = isMap(document.contents) ? document.get('description') : undefined
    const list = isMap(document.contents) ? document.get('sources', true) : undefined
    const sources = isSeq(list) ? list.items.map(item => (isScalar(item) && typeof item.value === 'string' ? item.value : '')) : []
    if (document.errors.length > 0) problems.push(`${path}：front matter 无法解析（${document.errors[0].message}）`)
    if (typeof description !== 'string' || description.trim() === '') problems.push(`${path}：front matter 缺少 description`)
    if (sources.length === 0) problems.push(`${path}：front matter 的 sources 应为非空的路径列表`)
    for (const source of sources) {
      const normalized = source === '' ? undefined : inside('.', source)
      if (normalized === undefined || (!repo.files.has(normalized) && !repo.dirs.has(normalized)))
        problems.push(`${path}：sources 中的 ${JSON.stringify(source)} 不存在`)
    }
    docs.push({ path, description: typeof description === 'string' ? description : '', sources: sources.filter(source => source !== '') })
  }
  return { docs, problems }
}

/** Compares `.claude/skills` with `.agents/skills`: one link per skill, nothing else. */
async function skillProblems(repo: Repository): Promise<string[]> {
  const problems: string[] = []
  const skills = [...repo.dirs].filter(dir => directory(dir) === SKILLS_DIR).toSorted()
  for (const dir of skills) {
    const name = posix.basename(dir)
    const file = `${dir}/SKILL.md`
    if (!repo.files.has(file)) {
      problems.push(`${dir}：缺少 SKILL.md`)
      continue
    }
    const { frontmatter } = parseMarkdown(await repo.read(file))
    const document = frontmatter === undefined ? undefined : parseDocument(frontmatter)
    const field = (key: string): unknown => (document && isMap(document.contents) ? document.get(key) : undefined)
    if (field('name') !== name) problems.push(`${file}：front matter 的 name 应为目录名 ${name}`)
    if (!SKILL_NAME.test(name) || name.length > 64) problems.push(`${file}：技能名只能用小写字母、数字与单个连字符，最多 64 个字符`)
    const description = field('description')
    if (typeof description !== 'string' || description.trim() === '' || description.length > 1024)
      problems.push(`${file}：front matter 的 description 应为 1 到 1024 个字符`)
  }

  const names = new Set(skills.filter(dir => repo.files.has(`${dir}/SKILL.md`)).map(dir => posix.basename(dir)))
  const entries = new Set<string>()
  for (const path of [...repo.files, ...repo.dirs]) if (directory(path) === SKILL_LINKS_DIR) entries.add(posix.basename(path))
  for (const name of names) {
    const path = `${SKILL_LINKS_DIR}/${name}`
    const target = await repo.link(path)
    if (target === undefined)
      problems.push(`${path}：${entries.has(name) ? '应是' : '缺少'}指向 ${skillLinkTarget(name)} 的链接，运行 pnpm agents:sync`)
    else if (target !== skillLinkTarget(name))
      problems.push(`${path}：链接指向 ${target}，应为 ${skillLinkTarget(name)}，运行 pnpm agents:sync`)
  }
  for (const name of [...entries].filter(entry => !names.has(entry)).toSorted())
    problems.push(`${SKILL_LINKS_DIR}/${name}：${SKILLS_DIR} 中没有这个技能；技能只写在 ${SKILLS_DIR}，运行 pnpm agents:sync`)
  return problems
}

interface Finder {
  exists(path: string): boolean
  /** The repository path that `token`, written in a file in `base`, names: relative to `base`, the root or as a suffix. */
  resolve(base: string, token: string): string | undefined
}

function finder(repo: Repository): Finder {
  const all = [...repo.files, ...repo.dirs]
  const exists = (path: string) => path === '.' || repo.files.has(path) || repo.dirs.has(path)
  return {
    exists,
    resolve(base, token) {
      for (const candidate of [inside(base, token), inside('.', token)]) if (candidate !== undefined && exists(candidate)) return candidate
      const suffix = `/${token.replace(/\/$/u, '')}`
      return all.find(path => path.endsWith(suffix))
    },
  }
}

async function packageNames(repo: Repository): Promise<Set<string>> {
  const names = new Set<string>()
  for (const file of repo.files) {
    if (posix.basename(file) !== 'package.json') continue
    const manifest: unknown = JSON.parse(await repo.read(file))
    if (typeof manifest !== 'object' || manifest === null) continue
    if ('name' in manifest && typeof manifest.name === 'string') names.add(manifest.name)
    for (const [field, deps] of Object.entries(manifest)) {
      if (!/^(?:d|devD|peerD|optionalD)ependencies$/u.test(field) || typeof deps !== 'object' || deps === null) continue
      for (const name of Object.keys(deps)) names.add(name)
    }
  }
  return names
}

/** Every structural problem of the agent instructions, skills and mechanism documents; empty when all hold. */
export async function checkAgentDocs(repo: Repository, options: CheckOptions = {}): Promise<string[]> {
  const problems: string[] = []
  const find = finder(repo)
  const markdown = [...repo.files].filter(file => file.endsWith('.md')).toSorted()
  const texts = new Map<string, string>()
  for (const file of markdown) texts.set(file, await repo.read(file))
  const text = (file: string) => texts.get(file) ?? ''

  // AGENTS.md and CLAUDE.md come in pairs.
  const agents = markdown.filter(file => posix.basename(file) === 'AGENTS.md')
  for (const file of agents) {
    const claude = posix.join(directory(file), 'CLAUDE.md')
    if (!repo.files.has(claude)) problems.push(`${file}：同一目录缺少 CLAUDE.md（内容为 ${JSON.stringify(CLAUDE_IMPORT)}）`)
    else if (directory(file) === '.' ? !text(claude).startsWith(CLAUDE_IMPORT) : text(claude) !== CLAUDE_IMPORT)
      problems.push(
        `${claude}：${directory(file) === '.' ? `第一行应为 ${CLAUDE_IMPORT.trim()}` : `内容应恰为 ${JSON.stringify(CLAUDE_IMPORT)}`}`,
      )
  }
  for (const file of markdown.filter(path => posix.basename(path) === 'CLAUDE.md'))
    if (!repo.files.has(posix.join(directory(file), 'AGENTS.md'))) problems.push(`${file}：同一目录没有 AGENTS.md`)

  // Byte budgets, per file and per root-to-leaf path.
  const sizes = new Map(agents.map(file => [directory(file), bytes(text(file))]))
  if (!sizes.has('.')) problems.push('仓库根缺少 AGENTS.md')
  for (const [dir, size] of sizes) {
    const limit = dir === '.' ? BUDGET.root : BUDGET.project
    const file = posix.join(dir, 'AGENTS.md')
    if (size > limit)
      problems.push(`${file}：${size} 字节，超过 ${limit} 字节；把只对子目录有效的规则移到子目录，或把机制说明移进 docs/ 并留链接`)
    const chain = ancestry(dir).filter(ancestor => sizes.has(ancestor))
    const total = chain.reduce((sum, ancestor) => sum + sizes.get(ancestor)!, 0)
    if (total > BUDGET.path)
      problems.push(`${file}：从仓库根到这里的 AGENTS.md 合计 ${total} 字节（${chain.join(' → ')}），超过 ${BUDGET.path} 字节`)
  }

  // The root map names every workspace project.
  const root = text('AGENTS.md')
  for (const dir of options.projects ?? []) {
    if (dir === '.') continue
    if (!codeSpansOf(root).some(span => span.replace(/\/$/u, '') === dir))
      problems.push(`AGENTS.md：代码地图没有列出 workspace 项目 \`${dir}/\``)
  }

  // Links in every Markdown file.
  const anchors = new Map<string, Set<string>>()
  const anchorsOf = (file: string) => {
    let set = anchors.get(file)
    if (!set) anchors.set(file, (set = headingAnchors(text(file))))
    return set
  }
  for (const file of markdown) {
    for (const { number, text: line } of parseMarkdown(text(file)).prose) {
      for (const target of markdownLinks(codeSpans(line).rest)) {
        if (/^[a-z][a-z0-9+.-]*:/iu.test(target)) continue
        const [path = '', anchor] = target.split('#', 2)
        const resolved = path === '' ? file : inside(directory(file), safeDecode(path))
        const where = `${file}:${number}`
        if (resolved === undefined || !find.exists(resolved)) {
          problems.push(`${where}：链接 ${target} 指向不存在的路径`)
          continue
        }
        if (anchor !== undefined && anchor !== '' && resolved.endsWith('.md') && !anchorsOf(resolved).has(safeDecode(anchor).toLowerCase()))
          problems.push(`${where}：链接 ${target} 的锚点在 ${resolved} 中没有对应的标题`)
      }
    }
  }

  // Paths and tests that the agent instructions name.
  const packages = await packageNames(repo)
  const unresolved: Array<{ where: string; token: string; candidates: string[] }> = []
  for (const file of markdown.filter(isAgentDoc)) {
    const base = directory(file)
    const parts = parseMarkdown(text(file))
    const tokens: Array<{ number: number; token: string }> = []
    for (const { number, text: line } of parts.prose) {
      for (const span of codeSpans(line).spans) {
        const test = TEST_REFERENCE.exec(span.trim())
        if (test) {
          const problem = await testProblem(repo, base, test[1], test[2])
          if (problem) problems.push(`${file}:${number}：${problem}`)
          continue
        }
        for (const word of words(span)) tokens.push({ number, token: word })
      }
    }
    for (const { number, text: line } of parts.shell) for (const word of words(line)) tokens.push({ number, token: word })

    for (const { number, token } of tokens) {
      if (NOT_A_PATH.test(token)) continue
      for (const path of expandBraces(token).map(item => item.replace(/:\d+(?:-\d+)?$/u, ''))) {
        if (!path.includes('/')) {
          if (BARE_NAME.test(path) && !find.resolve(base, path))
            unresolved.push({ where: `${file}:${number}`, token: path, candidates: [path] })
          continue
        }
        const first = path.split('/')[0]
        if (packages.has(first)) continue
        const firstExists = [inside(base, first), inside('.', first)].some(candidate => candidate !== undefined && find.exists(candidate))
        if (!firstExists && !PATH_EXTENSION.test(path)) continue
        if (find.resolve(base, path)) continue
        const candidates = [inside(base, path), inside('.', path)].filter(candidate => candidate !== undefined)
        unresolved.push({ where: `${file}:${number}`, token: path, candidates })
      }
    }
  }
  // Build output, installed packages and user data are ignored by git and need not exist in a checkout.
  const ignored = await repo.ignored([...new Set(unresolved.flatMap(item => item.candidates))])
  for (const item of unresolved) {
    if (item.candidates.some(candidate => ignored.has(candidate))) continue
    problems.push(`${item.where}：\`${item.token}\` 在仓库中不存在`)
  }

  problems.push(...(await skillProblems(repo)), ...(await readDocSources(repo)).problems)
  return problems
}

function safeDecode(text: string): string {
  try {
    return decodeURI(text)
  } catch {
    return text
  }
}

function codeSpansOf(text: string): string[] {
  return parseMarkdown(text).prose.flatMap(line => codeSpans(line.text).spans)
}

/**
 * A test that an agent instruction cites as `<file>#<name>`: the file exists (relative to the instruction or the
 * root) and each ` > `-separated part of the name is a string literal in it, as describe() and it() titles are.
 */
async function testProblem(repo: Repository, base: string, file: string, name: string): Promise<string | undefined> {
  const path = [inside(base, file), inside('.', file)].find(candidate => candidate !== undefined && repo.files.has(candidate))
  if (!path) return `测试文件 ${file} 不存在`
  const source = await repo.read(path)
  const missing = name
    .split(' > ')
    .map(part => part.trim())
    .filter(part => !["'", '"', '`'].some(quote => source.includes(`${quote}${part}${quote}`)))
  return missing.length === 0 ? undefined : `${path} 中没有名为 ${missing.map(part => JSON.stringify(part)).join('、')} 的用例或分组`
}

/** Whether `source`, a path from a document's front matter, is `path` or a directory above it. */
function covers(source: string, path: string): boolean {
  const prefix = source.replace(/\/$/u, '')
  return path === prefix || path.startsWith(`${prefix}/`)
}

export interface AffectedDoc {
  path: string
  /** The changed paths that made it a candidate. */
  because: string[]
  /** Whether the change already edits the document itself. */
  edited: boolean
}

/**
 * Documents a change may call for updating: each `docs/*.md` whose `sources` contain a changed path, and the AGENTS.md
 * of every directory above a changed file. The root AGENTS.md lists directories, so it is a candidate only when
 * directories appear or disappear.
 */
export function affectedDocs(
  docs: readonly DocSources[],
  agents: readonly string[],
  changes: readonly Change[],
  directories: { added: readonly string[]; removed: readonly string[] } = { added: [], removed: [] },
): AffectedDoc[] {
  const paths = [...new Set(changes.flatMap(change => [change.path, ...(change.from ? [change.from] : [])]))]
  const edited = new Set(changes.map(change => change.path))
  const result = new Map<string, Set<string>>()
  const add = (doc: string, path: string) => {
    if (doc === path) return
    const set = result.get(doc) ?? new Set<string>()
    set.add(path)
    result.set(doc, set)
  }
  for (const doc of docs) for (const path of paths) if (doc.sources.some(source => covers(source, path))) add(doc.path, path)
  for (const agent of agents) {
    const dir = directory(agent)
    if (dir === '.') continue
    for (const path of paths) if (path.startsWith(`${dir}/`)) add(agent, path)
  }
  if (agents.includes('AGENTS.md')) for (const dir of [...directories.added, ...directories.removed]) add('AGENTS.md', `${dir}/`)
  return [...result]
    .map(([path, because]) => ({ path, because: [...because].toSorted(), edited: edited.has(path) }))
    .toSorted((a, b) => a.path.localeCompare(b.path))
}
