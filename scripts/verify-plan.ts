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
  | 'build'
  | 'e2e'
  | 'electron'
  | 'supply'
  | 'workflows'
  | 'presence'
  | 'encoding'
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

/** What one changed path calls for, by the rules of AGENTS.md「完成标准」 and docs/TESTING.md; undefined when no rule knows it. */
function needsOf(path: string, projects: readonly TestProject[]): Need[] | undefined {
  const name = posix.basename(path)
  if (name === 'package.json' || DEPENDENCY_FILES.has(path)) return ['everything']
  if (path.endsWith('.md') || path === 'LICENSE' || path === 'NOTICE' || path.startsWith('.agents/') || path.startsWith('.claude/'))
    return []
  if (path.startsWith('.github/')) return ['workflows']
  if (LINT_CONFIG.has(path) || path === 'build/icon.png') return ['knip']
  if (/^tsconfig(?:\.[\w-]+)?\.json$/u.test(path) || path === 'vitest.config.ts') return ['knip', 'test']

  if (path.startsWith('e2e/')) {
    if (path === 'e2e/desktop.e2e.ts') return ['build', 'electron']
    if (path.endsWith('.e2e.ts')) return ['build', 'e2e', ...(path === 'e2e/design.e2e.ts' ? (['layout'] as const) : [])]
    return ['knip', 'build', 'e2e', 'electron']
  }
  if (path.startsWith('packages/testkit/'))
    return ['knip', 'test', 'build', 'e2e', 'electron', ...(path.includes('/vectors/') ? (['encoding'] as const) : [])]
  // The gallery of the design system's primitives is also a page that the visual capture builds and captures.
  if (path.startsWith('packages/ui/test/gallery/')) return ['knip', 'project:@latch/ui', 'build', 'e2e']
  const project = projects.find(item => path.startsWith(`${item.dir}/`))
  if (project) return ['knip', `project:${project.name}`]

  if (path.startsWith('native/')) return ['build', 'presence']
  if (path.startsWith('apps/desktop/')) return ['knip', 'project:@latch/desktop', 'build', 'electron']
  if (path.startsWith('apps/web/')) {
    const page =
      (path.startsWith('apps/web/src/') && !path.startsWith('apps/web/src/core/'))
      || path.startsWith('apps/web/public/')
      || path === 'apps/web/index.html'
    return ['knip', 'project:@latch/web', 'build', 'e2e', ...(page ? (['layout'] as const) : [])]
  }
  // The design system restyles the whole page, so it calls for what a change to the page's own styles does.
  if (path.startsWith('packages/ui/')) return ['knip', 'project:@latch/ui', 'project:@latch/web', 'build', 'e2e', 'layout']
  if (/^apps\/host\/scripts\/desktop[\w-]*\.ts$/u.test(path)) return ['knip', 'project:@latch/host', 'build', 'electron']
  if (path.startsWith('apps/host/') || path.startsWith('packages/')) return ['knip', 'test', 'build', 'e2e']
  if (path.startsWith('src/')) return ['knip', 'project:harness-link', 'build']
  if (path.startsWith('examples/')) return ['knip']
  if (path.startsWith('scripts/')) {
    const needs: Need[] = ['knip', 'project:harness-link']
    if (/supply/u.test(name)) needs.push('supply')
    if (/workflow/u.test(name)) needs.push('workflows')
    return needs
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
const ELECTRON_E2E = 'HARNESS_ELECTRON_E2E=1 pnpm exec vitest run --config e2e/vitest.config.ts e2e/desktop.e2e.ts'
const DIST_GREP =
  "grep -rnE 'createTestPresence|startHostFixture|latch-test\\.localhost|(tests?|e2e)/(helpers|fixtures)|packages/testkit|@latch/testkit' dist/"
const ENCODING_TESTS =
  'pnpm exec vitest run --config vitest.config.ts apps/host/test/crypto.test.ts apps/host/test/identity.test.ts apps/host/test/presence.test.ts apps/web/test/client-security.test.ts apps/desktop/test/desktop-proxy.test.ts'

/**
 * The checks and tests a change calls for. `pnpm check:quick` and `pnpm docs:affected` are always in it. Dependency
 * files and paths no rule knows call for the whole set; the targeted runs (shared encoding, confirmation helper, layout)
 * are added only for the paths that call for them, since the whole set already covers them otherwise.
 */
export function verificationPlan(changes: readonly Change[], projects: readonly TestProject[], base = 'HEAD'): VerificationPlan {
  const by = new Map<Need, Set<string>>()
  const paths = [...new Set(changes.flatMap(change => [change.path, ...(change.from ? [change.from] : [])]))].toSorted()
  const unknown: string[] = []
  for (const path of paths) {
    const known = needsOf(path, projects)
    if (known === undefined) unknown.push(path)
    const needs = new Set<Need>(known ?? ['everything'])
    if (SHARED_ENCODING_FILES.includes(path)) needs.add('encoding')
    if (DESKTOP_CONTRACT_FILES.includes(path)) needs.add('electron')
    for (const need of needs) {
      const set = by.get(need) ?? new Set<string>()
      set.add(path)
      by.set(need, set)
    }
  }
  const pathsOf = (needs: readonly Need[]): string[] | undefined => {
    const set = new Set<string>()
    for (const need of needs) for (const path of by.get(need) ?? []) set.add(path)
    return set.size === 0 ? undefined : [...set].toSorted()
  }
  const because = (...needs: Need[]) => pathsOf([...needs, 'everything'])

  const run: PlanItem[] = [{ command: 'pnpm check:quick', because: paths }]
  const skipped: string[] = []
  const add = (command: string, reasons: string[] | undefined, note?: string) => {
    if (reasons) run.push({ command, because: reasons, ...(note ? { note } : {}) })
    else skipped.push(command)
  }
  add('pnpm knip', because('knip'))
  const projectNeeds = [...by.keys()].filter(need => need.startsWith('project:')).toSorted()
  const fullTests = because('test')
  if (fullTests || projectNeeds.length === 0) add('pnpm test', fullTests)
  else add(`pnpm test ${projectNeeds.map(need => `--project ${need.slice('project:'.length)}`).join(' ')}`, because(...projectNeeds))
  const build = because('build', 'e2e', 'electron', 'presence')
  add('pnpm build', build)
  add(DIST_GREP, build, '输出必须为空')
  add(BROWSER_E2E, because('e2e'), '本机可设 HARNESS_BROWSER_PATH 使用已安装的 Chrome')
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
  if (layout) run.push({ command: '在手机、平板、桌面宽度与深色模式下检查真实渲染（e2e/design.e2e.ts 的截图）', because: layout })
  run.push({ command: `pnpm docs:affected -- --base ${base}`, because: paths, note: '核对列出的文档是否需要随行为更新' })
  return { run, skipped, unknown }
}
