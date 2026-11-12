// Builds a page draft with the Host's own tools: esbuild bundles each page through a resolver the Host wrote, and the
// TypeScript compiler checks it against a configuration and SDK declarations the Host wrote. Both run in child
// processes with an empty environment (no Latch secret can reach them), a private temporary folder and a time and
// memory limit. Neither runs the draft: esbuild and tsc only parse it, and the draft's own package.json, tsconfig, build
// configuration or plugins are never read. The bundle loads in the page frame only.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, open, realpath, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { APP_MODULE_BYTES, type PluginPackageBundle } from '@latch/protocol'
import { redactKnownSecrets } from '@latch/core/node-kit'
import { APP_SDK_DTS } from './app-sdk-types.ts'

export const APP_BUILD_LIMITS = {
  timeoutMs: 60_000,
  memoryMb: 512,
  /** Each page's bundle; the same limit the frame's runtime enforces. */
  outputBytes: APP_MODULE_BYTES,
  diagnostics: 100,
  diagnosticChars: 2000,
} as const

export interface BuildDiagnostic {
  /** `esbuild`: bundling (syntax, imports); `tsc`: the type check; `build`: the build itself (limits, time). */
  tool: 'esbuild' | 'tsc' | 'build'
  file?: string
  line?: number
  column?: number
  message: string
}

export interface BuiltModule {
  appId: string
  hash: string
  code: string
}

export interface BuildOutcome {
  status: 'ok' | 'failed' | 'timeout'
  diagnostics: BuildDiagnostic[]
  modules: BuiltModule[]
  /** Whether the TypeScript check ran (it is skipped when the compiler is not installed). */
  typeChecked: boolean
  durationMs: number
}

export interface BuildTools {
  /** URL of esbuild's JavaScript API, which the bundling child imports. */
  esbuild: string
  /** The native TypeScript compiler, or undefined when it cannot be found. */
  tsc?: string
  /** `@types/react`'s folder for the type check's `react` paths. */
  reactTypes?: string
  /** `csstype`'s folder, which `@types/react` imports. */
  cssTypes?: string
  /** Folders the tools may read besides the build's own temporary folder (the sandbox's second layer). */
  readable?: string[]
}

/** What every build runs and reads: Node's own binary, and esbuild's package with its binary. */
interface RuntimeTools {
  /** Folders whose contents the tools read. */
  folders: string[]
  /** Programs the tools may start: Node itself and esbuild's binary. */
  executables: string[]
}
let runtime: RuntimeTools | undefined
function runtimeTools(): RuntimeTools {
  if (runtime) return runtime
  // Only Node's binary, never the folder it is in: under /usr/local or Homebrew that folder holds everything else.
  const node = realpathSync(process.execPath)
  const found: RuntimeTools = { folders: [], executables: [node] }
  try {
    const esbuildFolder = packageFolder(import.meta.url, 'esbuild')
    const binaryFolder = packageFolder(join(esbuildFolder, 'package.json'), `@esbuild/${process.platform}-${process.arch}`)
    found.folders.push(esbuildFolder, binaryFolder)
    found.executables.push(realpathSync(join(binaryFolder, 'bin', 'esbuild')))
  } catch {
    // esbuild finds its binary itself; the sandbox then refuses it and the build reports the failure.
  }
  runtime = found
  return found
}

/** The folder of the package whose `package.json` `from` resolves `name` to, by its real path. */
function packageFolder(from: string, name: string): string {
  return dirname(realpathSync(createRequire(from).resolve(`${name}/package.json`)))
}

/** The Host's own esbuild, TypeScript compiler and React declarations, found from the Host's own dependencies. */
export function hostBuildTools(): BuildTools {
  const require = createRequire(import.meta.url)
  const esbuild = import.meta.resolve('esbuild')
  let tsc: string | undefined
  let reactTypes: string | undefined
  let cssTypes: string | undefined
  const readable: string[] = []
  try {
    const typescript = require.resolve('typescript/package.json')
    const platform = packageFolder(typescript, `@typescript/typescript-${process.platform}-${process.arch}`)
    tsc = join(platform, 'lib', process.platform === 'win32' ? 'tsc.exe' : 'tsc')
    reactTypes = packageFolder(import.meta.url, '@types/react')
    cssTypes = packageFolder(join(reactTypes, 'package.json'), 'csstype')
    readable.push(platform, reactTypes, cssTypes)
  } catch {
    tsc = undefined
  }
  return { esbuild, readable, ...(tsc && reactTypes && cssTypes ? { tsc, reactTypes, cssTypes } : {}) }
}

/**
 * The second layer around both tools on macOS (`sandbox-exec`); the first is that neither tool is pointed at anything
 * outside the draft (`noResolve`, the in-memory resolver). The profile denies: sockets (`network*`); every Mach service
 * (`mach-lookup`: no preferences daemon, no LaunchServices, so `open` and `defaults` fail inside, and neither tool needs
 * one); starting any program but Node, esbuild's binary and tsc; writing anywhere but the build's folder and /dev/null;
 * and reading file contents under the home folders, other volumes, the temporary folders, /opt, /usr/local and the
 * Host's data directory, except the build's folder and the tools' own files. Names and sizes there stay visible (Node
 * resolves paths through them), and system folders such as /System and /usr/lib stay readable.
 */
const SANDBOX_EXEC = '/usr/bin/sandbox-exec'
const sandboxAvailable = (() => {
  try {
    return process.platform === 'darwin' && statSync(SANDBOX_EXEC).isFile()
  } catch {
    return false
  }
})()
export interface SandboxPaths {
  /** The build's own folder, by its real path. */
  folder: string
  /** Folders the tools read. */
  readable: readonly string[]
  /** Programs the tools may start (and read). */
  executables: readonly string[]
  /** Further folders whose contents no tool reads: the Host's data directory. */
  hidden?: readonly string[]
}
export function sandboxProfile({ folder, readable, executables, hidden = [] }: SandboxPaths): string {
  const quoted = (path: string) => {
    if (/["\\\n\r]/u.test(path)) throw new Error('Unsupported path for the build sandbox')
    return `"${path}"`
  }
  const subpaths = (paths: readonly string[]) => paths.map(path => `(subpath ${quoted(path)})`).join(' ')
  const literals = (paths: readonly string[]) => paths.map(path => `(literal ${quoted(path)})`).join(' ')
  const closed = ['/Users', '/Volumes', '/private/tmp', '/private/var/folders', '/private/var/root', '/opt', '/usr/local', ...hidden]
  return [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    '(deny mach-lookup)',
    '(deny process-exec*)',
    `(allow process-exec ${literals(executables)})`,
    `(deny file-read-data ${subpaths(closed)})`,
    `(allow file-read-data (subpath ${quoted(folder)}) ${subpaths(readable)} ${literals(executables)})`,
    '(deny file-write*)',
    `(allow file-write* (subpath ${quoted(folder)}) (literal "/dev/null"))`,
  ].join('\n')
}

/**
 * The bundling child, run as `node --input-type=module -e`. It reads the draft's files from stdin and answers on stdout.
 * Every import goes through the resolver below: relative paths inside the draft, and the three modules the frame's
 * runtime provides (`globalThis.__latchModules`). Nothing is read from disk: the draft lives in memory, in a namespace of
 * its own.
 */
const WORKER = String.raw`
const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
const esbuild = await import(input.esbuild)
const files = new Map(input.files.map(file => [file.path, file.content]))
const RUNTIME = new Set(['react', 'react/jsx-runtime', '@latch/app-sdk'])
const EXTENSIONS = ['', '.tsx', '.ts', '/index.tsx', '/index.ts']
const normalize = (from, request) => {
  const parts = from ? from.split('/').slice(0, -1) : []
  for (const part of request.split('/')) {
    if (part === '.' || part === '') continue
    if (part === '..') {
      if (!parts.length) return undefined
      parts.pop()
    } else parts.push(part)
  }
  return parts.join('/')
}
const loaderOf = path => {
  const lower = path.toLowerCase()
  if (lower.endsWith('.tsx')) return 'tsx'
  if (lower.endsWith('.ts')) return 'ts'
  if (lower.endsWith('.css')) return 'css'
  if (lower.endsWith('.png') || lower.endsWith('.webp')) return 'image'
  return undefined
}
const resolver = {
  name: 'latch-draft',
  setup(build) {
    build.onResolve({ filter: /.*/ }, args => {
      if (args.kind === 'entry-point') return { path: args.path, namespace: 'draft' }
      if (RUNTIME.has(args.path)) return { path: args.path, namespace: 'latch-runtime' }
      if (args.path.startsWith('./') || args.path.startsWith('../')) {
        const base = normalize(args.importer, args.path)
        if (base !== undefined)
          for (const suffix of EXTENSIONS) {
            const path = base + suffix
            if (files.has(path) && loaderOf(path)) return { path, namespace: 'draft' }
          }
        return { errors: [{ text: '找不到草稿里的 ' + args.path }] }
      }
      return { errors: [{ text: '不允许导入 ' + args.path + '：只能导入草稿里的相对路径、react、react/jsx-runtime 与 @latch/app-sdk' }] }
    })
    build.onLoad({ filter: /.*/, namespace: 'latch-runtime' }, args => ({
      contents: 'module.exports = globalThis.__latchModules[' + JSON.stringify(args.path) + ']',
      loader: 'js',
    }))
    build.onLoad({ filter: /.*/, namespace: 'draft' }, args => {
      const content = files.get(args.path)
      const loader = loaderOf(args.path)
      if (content === undefined || !loader) return { errors: [{ text: '草稿里没有可构建的 ' + args.path }] }
      if (loader === 'css')
        return {
          contents: 'const style = document.createElement("style"); style.textContent = ' + JSON.stringify(content) + '; document.head.appendChild(style)',
          loader: 'js',
        }
      if (loader === 'image') return { contents: Buffer.from(content, 'base64'), loader: 'dataurl' }
      return { contents: content, loader }
    })
  },
}
const diagnostics = []
const modules = []
for (const page of input.entries) {
  try {
    const result = await esbuild.build({
      entryPoints: [page.entry],
      absWorkingDir: process.cwd(),
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      jsx: 'automatic',
      jsxImportSource: 'react',
      tsconfigRaw: {},
      define: { 'process.env.NODE_ENV': '"production"' },
      legalComments: 'none',
      charset: 'utf8',
      logLevel: 'silent',
      plugins: [resolver],
    })
    for (const warning of result.warnings) diagnostics.push(entry(warning, 'warning'))
    const output = result.outputFiles.find(file => file.path.endsWith('.js')) ?? result.outputFiles[0]
    modules.push({ appId: page.appId, code: output ? output.text : '' })
  } catch (error) {
    if (!Array.isArray(error?.errors)) throw error
    for (const item of error.errors) diagnostics.push(entry(item, 'error'))
  }
}
function entry(item, kind) {
  const location = item.location
  return {
    kind,
    ...(location ? { file: location.file.replace(/^draft:/, ''), line: location.line, column: location.column + 1 } : {}),
    message: String(item.text),
  }
}
process.stdout.write(JSON.stringify({ modules, diagnostics }))
`

interface ChildResult {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  timedOut: boolean
  overflow: boolean
}

/** One tool, in an empty environment and the build's folder, killed at the deadline; its output is bounded. */
function runChild(
  command: string,
  args: string[],
  options: { cwd: string; deadline: number; stdin?: string; outputLimit: number; sandbox?: string },
): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const [file, argv] = options.sandbox ? [SANDBOX_EXEC, ['-p', options.sandbox, command, ...args]] : [command, args]
    const child = spawn(file, argv, {
      cwd: options.cwd,
      // No variable of the Host's: not a key, not a token, not a path. GOMEMLIMIT bounds the Go tools' heap.
      env: { GOMEMLIMIT: `${APP_BUILD_LIMITS.memoryMb}MiB` },
      stdio: ['pipe', 'pipe', 'pipe'],
      // A group of its own, so a timeout ends every process the tool started (esbuild's Go binary among them).
      detached: process.platform !== 'win32',
    })
    const out: Buffer[] = []
    let size = 0
    let overflow = false
    let timedOut = false
    const kill = () => {
      try {
        if (child.pid !== undefined && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
    const timer = setTimeout(
      () => {
        timedOut = true
        kill()
      },
      Math.max(0, options.deadline - Date.now()),
    )
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > options.outputLimit) {
        overflow = true
        kill()
        return
      }
      out.push(chunk)
    })
    // Messages a tool prints on stderr are not read: what a build reports comes from its structured output.
    child.stderr.resume()
    child.on('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout: Buffer.concat(out).toString('utf8'), timedOut, overflow })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(options.stdin ?? '')
  })
}

const clean = (text: string) => redactKnownSecrets(text).slice(0, APP_BUILD_LIMITS.diagnosticChars)

/** `file(line,col): error TS1234: message` lines of `tsc --pretty false`, with the follow-up lines joined. */
export function parseTscOutput(output: string): BuildDiagnostic[] {
  const out: BuildDiagnostic[] = []
  let kept = false
  for (const line of output.split(/\r?\n/u)) {
    const match = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/u.exec(line)
    // Only the draft's own files: anything about another file is dropped with its message, which could quote that file.
    if (match && !/^src\/(?!.*\.\.)/u.test(match[1]!)) {
      kept = false
      continue
    }
    if (match) {
      kept = true
      out.push({
        tool: 'tsc',
        file: match[1]!.replace(/^src\//u, ''),
        line: Number(match[2]),
        column: Number(match[3]),
        message: `${match[4]}: ${match[5]}`,
      })
      continue
    }
    if (/^error TS\d+:/u.test(line)) kept = false
    else if (line.startsWith('  ') && kept && out.length) out.at(-1)!.message += `\n${line.trim()}`
  }
  return out
}

async function writePrivate(path: string, content: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const fd = await open(path, 'wx', 0o600)
  try {
    await fd.writeFile(content)
  } finally {
    await fd.close()
  }
}

/**
 * The type check's configuration: strict, no emit, no ambient types, and `noResolve` with every file listed, so the
 * compiler reads only the draft, the Host's SDK declarations and React's own declarations, whatever the draft imports
 * or references.
 */
function typeCheckConfig(reactTypes: string, cssTypes: string, sources: string[]): string {
  return JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      noResolve: true,
      types: [],
      typeRoots: [],
      jsx: 'react-jsx',
      module: 'esnext',
      moduleResolution: 'bundler',
      target: 'es2022',
      lib: ['es2022', 'dom', 'dom.iterable'],
      skipLibCheck: true,
      isolatedModules: true,
      allowImportingTsExtensions: true,
      noFallthroughCasesInSwitch: true,
      paths: {
        react: [join(reactTypes, 'index.d.ts')],
        'react/jsx-runtime': [join(reactTypes, 'jsx-runtime.d.ts')],
        csstype: [join(cssTypes, 'index.d.ts')],
      },
    },
    files: [
      'latch/app-sdk.d.ts',
      join(reactTypes, 'index.d.ts'),
      join(reactTypes, 'global.d.ts'),
      join(reactTypes, 'jsx-runtime.d.ts'),
      join(cssTypes, 'index.d.ts'),
      ...sources.map(path => `src/${path}`),
    ],
  })
}

/**
 * Builds every page of `bundle` (its entries must be `.ts` or `.tsx`). Never throws for a fault of the draft: those are
 * diagnostics; it throws only when a tool cannot be started at all.
 */
export async function buildPages(
  bundle: PluginPackageBundle,
  tools: BuildTools = hostBuildTools(),
  options: { timeoutMs?: number; hidden?: readonly string[] } = {},
): Promise<BuildOutcome> {
  const started = Date.now()
  const timeoutMs = options.timeoutMs ?? APP_BUILD_LIMITS.timeoutMs
  const deadline = started + timeoutMs
  const apps = bundle.manifest.apps ?? []
  const diagnostics: BuildDiagnostic[] = []
  const finish = (status: BuildOutcome['status'], modules: BuiltModule[], typeChecked: boolean): BuildOutcome => ({
    status,
    diagnostics: diagnostics.slice(0, APP_BUILD_LIMITS.diagnostics).map(item => ({ ...item, message: clean(item.message) })),
    modules: status === 'ok' ? modules : [],
    typeChecked,
    durationMs: Date.now() - started,
  })
  if (!apps.length || apps.some(app => !/\.tsx?$/iu.test(app.entry))) {
    diagnostics.push({ tool: 'build', message: '页面入口要是 .ts 或 .tsx 文件。' })
    return finish('failed', [], false)
  }
  // Only the draft's sources and assets; anything else it holds (a package.json, a tsconfig, a config) stays out.
  const files = bundle.files.filter(file => /\.(?:tsx?|css|png|webp)$/iu.test(file.path))
  const sources = files.filter(file => /\.tsx?$/iu.test(file.path))
  const folder = await mkdtemp(join(tmpdir(), 'latch-app-build-'))
  try {
    const typeCheck = tools.tsc && tools.reactTypes && tools.cssTypes ? tools : undefined
    const own = runtimeTools()
    const sandbox = sandboxAvailable
      ? sandboxProfile({
          folder: await realpath(folder),
          readable: [...own.folders, ...(tools.readable ?? [])],
          executables: [...own.executables, ...(tools.tsc ? [await realpath(tools.tsc)] : [])],
          hidden: await Promise.all((options.hidden ?? []).map(path => realpath(path).catch(() => path))),
        })
      : undefined
    let checking: Promise<ChildResult | undefined> = Promise.resolve(undefined)
    if (typeCheck) {
      for (const file of sources) await writePrivate(join(folder, 'src', file.path), file.content)
      await writePrivate(join(folder, 'latch', 'app-sdk.d.ts'), APP_SDK_DTS)
      await writePrivate(
        join(folder, 'tsconfig.json'),
        typeCheckConfig(
          typeCheck.reactTypes!,
          typeCheck.cssTypes!,
          sources.map(file => file.path),
        ),
      )
      checking = runChild(typeCheck.tsc!, ['-p', 'tsconfig.json', '--pretty', 'false'], {
        cwd: folder,
        deadline,
        outputLimit: 1024 * 1024,
        ...(sandbox ? { sandbox } : {}),
      })
    }
    const bundling = runChild(
      process.execPath,
      ['--disable-sigusr1', `--max-old-space-size=${APP_BUILD_LIMITS.memoryMb}`, '--input-type=module', '-e', WORKER],
      {
        cwd: folder,
        deadline,
        ...(sandbox ? { sandbox } : {}),
        outputLimit: apps.length * (APP_BUILD_LIMITS.outputBytes + 1024 * 1024) + 1024 * 1024,
        stdin: JSON.stringify({
          esbuild: tools.esbuild,
          files: files.map(file => ({ path: file.path, content: file.content })),
          entries: apps.map(app => ({ appId: app.id, entry: app.entry.replace(/^\.\//u, '') })),
        }),
      },
    )
    const [checked, bundled] = await Promise.all([checking, bundling])
    if (bundled.timedOut || checked?.timedOut) {
      diagnostics.push({ tool: 'build', message: `构建超过 ${Math.ceil(timeoutMs / 1000)} 秒，已停止。` })
      return finish('timeout', [], typeCheck !== undefined)
    }
    const modules: BuiltModule[] = []
    let failed = false
    if (bundled.overflow) {
      failed = true
      diagnostics.push({ tool: 'build', message: '构建产物超过 2 MiB。' })
    } else if (bundled.code !== 0) {
      failed = true
      diagnostics.push({ tool: 'build', message: bundled.signal ? '构建进程被停止（可能超过内存上限）。' : '构建进程出错。' })
    } else {
      const result = JSON.parse(bundled.stdout) as {
        modules: Array<{ appId: string; code: string }>
        diagnostics: Array<{ kind: 'error' | 'warning'; file?: string; line?: number; column?: number; message: string }>
      }
      for (const item of result.diagnostics) {
        if (item.kind === 'error') failed = true
        diagnostics.push({
          tool: 'esbuild',
          ...(item.file ? { file: item.file } : {}),
          ...(item.line ? { line: item.line, column: item.column ?? 1 } : {}),
          message: item.kind === 'warning' ? `警告：${item.message}` : item.message,
        })
      }
      for (const module of result.modules) {
        const bytes = Buffer.byteLength(module.code)
        if (bytes > APP_BUILD_LIMITS.outputBytes) {
          failed = true
          diagnostics.push({ tool: 'build', message: `页面 ${module.appId} 的构建产物超过 2 MiB。` })
          continue
        }
        modules.push({ appId: module.appId, code: module.code, hash: createHash('sha256').update(module.code).digest('hex') })
      }
      if (modules.length !== apps.length) failed = true
    }
    if (checked) {
      if (checked.overflow) {
        failed = true
        diagnostics.push({ tool: 'build', message: '类型检查的输出太多。' })
      } else if (checked.code !== 0) {
        const found = parseTscOutput(checked.stdout)
        failed = true
        diagnostics.push(...(found.length ? found : [{ tool: 'tsc' as const, message: '类型检查没有通过。' }]))
      }
    }
    return finish(failed ? 'failed' : 'ok', modules, typeCheck !== undefined)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}
