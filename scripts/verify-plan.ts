import { posix } from 'node:path'
import type { Change } from './repository.ts'

/** `pnpm check:quick`: seconds, no tests. `pnpm check` adds knip and the unit tests. */
export const QUICK_STEPS = ['fmt:check', 'lint', 'typecheck', 'check:boundaries', 'check:agents'] as const
export const FULL_STEPS = [...QUICK_STEPS, 'knip', 'test'] as const

/** A Vitest project of vitest.config.ts: its name and the directory its include pattern starts with. */
export interface TestProject {
  name: string
  dir: string
}

/** The fixed directory part of each include pattern of the root Vitest configuration's projects. */
export function testProjects(config: unknown): TestProject[] {
  const projects: TestProject[] = []
  const test = field(config, 'test')
  const list = field(test, 'projects')
  for (const project of Array.isArray(list) ? list : []) {
    const options = field(project, 'test')
    const name = field(options, 'name')
    const include = field(options, 'include')
    if (typeof name !== 'string' || !Array.isArray(include)) continue
    for (const pattern of include) {
      if (typeof pattern !== 'string') continue
      const parts = pattern.split('/')
      const wild = parts.findIndex(part => /[*?{[]/u.test(part))
      projects.push({ name, dir: (wild < 0 ? parts.slice(0, -1) : parts.slice(0, wild)).join('/') })
    }
  }
  return projects
}

function field(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined
  const result: unknown = Reflect.get(value, key)
  return result
}

type Need =
  | 'knip'
  | 'test'
  | `project:${string}`
  | `e2e:${string}`
  | 'build'
  | 'e2e'
  | 'electron'
  | 'supply'
  | 'workflows'
  | 'presence'
  | 'encoding'
  | 'copy'
  | 'layout'
  | 'everything'

/**
 * Files whose encodings the Host, the browser, the desktop shell, the Swift helper and the shared vectors must agree
 * on (AGENTS.md「共享安全编码」).
 */
export const SHARED_ENCODING_FILES: readonly string[] = [
  'packages/testkit/vectors/security-v1.json',
  'native/macos/LatchPresence.swift',
  'apps/host/src/crypto.ts',
  'apps/host/src/auth.ts',
  'apps/host/src/presence.ts',
  'packages/core/src/node-kit/digest.ts',
  'packages/protocol/src/text.ts',
  'apps/web/src/core/deviceKey.ts',
  'apps/web/src/core/contentHash.ts',
  'apps/desktop/src/credentials.cjs',
]

/**
 * Files outside the desktop shell that decide how it finds and talks to the Host (host.json, host.sock, credentials,
 * the page's CSP); the e2e-desktop workflow runs the Electron suite for them as well.
 */
const DESKTOP_CONTRACT_FILES: readonly string[] = [
  'apps/host/src/host-state.ts',
  'packages/core/src/node-kit/atomic.ts',
  'apps/host/src/listeners.ts',
  'apps/host/src/access.ts',
  'apps/host/src/auth.ts',
  'apps/host/src/http-util.ts',
  'apps/web/src/core/credentials.ts',
]

const DEPENDENCY_FILES = new Set(['pnpm-workspace.yaml', 'pnpm-lock.yaml', '.node-version', '.npmrc'])
const LINT_CONFIG = new Set(['.oxlintrc.json', '.oxfmtrc.json', 'knip.json', 'lefthook.yml', '.gitignore', '.git-blame-ignore-revs'])

/**
 * The Vitest projects that run the code of a source directory with no test project of its own beside it: its own
 * project and those of the workspace packages that depend on it.
 */
const DEPENDENT_PROJECTS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['packages/harness-acp/', ['@latch/harness-acp', '@latch/host']],
  ['packages/core/', ['latch', '@latch/harness-acp', '@latch/host']],
  ['packages/sdk/', ['latch', '@latch/harness-acp', '@latch/host']],
  ['packages/link-wire/', ['@latch/link-wire', '@latch/link-client', '@latch/relay', '@latch/relay-edge', '@latch/host']],
  ['packages/link-client/', ['@latch/link-client', '@latch/relay', '@latch/relay-edge', '@latch/host']],
  ['packages/relay-core/', ['@latch/relay', '@latch/relay-edge']],
  ['packages/app-sdk/', ['@latch/app-sdk', '@latch/web']],
  ['apps/relay/', ['@latch/relay', '@latch/relay-edge']],
  ['apps/relay-edge/', ['@latch/relay-edge']],
]

/**
 * Connection, enrollment, approval, cancel and streaming state, and the relays: a change to these files runs the e2e of
 * that flow, whatever the file is called (docs/TESTING.md「按改动选择回归」).
 */
export const FLOW_E2E: ReadonlyArray<readonly [RegExp, readonly string[]]> = [
  [/^apps\/web\/src\/core\/(?:enrollment|credentials|deviceKey|deviceStorageScope)\.ts$/u, ['enrollment.e2e.ts']],
  [/^apps\/host\/src\/(?:auth|access|listeners)\.ts$/u, ['enrollment.e2e.ts']],
  [/^apps\/web\/src\/core\/(?:eventStream|taskStream|projection|useReadingPosition)\.ts$/u, ['streaming-ui.e2e.ts', 'takeover.e2e.ts']],
  [/^apps\/host\/src\/(?:hub|task-delta|task-content)\.ts$/u, ['streaming-ui.e2e.ts', 'stream-delta.e2e.ts']],
  [/^apps\/web\/src\/core\/(?:approvalDecision|confirmations|permissions)\.ts$/u, ['plan-approval.e2e.ts', 'permissions-ui.e2e.ts']],
  [/^apps\/web\/src\/core\/(?:cancelRequest|sendingMessage)\.ts$/u, ['sending-message.e2e.ts', 'offline-send.e2e.ts']],
  [/^apps\/relay\//u, ['native-relay.e2e.ts']],
  [/^apps\/relay-edge\//u, ['native-relay-edge.e2e.ts']],
]

/** The capture of every surface at three widths in both themes, for the design system and the page shell. */
const LAYOUT_E2E = ['design.e2e.ts', 'visual.e2e.ts'] as const

/** The design system, the page shell and the page-wide styles restyle every surface. */
function sharedUi(path: string): boolean {
  return (
    path.startsWith('packages/ui/src/')
    || path.startsWith('packages/ui/test/gallery/')
    || path.startsWith('apps/web/src/shell/')
    || /^apps\/web\/src\/styles\/(?:index|layout|ui)\.css$/u.test(path)
    || path === 'apps/web/src/breakpoints.ts'
    || path === 'apps/web/index.html'
  )
}

/** Source directories whose file and directory names follow the names of the e2e files that drive them. */
const NAMED_SOURCES = [
  'apps/web/src/',
  'apps/host/src/',
  'apps/desktop/src/',
  'packages/ui/src/',
  'packages/protocol/src/',
  'packages/core/src/',
  'packages/harness-acp/src/',
  'packages/app-sdk/src/',
] as const

/** Directory and file names too general to say which flow a file belongs to, after `nameWords`. */
const GENERIC_NAMES = new Set([
  'src',
  'core',
  'component',
  'hook',
  'style',
  'lib',
  'util',
  'shared',
  'common',
  'index',
  'main',
  'app',
  'type',
  'route',
  'script',
  'helper',
  'plugin',
  'asset',
  'icon',
])

/**
 * `ItemPage.tsx` → `item-page`, `settings-pages.e2e.ts` → `setting-page`: lower-case words joined by `-`, each plural
 * `s` dropped, so a file and the e2e named after its flow meet in either number.
 */
function nameWords(name: string): string {
  return name
    .replace(/\..*$/u, '')
    .replace(/([a-z0-9])([A-Z])/gu, '$1-$2')
    .toLowerCase()
    .split(/[-_\s]+/u)
    .filter(word => word !== '')
    .map(word => (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word))
    .join('-')
}

/** One name begins the other at a word boundary: `board` and `board-item`, `setting-page` and `setting`. */
const related = (a: string, b: string): boolean => a === b || a.startsWith(`${b}-`) || b.startsWith(`${a}-`)

/**
 * The e2e files named after a changed source file or its directory. The desktop shell's files match the `desktop-*`
 * files only, and nothing else does; `desktop.e2e.ts` is the Electron suite the plan lists on its own.
 */
function namedE2e(path: string, e2e: readonly string[]): string[] {
  const root = NAMED_SOURCES.find(prefix => path.startsWith(prefix))
  if (!root) return []
  const parts = path.slice(root.length).split('/')
  const names = (parts.length > 1 ? parts.slice(-2) : parts).map(nameWords).filter(name => name !== '' && !GENERIC_NAMES.has(name))
  const desktop = root === 'apps/desktop/src/'
  return e2e.filter(file => {
    if (file === 'desktop.e2e.ts') return false
    const words = nameWords(file)
    if (desktop !== words.startsWith('desktop-')) return false
    const own = desktop ? words.slice('desktop-'.length) : words
    return names.some(name => related(name, own))
  })
}

/** The e2e files that cover a changed source file: those of its flow and those named after it. */
function coveringE2e(path: string, e2e: readonly string[]): Need[] {
  const files = new Set([...FLOW_E2E.filter(([pattern]) => pattern.test(path)).flatMap(([, list]) => list), ...namedE2e(path, e2e)])
  return [...files].map(file => `e2e:${file}` as const)
}

/** Copy the scans of the root project read: the glossary and locales (pages, design system, desktop) and error copy (Host). */
const COPY_SCOPES = [
  'apps/web/src/',
  'packages/ui/src/',
  'apps/desktop/src/',
  'apps/host/src/',
  'packages/core/src/',
  'packages/harness-acp/src/',
]

/**
 * What one changed path calls for, by the rules of AGENTS.md「完成标准」 and docs/TESTING.md; undefined when no rule
 * knows it. A change calls for the unit tests of the projects that run it, the copy scans, and the e2e files that cover
 * it; the whole browser suite only when test infrastructure or dependencies change, and otherwise at the end of a batch
 * (`--full`).
 */
function needsOf(path: string, projects: readonly TestProject[], e2e: readonly string[]): Need[] | undefined {
  const name = posix.basename(path)
  if (name === 'package.json' || DEPENDENCY_FILES.has(path)) return ['everything']
  if (path.endsWith('.md') || path === 'LICENSE' || path.startsWith('.agents/') || path.startsWith('.claude/')) return []
  if (path.startsWith('.github/')) return ['workflows']
  if (LINT_CONFIG.has(path) || path === 'build/icon.png') return ['knip']
  if (/^tsconfig(?:\.[\w-]+)?\.json$/u.test(path) || path === 'vitest.config.ts') return ['knip', 'test']

  if (path.startsWith('e2e/')) {
    if (path === 'e2e/desktop.e2e.ts') return ['build', 'electron']
    if (path.endsWith('.e2e.ts')) return [`e2e:${name}`, ...(LAYOUT_E2E.some(file => path === `e2e/${file}`) ? (['layout'] as const) : [])]
    return ['knip', 'build', 'e2e', 'electron']
  }
  if (path.startsWith('packages/testkit/'))
    return ['knip', 'test', 'build', 'e2e', 'electron', ...(path.includes('/vectors/') ? (['encoding'] as const) : [])]
  // The gallery of the design system's primitives is also a page that the visual capture builds and captures.
  if (path.startsWith('packages/ui/test/gallery/'))
    return ['knip', 'project:@latch/ui', ...LAYOUT_E2E.map(file => `e2e:${file}` as const), 'layout']
  if (path === 'apps/host/test/native-swift.test.ts') return ['knip', 'project:@latch/host-swift']
  const project = projects.find(item => path.startsWith(`${item.dir}/`))
  if (project) return ['knip', `project:${project.name}`]

  // The terminal and simulator components' own suites run in the Host's project.
  if (path === 'native/macos/LatchTerminal.swift' || path === 'native/macos/LatchSimulator.swift') return ['build', 'project:@latch/host']
  if (path.startsWith('native/')) return ['build', 'presence']

  const needs: Need[] = ['knip', ...coveringE2e(path, e2e)]
  if (COPY_SCOPES.some(scope => path.startsWith(scope))) needs.push('copy')
  if (sharedUi(path)) needs.push(...LAYOUT_E2E.map(file => `e2e:${file}` as const), 'layout')
  const dependents = DEPENDENT_PROJECTS.find(([prefix]) => path.startsWith(prefix))

  if (path.startsWith('apps/desktop/')) return [...needs, 'project:@latch/desktop', 'build', 'electron']
  if (path.startsWith('apps/web/')) {
    const page =
      (path.startsWith('apps/web/src/') && !path.startsWith('apps/web/src/core/'))
      || path.startsWith('apps/web/public/')
      || path === 'apps/web/index.html'
    return [...needs, 'project:@latch/web', ...(page ? (['layout'] as const) : [])]
  }
  if (path.startsWith('packages/ui/')) return [...needs, 'project:@latch/ui', 'project:@latch/web']
  if (/^apps\/host\/scripts\/desktop[\w-]*\.ts$/u.test(path)) return [...needs, 'project:@latch/host', 'build', 'electron']
  if (/^apps\/host\/scripts\/(?:build[\w-]*|host-bundle|package-desktop)\.ts$/u.test(path))
    return [...needs, 'project:@latch/host', 'build']
  if (path.startsWith('apps/host/')) return [...needs, 'project:@latch/host']
  if (dependents) return [...needs, ...dependents[1].map(item => `project:${item}` as const)]
  // Every project reads the shared protocol.
  if (path.startsWith('packages/')) return [...needs, 'test']
  if (path.startsWith('src/')) return ['knip', 'project:latch', 'build']
  if (path.startsWith('examples/')) return ['knip']
  if (path.startsWith('scripts/')) {
    const scripts: Need[] = ['knip', 'project:latch']
    if (/supply/u.test(name)) scripts.push('supply')
    if (/workflow/u.test(name)) scripts.push('workflows')
    return scripts
  }
  return undefined
}

interface PlanItem {
  command: string
  /** The changed paths that call for it. */
  because: string[]
  note?: string
}

export interface VerificationPlan {
  run: PlanItem[]
  /** Checks of the full set that the change does not call for, so a report can name them as not run. */
  skipped: string[]
  /** Paths no rule knows; they call for every check. */
  unknown: string[]
}

const BROWSER_E2E = 'pnpm test:e2e'
const ELECTRON_E2E = 'LATCH_ELECTRON_E2E=1 pnpm exec vitest run --config e2e/vitest.config.ts e2e/desktop.e2e.ts'
const DIST_GREP =
  "grep -rnE 'createTestPresence|startHostFixture|latch-test\\.localhost|(tests?|e2e)/(helpers|fixtures)|packages/testkit|@latch/testkit' dist/"
const COPY_TESTS =
  'pnpm exec vitest run --config vitest.config.ts tests/glossary.test.ts tests/i18n-coverage.test.ts tests/error-copy-coverage.test.ts'
const ENCODING_TESTS =
  'pnpm exec vitest run --config vitest.config.ts apps/host/test/crypto.test.ts apps/host/test/identity.test.ts apps/host/test/presence.test.ts apps/web/test/client-security.test.ts apps/desktop/test/desktop-proxy.test.ts'

export interface PlanOptions {
  /** The ref the change is compared against, for the commands the plan prints; HEAD by default. */
  base?: string
  /** The whole set, once at the end of a batch of changes or before a release, instead of what the change calls for. */
  full?: boolean
  /** Names of the e2e files (`board.e2e.ts`), for those named after a changed file. */
  e2e?: readonly string[]
}

/**
 * The checks and tests a change calls for. `pnpm check:quick` and `pnpm docs:affected` are always in it. A change runs
 * the unit tests of the projects that run its code and the e2e files that cover it; dependency files, test
 * infrastructure and paths no rule knows call for the whole set, as `full` does for every path. The targeted runs
 * (shared encoding, confirmation helper, copy scans) are added only when the whole set does not already cover them.
 */
export function verificationPlan(
  changes: readonly Change[],
  projects: readonly TestProject[],
  options: PlanOptions = {},
): VerificationPlan {
  const { base = 'HEAD', full = false, e2e = [] } = options
  const by = new Map<Need, Set<string>>()
  const paths = [...new Set(changes.flatMap(change => [change.path, ...(change.from ? [change.from] : [])]))].toSorted()
  const unknown: string[] = []
  for (const path of paths) {
    const known = needsOf(path, projects, e2e)
    if (known === undefined) unknown.push(path)
    const needs = new Set<Need>(known ?? ['everything'])
    if (full) needs.add('everything')
    if (SHARED_ENCODING_FILES.includes(path)) needs.add('encoding')
    if (DESKTOP_CONTRACT_FILES.includes(path)) needs.add('electron')
    for (const need of needs) {
      const set = by.get(need) ?? new Set<string>()
      set.add(path)
      by.set(need, set)
    }
  }
  if (full && paths.length === 0) by.set('everything', new Set(['--full']))
  const pathsOf = (needs: readonly Need[]): string[] | undefined => {
    const set = new Set<string>()
    for (const need of needs) for (const path of by.get(need) ?? []) set.add(path)
    return set.size === 0 ? undefined : [...set].toSorted()
  }
  const because = (...needs: Need[]) => pathsOf([...needs, 'everything'])
  const keys = (prefix: string) => [...by.keys()].filter(need => need.startsWith(prefix)).toSorted()

  const run: PlanItem[] = [{ command: 'pnpm check:quick', because: paths }]
  const skipped: string[] = []
  const add = (command: string, reasons: string[] | undefined, note?: string) => {
    if (reasons) run.push({ command, because: reasons, ...(note ? { note } : {}) })
    else skipped.push(command)
  }
  add('pnpm knip', because('knip'))
  const projectNeeds = keys('project:')
  const fullTests = because('test')
  if (fullTests || projectNeeds.length === 0) add('pnpm test', fullTests)
  else {
    add(`pnpm test ${projectNeeds.map(need => `--project ${need.slice('project:'.length)}`).join(' ')}`, because(...projectNeeds))
    skipped.push('pnpm test')
  }
  const copy = pathsOf(['copy'])
  if (copy && !fullTests && !projectNeeds.includes('project:latch'))
    run.push({ command: COPY_TESTS, because: copy, note: '界面与错误文案的术语、语言与错误码' })
  const fullE2e = because('e2e')
  const e2eNeeds = fullE2e ? [] : keys('e2e:')
  const build = because('build', 'e2e', 'electron', 'presence', ...e2eNeeds)
  add('pnpm build', build)
  add(DIST_GREP, build, '输出必须为空')
  // The desktop-* files drive Electron and run only with LATCH_ELECTRON_E2E=1; without it they are skipped, not passed.
  const electronFile = (need: Need) => need.startsWith('e2e:desktop-')
  for (const [needs, prefix, note] of [
    [
      e2eNeeds.filter(need => !electronFile(need)),
      '',
      '覆盖改动的 e2e：改动的用例、同名用例与所属流程的用例；还有覆盖这条流程的用例时一并加上',
    ],
    [e2eNeeds.filter(electronFile), 'LATCH_ELECTRON_E2E=1 ', '覆盖改动的桌面端 e2e；仅 macOS，先 pnpm build'],
  ] as const) {
    if (needs.length === 0) continue
    const files = needs.map(need => `e2e/${need.slice('e2e:'.length)}`)
    run.push({
      command: `${prefix}pnpm exec vitest run --config e2e/vitest.config.ts ${files.join(' ')}`,
      because: pathsOf(needs) ?? [],
      note,
    })
  }
  add(BROWSER_E2E, fullE2e, '本机可设 LATCH_BROWSER_PATH 使用已安装的 Chrome')
  add(ELECTRON_E2E, because('electron'), '仅 macOS，先 pnpm build')
  add(ENCODING_TESTS, pathsOf(['encoding']), '改的是共享编码时，同时更新共享向量、LatchPresence.swift 与各处实现')
  add(
    'pnpm build:presence 后运行 apps/host/test/presence.test.ts',
    pathsOf(['presence']),
    '确认组件的签名会改变：告知用户停止 Host 后运行 pnpm latch presence repin',
  )
  add('pnpm check:supply', because('supply'))
  add('pnpm check:workflows', because('workflows'))
  const layout = pathsOf(['layout'])
  if (layout)
    run.push({
      command: '改了布局或交互时，在手机、平板、桌面宽度与深色模式下检查真实渲染（latch-ui-check）',
      because: layout,
    })
  run.push({ command: `pnpm docs:affected -- --base ${base}`, because: paths, note: '核对列出的文档是否需要随行为更新' })
  return { run, skipped, unknown }
}
