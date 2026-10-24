import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkBoundaries, readWorkspaceProjects, type ProjectManifest, type ProjectRule } from '../scripts/boundaries.ts'

const RULES: Record<string, ProjectRule> = {
  root: { dir: '.', dependencies: ['@latch/server', '@latch/page', '@latch/kit'] },
  '@latch/shared': { dir: 'packages/shared', env: 'isomorphic', dependencies: [] },
  '@latch/server': { dir: 'packages/server', env: 'node', dependencies: ['@latch/shared'], devDependencies: ['@latch/kit'] },
  '@latch/kit': { dir: 'packages/kit', env: 'node', dependencies: ['@latch/shared'] },
  '@latch/page': { dir: 'packages/page', env: 'browser', dependencies: ['@latch/shared', '@latch/server'] },
}

function project(dir: string, name: string, fields: Record<string, unknown> = {}): ProjectManifest {
  const env = RULES[name]?.env
  return { dir, manifest: { name, ...(env ? { latch: { env } } : {}), ...fields } }
}

function workspace(overrides: Partial<Record<string, ProjectManifest>> = {}): ProjectManifest[] {
  const base: Record<string, ProjectManifest> = {
    root: project('.', 'root', { dependencies: { '@latch/server': 'workspace:*', '@latch/page': 'workspace:*', zod: 'catalog:' } }),
    '@latch/shared': project('packages/shared', '@latch/shared'),
    '@latch/server': project('packages/server', '@latch/server', {
      dependencies: { '@latch/shared': 'workspace:*' },
      devDependencies: { '@latch/kit': 'workspace:*' },
    }),
    '@latch/kit': project('packages/kit', '@latch/kit', { dependencies: { '@latch/shared': 'workspace:*' } }),
    '@latch/page': project('packages/page', '@latch/page', { dependencies: { '@latch/shared': 'workspace:*' } }),
  }
  return Object.values({ ...base, ...overrides }).filter(item => item !== undefined)
}

describe('workspace boundaries', () => {
  it('accepts projects that declare their environment and use only the workspace packages they are allowed', () => {
    expect(checkBoundaries(workspace(), RULES)).toEqual([])
  })

  it('reports a project whose declared environment is missing or differs from its rule, and a root that declares one', () => {
    const problems = checkBoundaries(
      workspace({
        root: { dir: '.', manifest: { name: 'root', latch: { env: 'node' } } },
        '@latch/shared': { dir: 'packages/shared', manifest: { name: '@latch/shared' } },
        '@latch/kit': { dir: 'packages/kit', manifest: { name: '@latch/kit', latch: { env: 'browser' } } },
        '@latch/page': { dir: 'packages/page', manifest: { name: '@latch/page', latch: { env: 'web' } } },
      }),
      RULES,
    )
    expect(problems).toEqual([
      './package.json：仓库根不声明 latch.env',
      'packages/shared/package.json：latch.env 应为 "isomorphic"，现为 未声明',
      'packages/kit/package.json：latch.env 应为 "node"，现为 "browser"',
      'packages/page/package.json：latch.env 应为 "browser"，现为 "web"（可用：isomorphic、browser、node、electron-main）',
    ])
  })

  it('reports workspace dependencies outside the rule, including dev-only packages listed as runtime dependencies', () => {
    const problems = checkBoundaries(
      workspace({
        '@latch/shared': project('packages/shared', '@latch/shared', { peerDependencies: { '@latch/kit': 'workspace:*' } }),
        '@latch/server': project('packages/server', '@latch/server', { dependencies: { '@latch/kit': 'workspace:*' } }),
        '@latch/kit': project('packages/kit', '@latch/kit', { devDependencies: { '@latch/server': 'workspace:*' } }),
      }),
      RULES,
    )
    expect(problems).toEqual([
      'packages/shared/package.json 的 peerDependencies.@latch/kit：@latch/shared 不能使用任何 workspace 包',
      'packages/server/package.json 的 dependencies.@latch/kit：@latch/server 只能使用 @latch/shared',
      'packages/kit/package.json 的 devDependencies.@latch/server：@latch/kit 只能使用 @latch/shared',
    ])
  })

  it('reports a dev-only package listed anywhere but devDependencies, by the root as well', () => {
    const rules: Record<string, ProjectRule> = { ...RULES, '@latch/kit': { ...RULES['@latch/kit'], devOnly: true } }
    const problems = checkBoundaries(
      workspace({
        root: project('.', 'root', { dependencies: { '@latch/kit': 'workspace:*' }, devDependencies: { '@latch/kit': 'workspace:*' } }),
        '@latch/server': project('packages/server', '@latch/server', {
          dependencies: { '@latch/shared': 'workspace:*' },
          peerDependencies: { '@latch/kit': 'workspace:*' },
          devDependencies: { '@latch/kit': 'workspace:*' },
        }),
      }),
      rules,
    )
    expect(problems).toEqual([
      './package.json 的 dependencies.@latch/kit：@latch/kit 只供测试使用，只能写在 devDependencies',
      'packages/server/package.json 的 peerDependencies.@latch/kit：@latch/kit 只供测试使用，只能写在 devDependencies',
    ])
  })

  it('reports a dependency on a package of an environment the project cannot load, even when its rule lists it', () => {
    const problems = checkBoundaries(
      workspace({ '@latch/page': project('packages/page', '@latch/page', { dependencies: { '@latch/server': 'workspace:*' } }) }),
      RULES,
    )
    expect(problems).toEqual(['packages/page/package.json 的 dependencies.@latch/server：browser 项目不能依赖 node 项目'])
  })

  it('accepts Node projects in devDependencies, which only tests and tools running in Node load, and still refuses other environments', () => {
    const rules: Record<string, ProjectRule> = {
      ...RULES,
      '@latch/kit': { ...RULES['@latch/kit'], devDependencies: ['@latch/page'] },
      '@latch/page': { ...RULES['@latch/page'], devDependencies: ['@latch/kit'] },
    }
    const problems = checkBoundaries(
      workspace({
        '@latch/kit': project('packages/kit', '@latch/kit', {
          dependencies: { '@latch/shared': 'workspace:*' },
          devDependencies: { '@latch/page': 'workspace:*' },
        }),
        '@latch/page': project('packages/page', '@latch/page', {
          dependencies: { '@latch/shared': 'workspace:*' },
          devDependencies: { '@latch/server': 'workspace:*', '@latch/kit': 'workspace:*' },
        }),
      }),
      rules,
    )
    expect(problems).toEqual(['packages/kit/package.json 的 devDependencies.@latch/page：node 项目不能依赖 browser 项目'])
  })

  it('reports workspace packages taken from the registry, scoped names outside the workspace, and dependencies on the root', () => {
    const problems = checkBoundaries(
      workspace({
        root: project('.', 'root', { dependencies: { '@latch/server': '0.1.0', '@latch/telemetry': '1.0.0' } }),
        '@latch/kit': project('packages/kit', '@latch/kit', { dependencies: { '@latch/shared': 'workspace:*', root: 'workspace:*' } }),
      }),
      RULES,
    )
    expect(problems).toEqual([
      './package.json 的 dependencies.@latch/server 必须写成 workspace:*，否则会从 registry 安装同名包',
      './package.json 的 dependencies.@latch/telemetry 不是本仓库的 workspace 项目；@latch/ 下的包只能来自 workspace',
      'packages/kit/package.json 的 dependencies.root：仓库根不是可依赖的包',
    ])
  })

  it('checks the repository root like every project, reporting a workspace package its rule does not list', () => {
    const rules: Record<string, ProjectRule> = {
      ...RULES,
      root: { dir: '.', dependencies: ['@latch/server'], devDependencies: ['@latch/kit'] },
    }
    const problems = checkBoundaries(
      workspace({
        root: project('.', 'root', {
          dependencies: { '@latch/server': 'workspace:*', '@latch/page': 'workspace:*' },
          devDependencies: { '@latch/kit': 'workspace:*', '@latch/shared': 'workspace:*' },
        }),
      }),
      rules,
    )
    expect(problems).toEqual([
      './package.json 的 dependencies.@latch/page：root 只能使用 @latch/server',
      './package.json 的 devDependencies.@latch/shared：root 只能使用 @latch/server、@latch/kit',
    ])
  })

  it('reports projects missing from the rules, rules without a project, misplaced projects and duplicate names', () => {
    const problems = checkBoundaries(
      [
        ...workspace({ '@latch/kit': undefined, '@latch/page': project('packages/web', '@latch/page') }),
        project('packages/extra', '@latch/extra', { latch: { env: 'node' } }),
        project('packages/copy', '@latch/shared'),
        { dir: 'packages/nameless', manifest: {} },
      ],
      RULES,
    )
    expect(problems).toEqual([
      'packages/copy/package.json：@latch/shared 与 packages/shared 重名',
      'packages/nameless/package.json 没有 name',
      'packages/server/package.json 的 devDependencies.@latch/kit 不是本仓库的 workspace 项目；@latch/ 下的包只能来自 workspace',
      'packages/web/package.json：@latch/page 应位于 packages/page',
      'packages/extra/package.json：@latch/extra 不在 scripts/boundaries.ts 的 PROJECTS 中，新项目要在那里写明运行环境与可用的 workspace 包',
      'PROJECTS 中的 @latch/kit（packages/kit）不在 pnpm-workspace.yaml 列出的项目中',
    ])
  })
})

describe('workspace project listing', () => {
  let root: string | undefined
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
    root = undefined
  })

  async function tree(workspaceYaml: string, manifests: Record<string, unknown>): Promise<string> {
    root = await mkdtemp(join(tmpdir(), 'latch-boundaries-'))
    await writeFile(join(root, 'pnpm-workspace.yaml'), workspaceYaml)
    for (const [dir, manifest] of Object.entries(manifests)) {
      await mkdir(join(root, dir), { recursive: true })
      if (manifest !== null) await writeFile(join(root, dir, 'package.json'), JSON.stringify(manifest))
    }
    return root
  }

  it('lists the root, named directories and the children of dir/*, skipping directories without a package.json', async () => {
    const dir = await tree('packages:\n  - .\n  - packages/*\n  - tools/cli\n', {
      '.': { name: 'root' },
      'packages/b': { name: '@latch/b' },
      'packages/a': { name: '@latch/a' },
      'packages/empty': null,
      'tools/cli': { name: '@latch/cli' },
      'tools/other': { name: '@latch/other' },
    })
    const { projects, problems } = await readWorkspaceProjects(dir)
    expect(problems).toEqual([])
    expect(projects.map(item => [item.dir, item.manifest.name])).toEqual([
      ['.', 'root'],
      ['packages/a', '@latch/a'],
      ['packages/b', '@latch/b'],
      ['tools/cli', '@latch/cli'],
    ])
  })

  it('reports patterns it cannot expand instead of skipping the projects they would match', async () => {
    const dir = await tree("packages:\n  - .\n  - 'packages/**'\n  - '!packages/old'\n  - 'apps/{web,host}'\n", { '.': { name: 'root' } })
    const { projects, problems } = await readWorkspaceProjects(dir)
    expect(projects.map(item => item.dir)).toEqual(['.'])
    expect(problems).toEqual([
      'pnpm-workspace.yaml 的 packages 项 "packages/**" 不受支持：只能写目录或「目录/*」',
      'pnpm-workspace.yaml 的 packages 项 "!packages/old" 不受支持：只能写目录或「目录/*」',
      'pnpm-workspace.yaml 的 packages 项 "apps/{web,host}" 不受支持：只能写目录或「目录/*」',
    ])
  })
})
