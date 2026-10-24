import { readdir, readFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { isMap, isScalar, isSeq, parseDocument } from 'yaml'
import { z } from 'zod'

/** Where a project's code runs, declared in its package.json as `"latch": { "env": … }`. */
type ProjectEnv = 'isomorphic' | 'browser' | 'node' | 'electron-main'

const ENVS: ReadonlySet<string> = new Set<ProjectEnv>(['isomorphic', 'browser', 'node', 'electron-main'])

/**
 * The environments whose packages code in each environment can load. This covers what a project ships; its
 * devDependencies serve its tests and tools (such as a Vite config), which run in Node, so they may also come from what
 * Node loads.
 */
const LOADS: Readonly<Record<ProjectEnv, readonly ProjectEnv[]>> = {
  isomorphic: ['isomorphic'],
  browser: ['browser', 'isomorphic'],
  node: ['node', 'isomorphic'],
  'electron-main': ['electron-main', 'node', 'isomorphic'],
}

export interface ProjectRule {
  /** Directory relative to the repository root, with `/` separators. */
  dir: string
  /** Absent only for the repository root. */
  env?: ProjectEnv
  /** Workspace packages the project may list as dependencies. */
  dependencies: readonly string[]
  /** Further workspace packages it may list in `devDependencies` only. */
  devDependencies?: readonly string[]
  /** Test code: other projects may list it only in `devDependencies`, the root included. */
  devOnly?: boolean
}

/**
 * Every workspace project and the workspace packages it may use, the repository root included: no project is exempt.
 */
export const PROJECTS: Readonly<Record<string, ProjectRule>> = {
  // The root holds the compatibility entries of the plugin SDK (src/), the repository's scripts and the tests of the
  // packages without a test/ directory (tests/), which drive core through the Host's Standard driver.
  'harness-link': { dir: '.', dependencies: ['@latch/protocol', '@latch/sdk', '@latch/core'], devDependencies: ['@latch/host'] },
  '@latch/protocol': { dir: 'packages/protocol', env: 'isomorphic', dependencies: [] },
  // The design system of the browser client: design tokens, the order of the cascade layers and the primitive components.
  '@latch/ui': { dir: 'packages/ui', env: 'browser', dependencies: [] },
  '@latch/sdk': { dir: 'packages/sdk', env: 'node', dependencies: ['@latch/protocol'] },
  '@latch/core': { dir: 'packages/core', env: 'node', dependencies: ['@latch/protocol', '@latch/sdk'] },
  '@latch/testkit': { dir: 'packages/testkit', env: 'node', dependencies: ['@latch/protocol', '@latch/sdk', '@latch/core'], devOnly: true },
  '@latch/harness-acp': {
    dir: 'packages/harness-acp',
    env: 'node',
    dependencies: ['@latch/protocol', '@latch/sdk', '@latch/core'],
    devDependencies: ['@latch/testkit'],
  },
  // The composition root: the only project that depends on a harness driver package.
  '@latch/host': {
    dir: 'apps/host',
    env: 'node',
    dependencies: ['@latch/protocol', '@latch/sdk', '@latch/core', '@latch/harness-acp'],
    devDependencies: ['@latch/testkit'],
  },
  // At run time the page uses the protocol package and the design system. Its Vite config reads host.json through the
  // Host's modules, and its tests compare the browser's security encodings with the Host's and with the shared vectors.
  '@latch/web': {
    dir: 'apps/web',
    env: 'browser',
    dependencies: ['@latch/protocol', '@latch/ui'],
    devDependencies: ['@latch/testkit', '@latch/host', '@latch/core'],
  },
  // The shell's tests renew a credential against a real Host.
  '@latch/desktop': {
    dir: 'apps/desktop',
    env: 'electron-main',
    dependencies: ['@latch/protocol'],
    devDependencies: ['@latch/testkit', '@latch/host'],
  },
  // The end-to-end tests: a Host started in the test process, driven through a real browser and the Electron shell.
  // Test code, so like the test kit it may appear only in devDependencies.
  '@latch/e2e': {
    dir: 'e2e',
    env: 'node',
    dependencies: [],
    devDependencies: ['@latch/protocol', '@latch/sdk', '@latch/host', '@latch/testkit'],
    devOnly: true,
  },
}

export interface ProjectManifest {
  /** Directory relative to the repository root, with `/` separators. */
  dir: string
  manifest: Record<string, unknown>
}

const DEPENDENCY_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies'] as const
/** A name in this scope can only be one of the workspace's own packages, never one from the registry. */
const WORKSPACE_SCOPE = '@latch/'

const Manifest = z.record(z.string(), z.unknown())

function envOf(manifest: Record<string, unknown>): unknown {
  const latch = manifest.latch
  return typeof latch === 'object' && latch !== null && 'env' in latch ? latch.env : undefined
}

function dependencyMap(manifest: Record<string, unknown>, field: string): Array<[string, string]> {
  const value = manifest[field]
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value).map(([name, version]) => [name, String(version)])
}

/** Checks each project's declared environment and workspace dependencies against `rules`. */
export function checkBoundaries(projects: readonly ProjectManifest[], rules: Readonly<Record<string, ProjectRule>> = PROJECTS): string[] {
  const problems: string[] = []
  const byName = new Map<string, ProjectManifest>()
  for (const project of projects) {
    const name = project.manifest.name
    const where = `${project.dir}/package.json`
    if (typeof name !== 'string' || name === '') {
      problems.push(`${where} 没有 name`)
      continue
    }
    const first = byName.get(name)
    if (first) {
      problems.push(`${where}：${name} 与 ${first.dir} 重名`)
      continue
    }
    byName.set(name, project)
  }

  for (const [name, project] of byName) {
    const where = `${project.dir}/package.json`
    const rule = rules[name]
    if (!rule) {
      problems.push(`${where}：${name} 不在 scripts/boundaries.ts 的 PROJECTS 中，新项目要在那里写明运行环境与可用的 workspace 包`)
      continue
    }
    if (project.dir !== rule.dir) problems.push(`${where}：${name} 应位于 ${rule.dir}`)
    const env = envOf(project.manifest)
    if (rule.env === undefined) {
      if (env !== undefined) problems.push(`${where}：仓库根不声明 latch.env`)
    } else if (env !== rule.env) {
      problems.push(
        `${where}：latch.env 应为 "${rule.env}"，现为 ${env === undefined ? '未声明' : JSON.stringify(env)}`
          + (typeof env === 'string' && !ENVS.has(env) ? `（可用：${[...ENVS].join('、')}）` : ''),
      )
    }

    for (const field of DEPENDENCY_FIELDS) {
      for (const [dependency, version] of dependencyMap(project.manifest, field)) {
        const target = byName.get(dependency)
        const workspaceLike = target !== undefined || version.startsWith('workspace:') || dependency.startsWith(WORKSPACE_SCOPE)
        if (!workspaceLike) continue
        const label = `${where} 的 ${field}.${dependency}`
        if (!target) {
          problems.push(`${label} 不是本仓库的 workspace 项目；${WORKSPACE_SCOPE} 下的包只能来自 workspace`)
          continue
        }
        if (!version.startsWith('workspace:')) problems.push(`${label} 必须写成 workspace:*，否则会从 registry 安装同名包`)
        if (dependency === name) {
          problems.push(`${label}：项目不能依赖自己`)
          continue
        }
        const targetRule = rules[dependency]
        if (!targetRule) continue
        if (targetRule.env === undefined) {
          problems.push(`${label}：仓库根不是可依赖的包`)
          continue
        }
        if (targetRule.devOnly && field !== 'devDependencies') {
          problems.push(`${label}：${dependency} 只供测试使用，只能写在 devDependencies`)
          continue
        }
        const usable = [...rule.dependencies, ...(field === 'devDependencies' ? (rule.devDependencies ?? []) : [])]
        if (!usable.includes(dependency)) {
          problems.push(`${label}：${name} ${usable.length > 0 ? `只能使用 ${usable.join('、')}` : '不能使用任何 workspace 包'}`)
          continue
        }
        if (rule.env !== undefined) {
          const loads = field === 'devDependencies' ? [...LOADS[rule.env], ...LOADS.node] : LOADS[rule.env]
          if (!loads.includes(targetRule.env)) problems.push(`${label}：${rule.env} 项目不能依赖 ${targetRule.env} 项目`)
        }
      }
    }
  }

  for (const [name, rule] of Object.entries(rules)) {
    if (!byName.has(name)) problems.push(`PROJECTS 中的 ${name}（${rule.dir}）不在 pnpm-workspace.yaml 列出的项目中`)
  }
  return problems
}

/**
 * Projects matched by the `packages` list of pnpm-workspace.yaml. Only `<dir>` and `<dir>/*` entries are supported;
 * any other pattern is reported rather than skipped, so no project can fall outside the check.
 */
export async function readWorkspaceProjects(root: string): Promise<{ projects: ProjectManifest[]; problems: string[] }> {
  const problems: string[] = []
  const document = parseDocument(await readFile(join(root, 'pnpm-workspace.yaml'), 'utf8'))
  const list = isMap(document.contents) ? document.get('packages', true) : undefined
  if (!isSeq(list)) return { projects: [], problems: ['pnpm-workspace.yaml 缺少 packages 列表'] }

  const dirs = new Set<string>(['.'])
  for (const item of list.items) {
    const pattern = isScalar(item) && typeof item.value === 'string' ? item.value.replace(/\/+$/u, '') : undefined
    if (pattern === undefined || pattern.startsWith('!') || /[*?[\]{}]/u.test(pattern.replace(/\/\*$/u, ''))) {
      problems.push(
        `pnpm-workspace.yaml 的 packages 项 ${JSON.stringify(isScalar(item) ? item.value : item)} 不受支持：只能写目录或「目录/*」`,
      )
      continue
    }
    if (!pattern.endsWith('/*')) {
      dirs.add(posix.normalize(pattern))
      continue
    }
    const parent = posix.normalize(pattern.slice(0, -2))
    let entries: string[] = []
    try {
      entries = (await readdir(join(root, parent), { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name)
    } catch {
      continue
    }
    for (const entry of entries.toSorted()) dirs.add(posix.join(parent, entry))
  }

  const projects: ProjectManifest[] = []
  for (const dir of dirs) {
    let text: string
    try {
      text = await readFile(join(root, dir, 'package.json'), 'utf8')
    } catch {
      // pnpm skips directories without a package.json as well.
      continue
    }
    try {
      projects.push({ dir, manifest: Manifest.parse(JSON.parse(text)) })
    } catch {
      problems.push(`${dir}/package.json 无法解析`)
    }
  }
  return { projects, problems }
}
