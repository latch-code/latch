import { readdir, readFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { isMap, isScalar, isSeq, parseDocument } from 'yaml'
import { z } from 'zod'

/** Where a project's code runs, declared in its package.json as `"latch": { "env": … }`. */
type ProjectEnv = 'isomorphic' | 'browser' | 'node' | 'electron-main' | 'workerd'

const ENVS: ReadonlySet<string> = new Set<ProjectEnv>(['isomorphic', 'browser', 'node', 'electron-main', 'workerd'])

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
  // Cloudflare Workers: the ECMAScript library, WebSockets and fetch, never Node's modules.
  workerd: ['workerd', 'isomorphic'],
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
  latch: { dir: '.', dependencies: ['@latch/protocol', '@latch/sdk', '@latch/core'], devDependencies: ['@latch/host'] },
  '@latch/link-wire': { dir: 'packages/link-wire', env: 'isomorphic', dependencies: [] },
  '@latch/link-client': { dir: 'packages/link-client', env: 'node', dependencies: ['@latch/link-wire'] },
  // The relay's state machine without I/O, shared by the self-hosted Node relay and the edge relay.
  '@latch/relay-core': { dir: 'packages/relay-core', env: 'isomorphic', dependencies: ['@latch/link-wire'] },
  '@latch/relay': {
    dir: 'apps/relay',
    env: 'node',
    dependencies: ['@latch/link-wire', '@latch/link-client', '@latch/relay-core'],
  },
  // The official relay on Cloudflare Workers. Its tests drive the adapter in Node against a fake platform.
  '@latch/relay-edge': {
    dir: 'apps/relay-edge',
    env: 'workerd',
    dependencies: ['@latch/link-wire', '@latch/relay-core'],
    devDependencies: ['@latch/link-client', '@latch/relay'],
  },
  '@latch/protocol': { dir: 'packages/protocol', env: 'isomorphic', dependencies: [] },
  // The design system of the browser client: design tokens, the order of the cascade layers and the primitive components.
  '@latch/ui': { dir: 'packages/ui', env: 'browser', dependencies: [] },
  // Plugin pages: the author types, the bridge client and the runtime that run inside the opaque page frame. It never
  // reaches the shell's code: the design system's primitives come in from the runtime's entry in the web client.
  '@latch/app-sdk': { dir: 'packages/app-sdk', env: 'browser', dependencies: ['@latch/protocol'] },
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
    dependencies: ['@latch/protocol', '@latch/sdk', '@latch/core', '@latch/harness-acp', '@latch/link-wire', '@latch/link-client'],
    devDependencies: ['@latch/testkit'],
  },
  // At run time the page uses the protocol package and the design system; the plugin page runtime it builds also carries
  // the page SDK. Its Vite config reads host.json through the Host's modules, and its tests compare the browser's
  // security encodings with the Host's and with the shared vectors.
  '@latch/web': {
    dir: 'apps/web',
    env: 'browser',
    dependencies: ['@latch/protocol', '@latch/ui', '@latch/app-sdk'],
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
    devDependencies: [
      '@latch/protocol',
      '@latch/sdk',
      '@latch/host',
      '@latch/testkit',
      '@latch/relay',
      '@latch/relay-edge',
      '@latch/link-client',
      '@latch/link-wire',
    ],
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
          // Tests and tools may also load workerd code: it uses only the ES library and the platform it is handed.
          const loads = field === 'devDependencies' ? [...LOADS[rule.env], ...LOADS.node, 'workerd' as const] : LOADS[rule.env]
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

/** Names of the LatchScreens target's own code: its canned scenes and live mode's software keys. */
const SCREENS_ONLY = /\b(?:ScreensStage|PhoneLive|LiveSoftwareKeys|LiveIdentityProvider)\b|LatchLive/u
/**
 * Calls only a software key makes: the product's keys are Secure Enclave keys, never built from bytes. A random key
 * made without `kSecAttrTokenIDSecureEnclave` is one too (checked separately, across the call's lines).
 */
const SOFTWARE_KEY = /\bSecKeyCreateWithData\b|\bP256\.Signing\.PrivateKey\s*\(/u

type Plist = string | Plist[] | { [key: string]: Plist }

/** A call's text from `SecKeyCreateRandomKey(` on the given line to its closing parenthesis, across lines. */
function callText(lines: readonly string[], index: number): string {
  const rest = lines.slice(index).join('\n')
  const start = rest.indexOf('SecKeyCreateRandomKey')
  let depth = 0
  for (let at = rest.indexOf('(', start); at >= 0 && at < rest.length; at++) {
    if (rest[at] === '(') depth++
    else if (rest[at] === ')' && --depth === 0) return rest.slice(start, at + 1)
  }
  return rest.slice(start)
}

/** The OpenStep property list of a project.pbxproj, comments skipped outside strings; throws on anything it cannot read. */
export function parsePbxproj(text: string): Record<string, Plist> {
  const source = text
  let at = 0
  // Comments are skipped only between tokens, so a quoted "$(SRCROOT)/**" or "//" stays a value.
  const space = () => {
    for (;;) {
      while (at < source.length && /\s/u.test(source[at]!)) at++
      if (source.startsWith('/*', at)) {
        const end = source.indexOf('*/', at + 2)
        if (end < 0) throw new Error('project.pbxproj 的注释没有结束')
        at = end + 2
      } else if (source.startsWith('//', at)) {
        const end = source.indexOf('\n', at)
        at = end < 0 ? source.length : end + 1
      } else return
    }
  }
  const expect = (char: string) => {
    space()
    if (source[at] !== char) throw new Error(`project.pbxproj 在 ${at} 处应为 ${char}`)
    at++
  }
  const value = (): Plist => {
    space()
    const char = source[at]
    if (char === '{') {
      at++
      const object: Record<string, Plist> = {}
      for (space(); source[at] !== '}'; space()) {
        const key = value()
        if (typeof key !== 'string') throw new Error('project.pbxproj 的键不是字符串')
        expect('=')
        object[key] = value()
        expect(';')
      }
      at++
      return object
    }
    if (char === '(') {
      at++
      const list: Plist[] = []
      for (space(); source[at] !== ')'; space()) {
        list.push(value())
        space()
        if (source[at] === ',') at++
      }
      at++
      return list
    }
    if (char === '"') {
      let result = ''
      for (at++; source[at] !== '"'; at++) {
        if (at >= source.length) throw new Error('project.pbxproj 的字符串没有结束')
        result += source[at] === '\\' ? source[++at] : source[at]
      }
      at++
      return result
    }
    const bare = /^[^\s=;,(){}"]+/u.exec(source.slice(at))?.[0]
    if (!bare) throw new Error(`project.pbxproj 在 ${at} 处无法解析`)
    at += bare.length
    return bare
  }
  const root = value()
  if (typeof root !== 'object' || Array.isArray(root)) throw new Error('project.pbxproj 的根不是字典')
  return root
}

/**
 * The iOS App's screenshot scenes and live mode's software keys stay out of the Latch product: they may be named, and
 * software keys made, only in `native/ios/Screens/` (a folder only LatchScreens builds) or inside `#if LATCH_SCREENS`
 * in `native/ios/App/`, never in the shared core or its fixtures. In the project, only LatchScreens builds Screens/ or
 * sets LATCH_SCREENS (simulator only), and the Latch target's settings are all in the project, with no indirection a
 * reader could miss. `files` are repository paths under native/ios with their text; `project` is project.pbxproj.
 */
export function checkScreensOnly(files: ReadonlyArray<{ path: string; text: string }>, project: string): string[] {
  const problems: string[] = []
  for (const { path, text } of files) {
    if (path.startsWith('native/ios/Screens/')) continue
    const lines = text.split('\n')
    const conditions: string[] = []
    for (const [index, raw] of lines.entries()) {
      const line = raw.trim()
      const directive = /^#(if|elseif|else|endif)\b\s*(.*)$/u.exec(line)
      if (directive) {
        if (directive[1] === 'if') conditions.push(directive[2]!.trim())
        else if (directive[1] === 'endif') conditions.pop()
        else conditions[conditions.length - 1] = '!'
        continue
      }
      if (/^(?:\/\/|\/\*|\*)/u.test(line)) continue
      const product = /^native\/ios\/(?:App|Sources)\//u.test(path)
      const named = SCREENS_ONLY.test(line),
        software =
          product
          && (SOFTWARE_KEY.test(line)
            || (/\bSecKeyCreateRandomKey\s*\(/u.test(line) && !/\bkSecAttrTokenIDSecureEnclave\b/u.test(callText(lines, index))))
      if (!named && !software) continue
      if (path.startsWith('native/ios/App/') && conditions.includes('LATCH_SCREENS')) continue
      problems.push(
        named
          ? `${path}:${index + 1}：LatchScreens 的代码只写在 native/ios/Screens/ 或 App/ 的 #if LATCH_SCREENS 中`
          : `${path}:${index + 1}：产品只用 Secure Enclave 密钥；软件密钥只在 LatchScreens 的 #if LATCH_SCREENS 中`,
      )
    }
  }
  return [...problems, ...checkScreensProject(project)]
}

function checkScreensProject(text: string): string[] {
  let objects: Record<string, Plist>
  try {
    const root = parsePbxproj(text)
    const found = root.objects
    if (typeof found !== 'object' || Array.isArray(found)) throw new Error('project.pbxproj 没有 objects')
    objects = found
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)]
  }
  const problems: string[] = []
  const dict = (id: Plist | undefined): Record<string, Plist> | undefined => {
    const value = typeof id === 'string' ? objects[id] : undefined
    return typeof value === 'object' && !Array.isArray(value) ? value : undefined
  }
  const list = (value: Plist | undefined): string[] => (Array.isArray(value) ? value.filter(item => typeof item === 'string') : [])
  const entries = Object.entries(objects).flatMap(([id, value]) =>
    typeof value === 'object' && !Array.isArray(value) ? [{ id, value }] : [],
  )
  const targets = entries.filter(item => item.value.isa === 'PBXNativeTarget')
  const screens = entries.filter(
    item => /^PBX(?:FileSystemSynchronizedRoot)?Group$/u.test(String(item.value.isa)) && item.value.path === 'Screens',
  )
  const screensTarget = targets.find(item => item.value.name === 'LatchScreens')
  const product = targets.find(item => item.value.name === 'Latch')
  if (screens.length !== 1) problems.push('project.pbxproj：找不到唯一的 Screens 组')
  if (!screensTarget) problems.push('project.pbxproj：找不到 LatchScreens 目标')
  if (!product) problems.push('project.pbxproj：找不到 Latch 目标')
  const screensId = screens[0]?.id
  for (const target of targets) {
    if (target === screensTarget || !screensId) continue
    if ([...list(target.value.fileSystemSynchronizedGroups), ...list(target.value.children)].includes(screensId))
      problems.push(`project.pbxproj：只有 LatchScreens 目标构建 Screens/，${String(target.value.name)} 不能`)
  }
  const configurations = (owner: Record<string, Plist> | undefined) => list(dict(owner?.buildConfigurationList)?.buildConfigurations)
  const screensConfigs = new Set(configurations(screensTarget?.value))
  const projectEntry = entries.find(item => item.value.isa === 'PBXProject')
  // The Latch target's own settings and the project's, which it inherits.
  const productConfigs = [...configurations(product?.value), ...configurations(projectEntry?.value)]
  for (const id of productConfigs) {
    const config = dict(id)
    if (!config) continue
    if (config.baseConfigurationReference !== undefined)
      problems.push('project.pbxproj：Latch 与项目的配置不引用 xcconfig 文件，设置都写在项目里')
    const settings = dict(id)?.buildSettings
    if (typeof settings !== 'object' || Array.isArray(settings)) continue
    for (const [key, value] of Object.entries(settings)) {
      if (!/^(?:SWIFT_ACTIVE_COMPILATION_CONDITIONS|OTHER_SWIFT_FLAGS|GCC_PREPROCESSOR_DEFINITIONS)\b/u.test(key)) continue
      const shown = Array.isArray(value) ? value.join(' ') : String(value)
      if (/LATCH_SCREENS/u.test(shown) || /\$\((?!inherited\))|\$\{/u.test(shown))
        problems.push(`project.pbxproj：Latch 与项目的 ${key} 不设置 LATCH_SCREENS，也不经变量间接设置`)
    }
  }
  for (const item of entries) {
    if (item.value.isa !== 'XCBuildConfiguration' || !/LATCH_SCREENS/u.test(JSON.stringify(item.value.buildSettings ?? ''))) continue
    const settings = dict(item.id)?.buildSettings as Record<string, Plist> | undefined
    if (
      !screensConfigs.has(item.id)
      || settings?.SUPPORTED_PLATFORMS !== 'iphonesimulator'
      || settings.PRODUCT_BUNDLE_IDENTIFIER !== 'codes.latch.ios.screens'
    )
      problems.push('project.pbxproj：只有 LatchScreens（仅模拟器）设置 LATCH_SCREENS')
  }
  return problems
}

/** The Swift files of the iOS App and core, for `checkScreensOnly`. */
export async function readIosSources(root: string): Promise<{ files: Array<{ path: string; text: string }>; project: string }> {
  const files: Array<{ path: string; text: string }> = []
  for (const top of ['App', 'Screens', 'Sources', 'Testkit']) {
    const base = posix.join('native/ios', top)
    let entries: string[] = []
    try {
      entries = await readdir(join(root, base), { recursive: true })
    } catch {
      continue
    }
    for (const entry of entries.toSorted())
      if (entry.endsWith('.swift')) files.push({ path: posix.join(base, entry), text: await readFile(join(root, base, entry), 'utf8') })
  }
  return { files, project: await readFile(join(root, 'native/ios/Latch.xcodeproj/project.pbxproj'), 'utf8') }
}
