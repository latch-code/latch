import { createHash, randomUUID } from 'node:crypto'
import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppSnapshot, PluginBuild, PluginPackageBundle, PluginPackageDetail, PluginPackageSummary } from '@latch/protocol'
import type { TestDevice } from '@latch/testkit'
import { buildPages, hostBuildTools, parseTscOutput, sandboxProfile } from '../src/app-build.ts'
import { APP_IMPORT_LIMITS, readSessionDraft } from '../src/app-import.ts'
import { AppBuilds } from '../src/app-builds.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function temp(prefix: string): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), prefix))
  cleanup.push(() => rm(folder, { recursive: true, force: true }))
  return folder
}

const PAGE = `import { useState } from 'react'
import { defineApp, type PageProps } from '@latch/app-sdk'
import './style.css'
import logo from './logo.png'

function Page({ latch, ui }: PageProps) {
  const [count, setCount] = useState(0)
  return (
    <ui.Group title="计数">
      <img src={logo} alt="" />
      <ui.Button onClick={() => setCount(count + 1)}>{String(count)}</ui.Button>
      <ui.Row title={latch.host.info().theme} />
    </ui.Group>
  )
}

export default defineApp({ page: Page })
`
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')

function manifest(id = 'draft-app', entry = 'index.tsx', extra: Record<string, unknown> = {}) {
  return {
    formatVersion: 2,
    id,
    name: '草稿应用',
    version: '0.1.0',
    description: '',
    requires: { appSdk: '^1' },
    apps: [{ id: 'main', title: '草稿应用', entry, dataVersion: 1, capabilities: { 'tasks.read': true } }],
    ...extra,
  }
}

function bundle(files: Record<string, string>, entry = 'index.tsx'): PluginPackageBundle {
  return {
    manifest: manifest('draft-app', entry) as PluginPackageBundle['manifest'],
    files: Object.entries(files).map(([path, content]) => ({ path, content })),
  }
}

/** A draft folder: `latch-app/` with the files given (strings as text, Buffers as bytes). */
async function draftFolder(files: Record<string, string | Buffer>, root?: string): Promise<string> {
  const folder = root ?? (await temp('latch-draft-'))
  for (const [path, content] of Object.entries(files)) {
    const target = join(folder, 'latch-app', path)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, content)
  }
  return folder
}

const draftCode = async (promise: Promise<unknown>) => {
  try {
    await promise
    return 'ok'
  } catch (error) {
    return (error as { code?: string }).code
  }
}

/** A stand-in for tsc: a Node script (the sandbox lets the tools start only Node, esbuild and tsc). */
async function fakeTool(folder: string, name: string, body: string): Promise<string> {
  const tool = join(folder, name)
  await writeFile(tool, `#!${realpathSync(process.execPath)}\n${body}\n`)
  await chmod(tool, 0o755)
  return tool
}

describe('importing a page draft from a session folder', () => {
  it('takes the manifest, sources, styles and images, and leaves out every other file', async () => {
    const folder = await draftFolder({
      'latch-app.json': JSON.stringify(manifest()),
      'index.tsx': PAGE,
      'style.css': 'body { margin: 0 }',
      'logo.png': PNG,
      'sdk.d.ts': '// the Host writes its own',
      'README.md': '# guide',
      'package.json': '{"scripts":{"postinstall":"touch /tmp/x"}}',
      'tsconfig.json': '{"compilerOptions":{"strict":false}}',
      'esbuild.config.js': 'export default {}',
      'node_modules/react/index.js': 'module.exports = {}',
    })
    const draft = await readSessionDraft(folder)
    expect(draft.bundle.manifest.id).toBe('draft-app')
    expect(draft.bundle.files.map(file => file.path).sort()).toEqual(['index.tsx', 'logo.png', 'style.css'])
    expect(draft.bundle.files.find(file => file.path === 'logo.png')?.content).toBe(PNG.toString('base64'))
    expect(draft.skipped).toBe(3)
  })

  it('refuses links, modules, Host code, panels, secrets and drafts over the limits', async () => {
    const base = { 'latch-app.json': JSON.stringify(manifest()), 'index.tsx': PAGE }
    const outside = await temp('latch-outside-')
    await writeFile(join(outside, 'secret.ts'), 'export const x = 1')

    const linked = await draftFolder(base)
    await symlink(join(outside, 'secret.ts'), join(linked, 'latch-app', 'other.ts'))
    expect(await draftCode(readSessionDraft(linked))).toBe('app-import-link')

    const linkedFolder = await temp('latch-draft-')
    await symlink(outside, join(linkedFolder, 'latch-app'))
    expect(await draftCode(readSessionDraft(linkedFolder))).toBe('app-import-link')

    const nested = await draftFolder(base)
    await symlink(outside, join(nested, 'latch-app', 'lib'))
    expect(await draftCode(readSessionDraft(nested))).toBe('app-import-link')

    const hard = await draftFolder(base)
    await link(join(outside, 'secret.ts'), join(hard, 'latch-app', 'hard.ts'))
    expect(await draftCode(readSessionDraft(hard))).toBe('app-import-link')

    expect(await draftCode(readSessionDraft(await draftFolder({ ...base, 'helper.mjs': 'export {}' })))).toBe('app-import-module')
    for (const extra of [{ host: ['host.mjs'] }, { panels: [] }])
      expect(
        await draftCode(
          readSessionDraft(await draftFolder({ ...base, 'latch-app.json': JSON.stringify(manifest('draft-app', 'index.tsx', extra)) })),
        ),
      ).toBe('app-import-code')
    expect(
      await draftCode(readSessionDraft(await draftFolder({ ...base, 'latch-app.json': JSON.stringify(manifest('draft-app', 'page.js')) }))),
    ).toBe('app-import-manifest')
    expect(
      await draftCode(readSessionDraft(await draftFolder({ ...base, 'keys.ts': `export const key = 'sk-ant-api03-${'a'.repeat(40)}'` }))),
    ).toBe('app-import-secret')
    expect(await draftCode(readSessionDraft(await draftFolder({ ...base, 'fake.png': 'not an image' })))).toBe('app-import-image')

    const many = Object.fromEntries(Array.from({ length: APP_IMPORT_LIMITS.files + 1 }, (_, index) => [`part-${index}.ts`, 'export {}']))
    expect(await draftCode(readSessionDraft(await draftFolder({ ...base, ...many })))).toBe('app-import-limit')
    expect(await draftCode(readSessionDraft(await draftFolder({ ...base, 'big.ts': 'x'.repeat(APP_IMPORT_LIMITS.fileBytes + 1) })))).toBe(
      'app-import-limit',
    )
    const large = Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`large-${index}.ts`, `// ${'y'.repeat(500 * 1024)}`]))
    expect(await draftCode(readSessionDraft(await draftFolder({ ...base, ...large })))).toBe('app-import-limit')
    expect(await draftCode(readSessionDraft(await temp('latch-empty-')))).toBe('app-draft-missing')
  })
})

describe('building a page draft with the Host tools', () => {
  it('bundles a page against the runtime modules and type-checks it', async () => {
    const outcome = await buildPages(bundle({ 'index.tsx': PAGE, 'style.css': 'body{margin:0}', 'logo.png': PNG.toString('base64') }))
    expect(outcome.diagnostics).toEqual([])
    expect(outcome).toMatchObject({ status: 'ok', typeChecked: true })
    const code = outcome.modules[0]!.code
    expect(code).toContain('globalThis.__latchModules["react"]')
    expect(code).toContain('globalThis.__latchModules["react/jsx-runtime"]')
    expect(code).toContain('globalThis.__latchModules["@latch/app-sdk"]')
    expect(code).toContain('data:image/png;base64,')
    expect(code).toMatch(/^export \{/mu)
  })

  it('reports type errors and refused imports as file:line:col diagnostics, redacted', async () => {
    const outcome = await buildPages(
      bundle({
        'index.tsx': `import { defineApp } from '@latch/app-sdk'
import { readFileSync } from 'node:fs'
import lodash from 'lodash'
const key: number = 'sk-ant-api03-${'b'.repeat(40)}'
export default defineApp({ page: () => null, migrate: () => [readFileSync, lodash, key] as never })
`,
      }),
    )
    expect(outcome.status).toBe('failed')
    expect(outcome.modules).toEqual([])
    const refused = outcome.diagnostics.filter(item => item.tool === 'esbuild')
    expect(refused.map(item => [item.file, item.line])).toEqual([
      ['index.tsx', 2],
      ['index.tsx', 3],
    ])
    expect(refused[0]!.message).toContain('不允许导入 node:fs')
    const typed = outcome.diagnostics.find(item => item.tool === 'tsc' && item.line === 4)
    expect(typed).toMatchObject({ file: 'index.tsx', column: 7 })
    expect(JSON.stringify(outcome.diagnostics)).not.toContain('sk-ant-api03')
  })

  it('ignores the draft’s own tsconfig, package.json and build configuration', async () => {
    const outcome = await buildPages(
      bundle({
        'index.tsx': `import { defineApp } from '@latch/app-sdk'
function loose(value) { return value }
export default defineApp({ page: () => <div>{loose(1)}</div> })
`,
        'tsconfig.json': JSON.stringify({ compilerOptions: { strict: false, noImplicitAny: false, jsxImportSource: 'preact' } }),
        'package.json': JSON.stringify({ imports: { '#x': './x.js' }, browser: { react: './evil.js' } }),
        'esbuild.config.mjs': 'export default { plugins: [] }',
        'evil.js': 'globalThis.evil = true',
      }),
    )
    // strict still applies, so the implicit any is reported, and JSX still comes from the runtime's React.
    expect(outcome.diagnostics.some(item => item.tool === 'tsc' && item.message.startsWith('TS7006'))).toBe(true)
    const relaxed = await buildPages(
      bundle({
        'index.tsx': `import { defineApp } from '@latch/app-sdk'
export default defineApp({ page: () => <div /> })
`,
        'tsconfig.json': JSON.stringify({ compilerOptions: { jsxImportSource: 'preact' } }),
        'package.json': JSON.stringify({ browser: { react: './evil.js' } }),
      }),
    )
    expect(relaxed.status).toBe('ok')
    expect(relaxed.modules[0]!.code).toContain('globalThis.__latchModules["react/jsx-runtime"]')
    expect(relaxed.modules[0]!.code).not.toContain('preact')
    expect(relaxed.modules[0]!.code).not.toContain('evil')
  })

  it('reads nothing outside the draft for the type check, however the draft names another file', async () => {
    const outside = await temp('latch-outside-')
    const target = join(outside, 'config.ts')
    await writeFile(target, "export const TOKEN = 'outside-value-QWERTY'\nexport const NUMBER: 'outside-type-ZXCV' = 'outside-type-ZXCV'\n")
    await writeFile(join(outside, 'notes.ts'), "const NOTE: number = 'outside-note-ASDF'\n")
    const traversal = '../'.repeat(20) + target.slice(1)
    const forms = {
      'typeof import': `type M = typeof import(${JSON.stringify(target)})\nconst a: number = (null as unknown as M).TOKEN\nexport default a\n`,
      'import type': `import type { NUMBER } from ${JSON.stringify(traversal)}\nconst b: number = '' as unknown as typeof NUMBER\nexport default b\n`,
      'reference path': `/// <reference path=${JSON.stringify(join(outside, 'notes.ts'))} />\nexport default 1\n`,
    }
    for (const [form, source] of Object.entries(forms)) {
      const outcome = await buildPages(bundle({ 'index.tsx': source }))
      expect(outcome.typeChecked, form).toBe(true)
      expect(JSON.stringify(outcome.diagnostics), form).not.toMatch(/outside-(value|type|note)/u)
      expect(
        outcome.diagnostics.every(item => item.tool !== 'tsc' || item.file === 'index.tsx'),
        form,
      ).toBe(true)
    }
  })

  it('writes a sandbox profile that denies sockets, Mach services, other programs, writes and the closed folders', () => {
    const profile = sandboxProfile({
      folder: '/private/var/folders/x/T/latch-app-build-1',
      readable: ['/opt/tools/esbuild'],
      executables: ['/usr/local/bin/node'],
      hidden: ['/Users/me/Library/Application Support/Latch/Host'],
    })
    expect(profile).toContain('(deny network*)')
    expect(profile).toContain('(deny mach-lookup)')
    expect(profile).toContain('(deny process-exec*)\n(allow process-exec (literal "/usr/local/bin/node"))')
    expect(profile).toContain('(deny file-write*)')
    expect(profile).toMatch(
      /\(deny file-read-data .*\(subpath "\/Users"\).*\(subpath "\/usr\/local"\).*\(subpath "\/Users\/me\/Library\/Application Support\/Latch\/Host"\)\)/u,
    )
    // Node's binary alone, never the folder it is in.
    expect(profile).toContain(
      '(allow file-read-data (subpath "/private/var/folders/x/T/latch-app-build-1") (subpath "/opt/tools/esbuild") (literal "/usr/local/bin/node"))',
    )
    expect(() => sandboxProfile({ folder: '/tmp/a"b', readable: [], executables: [] })).toThrow()
  })

  it.runIf(process.platform === 'darwin')(
    'keeps the tools from reading closed folders, writing, starting programs or reaching Mach services',
    async () => {
      const outside = await temp('latch-outside-')
      await writeFile(join(outside, 'secret.txt'), 'outside-secret-POIU')
      const data = await temp('latch-data-')
      await writeFile(join(data, 'providers.json'), 'data-secret-LKJH')
      const folder = await temp('latch-tool-')
      const tool = await fakeTool(
        folder,
        'probing-tsc',
        `const fs = require('node:fs'), { spawnSync } = require('node:child_process')
const read = path => { try { return fs.readFileSync(path, 'utf8') } catch (error) { return error.code } }
const run = (file, args) => { const result = spawnSync(file, args, { encoding: 'utf8' }); return result.error ? result.error.code : String(result.status) }
let wrote = 'no'
try { fs.writeFileSync(${JSON.stringify(join(outside, 'written'))}, 'x'); wrote = 'yes' } catch {}
const report = ['READ ' + read(${JSON.stringify(join(outside, 'secret.txt'))}), 'DATA ' + read(${JSON.stringify(join(data, 'providers.json'))}), 'WROTE ' + wrote, 'DEFAULTS ' + run('/usr/bin/defaults', ['read', '-g', 'AppleLocale']), 'OPEN ' + run('/usr/bin/open', ['https://example.com/'])]
console.log('src/index.tsx(1,1): error TS9999: ' + report.join(' | '))
process.exit(1)`,
      )
      const outcome = await buildPages(
        bundle({ 'index.tsx': 'export default null' }),
        { ...hostBuildTools(), tsc: tool },
        { hidden: [data] },
      )
      const message = outcome.diagnostics.find(item => item.message.startsWith('TS9999'))?.message ?? ''
      expect(message).toContain('READ EPERM')
      expect(message).toContain('DATA EPERM')
      expect(message).toContain('WROTE no')
      expect(message).toContain('DEFAULTS EPERM')
      expect(message).toContain('OPEN EPERM')
      await expect(stat(join(outside, 'written'))).rejects.toMatchObject({ code: 'ENOENT' })
    },
  )

  it.runIf(process.platform === 'darwin')('denies Mach services even to a program the profile would let start', async () => {
    const folder = await temp('latch-mach-')
    const profile = sandboxProfile({
      folder: realpathSync(folder),
      readable: [],
      executables: ['/usr/bin/defaults', '/usr/bin/open'],
    })
    const run = (file: string, args: string[]) =>
      promisify(execFile)('/usr/bin/sandbox-exec', ['-p', profile, file, ...args], { cwd: folder, env: {} }).then(
        result => ({ ok: true, text: result.stdout }),
        (error: { stderr?: string }) => ({ ok: false, text: error.stderr ?? '' }),
      )
    // Without cfprefsd the global domain cannot be read; without LaunchServices nothing can open a URL.
    expect((await run('/usr/bin/defaults', ['read', '-g', 'AppleLocale'])).ok).toBe(false)
    expect((await run('/usr/bin/open', ['https://example.com/'])).ok).toBe(false)
  })

  it('never runs the draft: top-level code that writes a marker leaves none', async () => {
    const folder = await temp('latch-marker-')
    const marker = join(folder, 'ran')
    const outcome = await buildPages(
      bundle({
        'index.tsx': `import { defineApp } from '@latch/app-sdk'
const run = (globalThis as any)['req' + 'uire']
run('node:fs').writeFileSync(${JSON.stringify(marker)}, 'top level')
run('child_process').execSync(${JSON.stringify(`touch ${marker}-child`)})
await import(${JSON.stringify(`data:text/javascript,require('fs').writeFileSync('${marker}-import','x')`)}).catch(() => {})
export default defineApp({ page: () => null })
`,
        'helper.ts': `require('fs').writeFileSync(${JSON.stringify(`${marker}-helper`)}, 'x')\nexport {}\n`,
      }),
    )
    expect(outcome.status).toBe('failed')
    for (const name of ['ran', 'ran-child', 'ran-import', 'ran-helper'])
      await expect(stat(join(folder, name)), name).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('runs its tools with no Latch secret in the environment', async () => {
    const folder = await temp('latch-env-')
    const tool = join(folder, 'fake-tsc')
    // The tool reports its environment the way tsc reports an error, so it comes back as a diagnostic.
    await fakeTool(
      folder,
      'fake-tsc',
      "console.log('src/index.tsx(1,1): error TS9999: ENV ' + Object.entries(process.env).map(([k, v]) => k + '=' + v).join(' '))\nprocess.exit(1)",
    )
    const saved = { ...process.env }
    process.env.LATCH_API_KEY = `sk-ant-api03-${'c'.repeat(40)}`
    process.env.LATCH_TOKEN = `lmg1.${'D'.repeat(43)}`
    let env = ''
    try {
      const tools = hostBuildTools()
      const outcome = await buildPages(bundle({ 'index.tsx': 'export default null' }), { ...tools, tsc: tool })
      env = outcome.diagnostics.find(item => item.message.startsWith('TS9999'))?.message ?? ''
    } finally {
      process.env = saved
    }
    expect(env).toContain('GOMEMLIMIT=512MiB')
    expect(env).not.toContain('LATCH')
    expect(env).not.toContain('HOME=')
    expect(env).not.toContain('lmg1.')
  })

  it('stops a build at its time limit and refuses bundles over 2 MiB', async () => {
    const folder = await temp('latch-slow-')
    const tool = join(folder, 'slow-tsc')
    await fakeTool(folder, 'slow-tsc', 'setTimeout(() => {}, 30_000)')
    const tools = hostBuildTools()
    const slow = await buildPages(
      bundle({ 'index.tsx': 'export default null' }),
      { ...tools, tsc: tool, reactTypes: tools.reactTypes! },
      { timeoutMs: 500 },
    )
    expect(slow.status).toBe('timeout')
    expect(slow.diagnostics.at(-1)?.message).toContain('秒')

    const chunk = (index: number) => `export const part${index} = ${JSON.stringify('z'.repeat(800 * 1024))}\n`
    const large = await buildPages(
      bundle({
        'index.tsx': `import { part0 } from './a'\nimport { part1 } from './b'\nimport { part2 } from './c'\nexport default [part0, part1, part2]\n`,
        'a.ts': chunk(0),
        'b.ts': chunk(1),
        'c.ts': chunk(2),
      }),
      { esbuild: tools.esbuild },
    )
    expect(large.status).toBe('failed')
    expect(large.typeChecked).toBe(false)
    expect(large.diagnostics.map(item => item.message).join('\n')).toContain('2 MiB')
  })

  it('ends every process a tool started when the build times out', async () => {
    const folder = await temp('latch-group-')
    const tool = join(folder, 'forking-tsc')
    const token = `31.${Math.floor(Math.random() * 1e6)}`
    await fakeTool(
      folder,
      'forking-tsc',
      `require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 31_000)', 'sleep ${token}'], { stdio: 'ignore' })\nsetTimeout(() => {}, 30_000)`,
    )
    const outcome = await buildPages(bundle({ 'index.tsx': 'export default null' }), { ...hostBuildTools(), tsc: tool }, { timeoutMs: 800 })
    expect(outcome.status).toBe('timeout')
    await new Promise(resolve => setTimeout(resolve, 200))
    const left = await promisify(execFile)('/usr/bin/pgrep', ['-f', `sleep ${token}`]).then(
      result => result.stdout.trim(),
      () => '',
    )
    expect(left).toBe('')
  })

  it('keeps the builds file under its bound without dropping the draft’s or the applied build', async () => {
    const folder = await temp('latch-builds-')
    const builds = new AppBuilds(folder, Date.now, 6_000)
    const outcome = (code: string) => ({
      status: 'ok' as const,
      diagnostics: [],
      typeChecked: true,
      durationMs: 1,
      modules: [{ appId: 'main', hash: createHash('sha256').update(code).digest('hex'), code }],
    })
    const revision = (n: number) => String(n).repeat(64).slice(0, 64)
    const applied = revision(1)
    for (let n = 1; n <= 6; n++)
      await builds.record(
        'p',
        revision(n),
        outcome(`${n}`.repeat(1_500)),
        new Set([applied, revision(n), revision(n - 1)]),
        new Set([applied, revision(n)]),
      )
    const size = (await stat(join(folder, 'p.json'))).size
    expect(size).toBeLessThanOrEqual(6_000)
    const reopened = new AppBuilds(folder)
    expect((await reopened.module('p', applied, 'main'))?.bytes.toString()).toBe('1'.repeat(1_500))
    expect(await reopened.latest('p', revision(6))).toBeDefined()
  })

  it('reads tsc output as diagnostics and drops every message about a file outside the draft', () => {
    expect(
      parseTscOutput(
        "src/index.tsx(4,7): error TS2322: Type 'string' is not assignable to type 'number'.\n  more detail\n/etc/other.ts(1,1): error TS1005: SECRET\n  SECRET too\nsrc/../x.ts(1,1): error TS1: SECRET\nerror TS5023: SECRET option\n  SECRET",
      ),
    ).toEqual([
      {
        tool: 'tsc',
        file: 'index.tsx',
        line: 4,
        column: 7,
        message: "TS2322: Type 'string' is not assignable to type 'number'.\nmore detail",
      },
    ])
  })
})

async function fixture(options: Parameters<typeof startTestHost>[0] = {}) {
  const host = await startTestHost(options)
  cleanup.push(() => host.close())
  const owner = await host.enroll({ listener: 'unix' })
  return { host, owner }
}

async function session(owner: TestDevice, body: Record<string, unknown> = {}): Promise<string> {
  const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
    body: { prompt: '做一个页面', requestId: randomUUID(), mode: 'agent', ...body },
  })
  return sessionId
}

async function idle(host: TestHost, sessionId: string) {
  await expect.poll(async () => (await host.host.bridge.detail(sessionId)).summary.status, { timeout: 15_000 }).toBe('idle')
}

const importDraft = (owner: TestDevice, sessionId: string) =>
  owner.request('plugin-packages/import', { body: { requestId: randomUUID(), sessionId } })

const build = async (owner: TestDevice, id: string, revision: string) =>
  (await owner.json<{ build: PluginBuild }>(`plugin-packages/${id}/build`, { body: { requestId: randomUUID(), revision } })).build

describe('the build pipeline on the Host', () => {
  it('imports a session draft, builds it, applies only a built revision and serves that bundle', async () => {
    const { host, owner } = await fixture()
    const sessionId = await session(owner)
    await idle(host, sessionId)
    await draftFolder(
      {
        'latch-app.json': JSON.stringify(manifest()),
        'index.tsx': PAGE.replace("import './style.css'\nimport logo from './logo.png'\n", 'const logo = ""\n'),
      },
      host.workspaceRoot,
    )
    expect(await owner.json(`plugin-packages/session-draft?sessionId=${sessionId}`)).toEqual({ present: true })

    const imported = await importDraft(owner, sessionId)
    expect(imported.status).toBe(201)
    const draft = ((await imported.json()) as { package: PluginPackageDetail }).package
    expect(draft).toMatchObject({ id: 'draft-app', state: 'draft', source: { sessionId, dev: false }, pages: 1 })
    expect(await owner.json(`plugin-packages/session-draft?sessionId=${sessionId}`)).toEqual({ present: true, pluginId: 'draft-app' })

    const unbuilt = await owner.request(`plugin-packages/${draft.id}/apply`, {
      body: { requestId: randomUUID(), revision: draft.revision },
    })
    expect([unbuilt.status, ((await unbuilt.json()) as { error: string }).error]).toEqual([409, 'plugin-package-not-built'])

    const built = await build(owner, draft.id, draft.revision)
    expect(built).toMatchObject({ revision: draft.revision, status: 'ok', typeChecked: true, diagnostics: [] })
    const hash = built.modules[0]!.bundleHash
    // The preview takes the same bundle through the admin route.
    const preview = await owner.request(`plugin-packages/${draft.id}/builds/${hash}.js`)
    expect(preview.status).toBe(200)
    const bytes = Buffer.from(await preview.arrayBuffer())
    const summary = (await owner.json<{ packages: PluginPackageSummary[] }>('plugin-packages')).packages.find(item => item.id === draft.id)
    expect(summary).toMatchObject({ build: { status: 'ok', diagnostics: 0 }, preview: { revision: draft.revision } })

    const applied = await owner.confirmed(`plugin-packages/${draft.id}/apply`, {
      body: { requestId: randomUUID(), revision: draft.revision },
    })
    expect(applied.status).toBe(200)
    const page = (await owner.json<AppSnapshot>('snapshot')).apps?.find(item => item.pluginId === draft.id)
    expect(page?.bundleHash).toBe(hash)
    const served = await owner.request(`app-modules/${draft.id}/main/${hash}.js`)
    expect(Buffer.from(await served.arrayBuffer()).equals(bytes)).toBe(true)

    const audit = (await readFile(join(host.dataDir, 'audit', 'audit.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
    const entry = audit.find(record => record.action === 'plugin.package.build')
    expect(entry.detail).toEqual({
      revision: draft.revision,
      result: 'ok',
      bundleHashes: [hash],
      bytes: bytes.length,
      diagnostics: 0,
      typeChecked: true,
    })
    expect(JSON.stringify(audit)).not.toContain('defineApp')
  })

  it('keeps a failed build’s diagnostics with its record and refuses drafts that are not pages only', async () => {
    const { host, owner } = await fixture()
    const sessionId = await session(owner)
    await idle(host, sessionId)
    await draftFolder(
      {
        'latch-app.json': JSON.stringify(manifest()),
        'index.tsx':
          "import { defineApp } from '@latch/app-sdk'\nconst x: number = 'one'\nexport default defineApp({ page: () => null })\n",
      },
      host.workspaceRoot,
    )
    const draft = ((await (await importDraft(owner, sessionId)).json()) as { package: PluginPackageDetail }).package
    const failed = await build(owner, draft.id, draft.revision)
    expect(failed.status).toBe('failed')
    expect(failed.diagnostics[0]).toMatchObject({ tool: 'tsc', file: 'index.tsx', line: 2, column: 7 })
    expect(
      (await owner.json<{ build: PluginBuild }>(`plugin-packages/${draft.id}/build?revision=${draft.revision}`)).build.diagnostics,
    ).toEqual(failed.diagnostics)
    const refused = await owner.request(`plugin-packages/${draft.id}/apply`, {
      body: { requestId: randomUUID(), revision: draft.revision },
    })
    expect(((await refused.json()) as { error: string }).error).toBe('plugin-package-not-built')

    await writeFile(
      join(host.workspaceRoot, 'latch-app', 'latch-app.json'),
      JSON.stringify(manifest('draft-app', 'index.tsx', { host: ['h.mjs'] })),
    )
    const code = await importDraft(owner, sessionId)
    expect([code.status, ((await code.json()) as { error: string }).error]).toEqual([400, 'app-import-code'])

    // Only this Mac's admin device with all data runs the pipeline.
    const phone = await host.enroll({ scopes: ['view', 'run', 'admin'] })
    expect((await phone.request('plugin-packages/import', { body: { requestId: randomUUID(), sessionId } })).status).toBe(403)
  })

  it('writes the skeleton before the first input, and rebuilds after a turn while 开发中 is on', async () => {
    const { host, owner } = await fixture({ sessionFolders: true })
    const sessionId = await session(owner, { appDraft: true })
    await idle(host, sessionId)
    const cwd = (await host.host.bridge.detail(sessionId)).summary.cwd!
    const skeleton = JSON.parse(await readFile(join(cwd, 'latch-app', 'latch-app.json'), 'utf8')) as { id: string; formatVersion: number }
    expect(skeleton.formatVersion).toBe(2)
    expect(await readFile(join(cwd, 'latch-app', 'sdk.d.ts'), 'utf8')).toContain("declare module '@latch/app-sdk'")
    expect(await readFile(join(cwd, 'latch-app', 'README.md'), 'utf8')).toContain('做 Latch 应用')

    await writeFile(
      join(cwd, 'latch-app', 'index.tsx'),
      "import { defineApp } from '@latch/app-sdk'\nexport default defineApp({ page: () => <p>one</p> })\n",
    )
    const draft = ((await (await importDraft(owner, sessionId)).json()) as { package: PluginPackageDetail }).package
    expect(draft.id).toBe(skeleton.id)
    expect((await build(owner, draft.id, draft.revision)).status).toBe('ok')
    await owner.json(`plugin-packages/${draft.id}/dev`, { body: { requestId: randomUUID(), dev: true } })

    // A turn that changes the draft: imported and built again; a failing one keeps the last good preview.
    await writeFile(
      join(cwd, 'latch-app', 'index.tsx'),
      "import { defineApp } from '@latch/app-sdk'\nexport default defineApp({ page: () => <p>two</p> })\n",
    )
    await owner.json(`tasks/${sessionId}/prompt`, { body: { prompt: '改一下', requestId: randomUUID() } })
    await idle(host, sessionId)
    const next = async () => (await owner.json<{ package: PluginPackageDetail }>(`plugin-packages/${draft.id}`)).package
    await expect
      .poll(
        async () => {
          const current = await next()
          return current.revision !== draft.revision && current.build?.status
        },
        { timeout: 15_000 },
      )
      .toBe('ok')
    const second = await next()
    expect(second.preview?.revision).toBe(second.revision)

    await writeFile(
      join(cwd, 'latch-app', 'index.tsx'),
      "import { defineApp } from '@latch/app-sdk'\nconst broken: number = ''\nexport default defineApp({ page: () => null })\n",
    )
    await owner.json(`tasks/${sessionId}/prompt`, { body: { prompt: '再改', requestId: randomUUID() } })
    await idle(host, sessionId)
    await expect.poll(async () => (await next()).build?.status, { timeout: 15_000 }).toBe('failed')
    expect((await next()).preview?.revision).toBe(second.revision)

    // Only a session in its own folder takes a draft.
    const plain = await startTestHost()
    cleanup.push(() => plain.close())
    const mac = await plain.enroll({ listener: 'unix' })
    const refused = await mac.request('tasks', { body: { prompt: 'x', requestId: randomUUID(), mode: 'agent', appDraft: true } })
    expect([refused.status, ((await refused.json()) as { error: string }).error]).toEqual([409, 'app-draft-folder'])
  })

  async function devDraft(options: Parameters<typeof startTestHost>[0] = {}) {
    const { host, owner } = await fixture({ sessionFolders: true, ...options })
    const sessionId = await session(owner, { appDraft: true })
    await idle(host, sessionId)
    const cwd = (await host.host.bridge.detail(sessionId)).summary.cwd!
    const page = (label: string) =>
      `import { defineApp } from '@latch/app-sdk'\nexport default defineApp({ page: () => <p>${label}</p> })\n`
    await writeFile(join(cwd, 'latch-app', 'index.tsx'), page('one'))
    const draft = ((await (await importDraft(owner, sessionId)).json()) as { package: PluginPackageDetail }).package
    await owner.json(`plugin-packages/${draft.id}/dev`, { body: { requestId: randomUUID(), dev: true } })
    return { host, owner, sessionId, cwd, draft, page }
  }
  /** A turn by another device that changes the draft; 开发中 must not act on it for a device that can no longer act. */
  async function changedTurn(host: TestHost, sessionId: string, cwd: string, text: string) {
    const runner = await host.enroll({ scopes: ['view', 'run'] })
    await writeFile(join(cwd, 'latch-app', 'index.tsx'), text)
    await runner.json(`tasks/${sessionId}/prompt`, { body: { prompt: 'again', requestId: randomUUID() } })
    await idle(host, sessionId)
    // Long enough for the run's settlement and an automatic import that should not happen.
    await new Promise(resolve => setTimeout(resolve, 1500))
  }

  it('turns 开发中 off when the device that turned it on is removed, and imports nothing as it', async () => {
    const { host, owner, sessionId, cwd, draft, page } = await devDraft()
    await host.host.security.devices.revoke(owner.id, 'manual', { listener: 'unix', via: 'http' })
    await changedTurn(host, sessionId, cwd, page('two'))
    const mac = await host.enroll({ listener: 'unix' })
    const after = (await mac.json<{ package: PluginPackageDetail }>(`plugin-packages/${draft.id}`)).package
    expect(after.revision).toBe(draft.revision)
    expect(after.source).toEqual({ sessionId, dev: false })
    const audit = (await readFile(join(host.dataDir, 'audit', 'audit.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
    expect(audit.filter(entry => entry.action === 'plugin.package.changed' && entry.detail.operation === 'import')).toHaveLength(1)
  })

  it('stops 开发中 once the device that turned it on has expired', async () => {
    let clock = Date.now()
    const { host, sessionId, cwd, draft, page } = await devDraft({ now: () => clock })
    clock += 31 * 24 * 60 * 60 * 1000
    await changedTurn(host, sessionId, cwd, page('three'))
    const mac = await host.enroll({ listener: 'unix' })
    await expect
      .poll(async () => (await mac.json<{ package: PluginPackageDetail }>(`plugin-packages/${draft.id}`)).package.source?.dev, {
        timeout: 10_000,
      })
      .toBe(false)
    expect((await mac.json<{ package: PluginPackageDetail }>(`plugin-packages/${draft.id}`)).package.revision).toBe(draft.revision)
  })
})
