// 从项目导入 (docs/MCP.md): a project's `.mcp.json` read as data only, bounded and strict, never run or expanded.
import { randomUUID } from 'node:crypto'
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HarnessOwnMcp, McpImportResponse, McpServerView } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { FAKE_ACP_AGENT, FAKE_CODEX_APP_SERVER } from '@latch/testkit'
import { MCP_IMPORT_MAX_BYTES, parseProjectMcp, readProjectMcpText } from '../src/mcp-import.ts'
import { repositoryFlags } from '../src/routes/mcp.ts'
import { startTestHost } from './helpers/host.ts'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function folder(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'latch-mcp-import-')))
  cleanups.push(() => rm(path, { recursive: true, force: true }))
  return path
}

const parse = (value: unknown) => parseProjectMcp(JSON.stringify(value))

describe('a project’s .mcp.json, as data', () => {
  it('offers a local command and a remote address, keeping plain values and leaving every secret value out', () => {
    const read = parse({
      mcpServers: {
        github: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: { GITHUB_TOKEN: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', LOG_LEVEL: 'debug', OPAQUE_ID: 'a1b2c3d4e5f6g7h8i9j0k1' },
        },
        remote: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer abc' } },
      },
    })
    expect(read.status).toBe('ok')
    const [github, remote] = read.servers
    expect(github).toMatchObject({ name: 'github', transport: 'stdio', command: 'npx', flags: [] })
    expect(github!.env).toEqual([
      { name: 'GITHUB_TOKEN', secret: true },
      { name: 'LOG_LEVEL', secret: false, value: 'debug' },
      { name: 'OPAQUE_ID', secret: true },
    ])
    expect(remote).toMatchObject({ transport: 'http', url: 'https://mcp.example.com/mcp', headers: ['Authorization'] })
    expect(JSON.stringify(read)).not.toContain('ghp_')
    expect(JSON.stringify(read)).not.toContain('Bearer abc')
  })

  it('shows ${…} as written and never expands it, as a secret to fill in a variable', () => {
    process.env.LATCH_IMPORT_TEST_SECRET = 'expanded-value-from-the-host'
    try {
      const read = parse({
        mcpServers: {
          x: {
            command: '${LATCH_IMPORT_TEST_SECRET}',
            args: ['--token', '${LATCH_IMPORT_TEST_SECRET}', '${workspaceFolder}'],
            env: { TOKEN: '${LATCH_IMPORT_TEST_SECRET}' },
          },
          y: { url: 'https://x.example/${LATCH_IMPORT_TEST_SECRET}', headers: { 'X-Key': '${LATCH_IMPORT_TEST_SECRET}' } },
        },
      })
      expect(JSON.stringify(read)).not.toContain('expanded-value-from-the-host')
      expect(read.servers[0]).toMatchObject({
        command: '${LATCH_IMPORT_TEST_SECRET}',
        args: ['--token', '${LATCH_IMPORT_TEST_SECRET}', '${workspaceFolder}'],
        env: [{ name: 'TOKEN', secret: true }],
        flags: ['expansion'],
      })
      expect(read.servers[1]).toMatchObject({ url: 'https://x.example/${LATCH_IMPORT_TEST_SECRET}', flags: ['expansion'] })
      // Latch's own `${workspaceFolder}` alone is no expansion to warn of.
      expect(parse({ mcpServers: { z: { command: 'node', args: ['${workspaceFolder}/x.js'] } } }).servers[0]!.flags).toEqual([])
    } finally {
      delete process.env.LATCH_IMPORT_TEST_SECRET
    }
  })

  it('refuses unknown fields, odd keys and control characters, and leaves names it cannot use for the person to type', () => {
    expect(parseProjectMcp('{"mcpServers":{},"extra":1}')).toMatchObject({ status: 'refused', reason: 'invalid' })
    expect(parseProjectMcp('{"__proto__":{"polluted":true},"mcpServers":{}}')).toMatchObject({ status: 'refused', reason: 'invalid' })
    expect(parseProjectMcp('not json')).toMatchObject({ status: 'refused', reason: 'not-json' })
    expect(parseProjectMcp('[]')).toMatchObject({ status: 'refused', reason: 'invalid' })
    const read = parseProjectMcp(
      JSON.stringify({
        mcpServers: {
          PROTO_KEY: { command: 'node' },
          constructor: { command: 'node', env: {} },
          'latch-skills': { command: 'node' },
          'evil‮name': { command: 'node' },
          extra: { command: 'node', cwd: '/tmp' },
          newline: { command: 'node', args: ['a\nb'] },
          old: { type: 'sse', url: 'https://x.example/sse' },
          odd: { type: 'websocket', url: 'wss://x.example' },
          both: { command: 'node', url: 'https://x.example' },
          taken: { command: 'node' },
        },
      })
        // Written as JSON text: a `__proto__` key in an object literal would set its prototype instead.
        .replace('"PROTO_KEY"', '"__proto__"')
        .replace('"constructor":{"command":"node","env":{}}', '"constructor":{"command":"node","env":{"__proto__":"x"}}'),
      name => name === 'taken',
    )
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    const names = Object.fromEntries(read.servers.map(server => [server.key, server.name]))
    expect(names['__proto__']).toBe('')
    expect(names['latch-skills']).toBe('')
    expect(names.taken).toBe('')
    expect(read.servers.find(server => server.key.startsWith('evil'))!.key).not.toContain('‮')
    expect(Object.fromEntries(read.skipped.map(item => [item.key, item.reason]))).toEqual({
      constructor: 'invalid',
      extra: 'invalid',
      newline: 'invalid',
      old: 'legacy-sse',
      odd: 'unsupported',
      both: 'invalid',
    })
    const many = parse({ mcpServers: Object.fromEntries(Array.from({ length: 40 }, (_, at) => [`s${at}`, { command: 'node' }])) })
    expect(many.servers).toHaveLength(32)
    expect(many.truncated).toBe(true)
  })

  it('blanks credential-looking arguments and an address’s account or credential query, for the person to type', () => {
    const read = parse({
      mcpServers: {
        a: {
          command: 'server',
          args: ['--token', 'plainword', '--api-key=abc', '--mode=fast', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', '--key=${KEY}', 'x'],
        },
        b: { url: 'https://user:pa55word@mcp.example.com/mcp' },
        c: { url: 'https://mcp.example.com/mcp?api_key=zzz&region=eu' },
        d: { url: 'https://mcp.example.com/mcp?region=eu' },
      },
    })
    const [a, b, c, d] = read.servers
    expect(a!.args).toEqual(['--token', '', '--api-key=', '--mode=fast', '', '--key=${KEY}', 'x'])
    expect(a!.flags).toContain('secret')
    expect(b).toMatchObject({ url: 'https://mcp.example.com/mcp', flags: ['secret'] })
    expect(c).toMatchObject({ url: 'https://mcp.example.com/mcp', flags: ['secret'] })
    expect(d).toMatchObject({ url: 'https://mcp.example.com/mcp?region=eu', flags: [] })
    const text = JSON.stringify(read)
    for (const secret of ['plainword', 'ghp_', 'pa55word', 'zzz', '--api-key=abc']) expect(text).not.toContain(secret)
  })

  it('refuses what a security surface would escape: C1 controls, bidi and line or paragraph separators', () => {
    for (const odd of ['\u0085', '\u202e', '\u2066', '\u2028', '\u2029', '\u200b'])
      expect(parse({ mcpServers: { s: { command: 'node', args: [`a${odd}b`] } } }).skipped).toEqual([{ key: 's', reason: 'invalid' }])
  })

  it('looks up only paths already under a root, never one elsewhere such as an automounted /net path', async () => {
    const seen: string[] = []
    const fs = {
      lstat: async (path: string) => {
        seen.push(path)
        throw new Error('missing')
      },
    }
    const flags = await repositoryFlags(
      { transport: 'stdio', command: '/net/host/share/bin/server', args: ['/net/host/share/x.js', '/Volumes/remote/y.js', './z.js'] },
      '/proj/repo',
      ['/proj/repo', '/data'],
      fs,
    )
    expect(flags).toEqual([])
    expect(seen).toEqual(['/proj/repo/z.js'])
    expect(await repositoryFlags({ transport: 'stdio', command: './bin/s', args: [] }, '/proj/repo', ['/proj/repo'], fs)).toEqual([
      'repository-command',
    ])
  })

  it('reads only a regular file of at most 64 KiB, never through a link', async () => {
    const dir = await folder()
    expect(await readProjectMcpText(dir)).toEqual({ status: 'missing' })
    await writeFile(join(dir, '.mcp.json'), ' '.repeat(MCP_IMPORT_MAX_BYTES + 1))
    expect(await readProjectMcpText(dir)).toEqual({ status: 'refused', reason: 'too-large' })
    await rm(join(dir, '.mcp.json'))
    const elsewhere = join(await folder(), 'config.toml')
    await writeFile(elsewhere, '{"mcpServers":{}}')
    await symlink(elsewhere, join(dir, '.mcp.json'))
    expect(await readProjectMcpText(dir)).toEqual({ status: 'refused', reason: 'not-file' })
    await rm(join(dir, '.mcp.json'))
    // A hard link is the same file under a second name, which could be any file of the person's.
    const other = join(await folder(), 'config.toml')
    await writeFile(other, '{"mcpServers":{}}')
    await link(other, join(dir, '.mcp.json'))
    expect(await readProjectMcpText(dir)).toEqual({ status: 'refused', reason: 'not-file' })
    await rm(join(dir, '.mcp.json'))
    await mkdir(join(dir, '.mcp.json'))
    expect(await readProjectMcpText(dir)).toEqual({ status: 'refused', reason: 'not-file' })
  })
})

describe('从项目导入 on the Host', () => {
  it('reads only on this Mac’s desktop, flags what the repository holds, runs nothing, and records the source project', async () => {
    const t = await startTestHost({ demo: false })
    cleanups.push(() => t.close())
    const desktop = await t.enroll({ listener: 'unix' })
    const browser = await t.enroll({ scopes: ['view', 'run', 'admin'] })
    const project = await folder()
    const ran = join(project, 'ran')
    await mkdir(join(project, 'bin'))
    await mkdir(join(project, 'scripts'))
    await writeFile(join(project, 'scripts', 'mcp.js'), '')
    await writeFile(
      join(project, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          local: { command: './bin/server', args: [] },
          script: { command: 'node', args: ['./scripts/mcp.js'], env: { NODE_OPTIONS: `--require ${ran}` } },
          plain: { command: process.execPath, args: ['--version'] },
          pkg: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
        },
      }),
    )
    const { workspace } = (await (await desktop.addFolders({ paths: [project], name: 'repo' })).json()) as { workspace: { id: string } }
    const refused = await browser.request(`mcp/import?project=${workspace.id}`)
    expect(refused.status).toBe(403)
    const read = await desktop.json<McpImportResponse>(`mcp/import?project=${workspace.id}`)
    expect(read.files).toHaveLength(1)
    const flags = Object.fromEntries(read.files[0]!.servers.map(server => [server.key, server.flags]))
    expect(flags).toEqual({ local: ['repository-command'], script: ['repository-path'], plain: [], pkg: [] })
    expect((await desktop.request('mcp/import?project=nope')).status).toBe(404)

    const plain = read.files[0]!.servers.find(server => server.key === 'plain')!
    const before = t.presence.requests.length
    const { server } = await desktop.confirmedJson<{ server: McpServerView }>('mcp/servers', {
      body: {
        requestId: randomUUID(),
        baseRevision: 0,
        importedFrom: workspace.id,
        name: plain.name,
        command: plain.command,
        args: plain.args,
        env: {},
        secrets: {},
        projectCwd: false,
        scope: { all: true, agents: [], projects: [] },
      },
    })
    // Adding is the ordinary addition, with this Mac's confirmation.
    expect(t.presence.requests.length).toBe(before + 1)
    expect(t.presence.requests.at(-1)?.preview.action).toBe('mcp.server.apply')
    const records = (await readFile(join(t.dataDir, 'audit', 'audit.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { action: string; detail: Record<string, unknown> })
    expect(records.find(record => record.action === 'mcp.server.added')?.detail).toMatchObject({
      serverId: server.id,
      importedFrom: workspace.id,
    })
    const unknown = await desktop.request('mcp/servers', {
      body: {
        requestId: randomUUID(),
        baseRevision: 1,
        importedFrom: 'nope',
        name: 'other',
        command: process.execPath,
        args: [],
        env: {},
        secrets: {},
        projectCwd: false,
        scope: { all: true, agents: [], projects: [] },
      },
    })
    expect(unknown.status).toBe(400)
    await expect(readFile(ran)).rejects.toThrow()
  })
})

describe('读取 a Harness’s own MCP on the Host', () => {
  /** A Host with Codex direct (the fake app-server, reporting two servers) and an ACP Harness that reports none. */
  async function codexHost() {
    const root = await folder()
    const logFile = join(root, 'codex.log')
    const own = JSON.stringify([{ name: 'github', runtimeStatus: 'connected', tools: { a: {} } }])
    await mkdir(join(root, 'bin'))
    await writeFile(
      join(root, 'bin', 'codex'),
      `#!/bin/sh\nexport FAKE_ACP_LOG='${logFile}'\nexport FAKE_CODEX_MCP='${own}'\nexec '${process.execPath}' '${FAKE_CODEX_APP_SERVER}' "$@"\n`,
    )
    await chmod(join(root, 'bin', 'codex'), 0o755)
    const t = await startTestHost({ demo: false })
    cleanups.push(() => t.close())
    const desktop = await t.enroll({ listener: 'unix' })
    await desktop.confirmedJson('agents', {
      body: { id: 'codex', name: 'Codex', presetId: 'codex', command: join(root, 'bin', 'codex'), args: [], env: {} },
    })
    await desktop.confirmedJson('agents', {
      body: { id: 'other', name: 'Other', command: process.execPath, args: [FAKE_ACP_AGENT], env: {} },
    })
    const starts = async () =>
      (await readFile(logFile, 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean)
        .filter(line => (JSON.parse(line) as { event: string }).event === 'start').length
    return { t, desktop, starts }
  }

  it('reads with run, and refuses a view-only device, a Harness that does not report, and a failed record', async () => {
    const { t, desktop, starts } = await codexHost()
    const viewer = await t.enroll({ scopes: ['view'] })
    expect((await viewer.request('agents/codex/mcp', { body: {} })).status).toBe(403)
    expect(await starts()).toBe(0)
    const refused = await desktop.request('agents/other/mcp', { body: {} })
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({ error: 'mcp-not-reported' })

    // The record comes first: one that cannot be written starts nothing.
    const append = t.host.security.audit.append.bind(t.host.security.audit)
    const spy = vi
      .spyOn(t.host.security.audit, 'append')
      .mockImplementation(event =>
        event.action === 'agent.mcp.requested' ? Promise.reject(new AppError(503, 'audit-unavailable', '审计不可用')) : append(event),
      )
    expect((await desktop.request('agents/codex/mcp', { body: {} })).status).toBeGreaterThanOrEqual(500)
    expect(await starts()).toBe(0)
    spy.mockRestore()

    const read = await desktop.json<{ ownMcp: HarnessOwnMcp }>('agents/codex/mcp', { body: {} })
    expect(read.ownMcp.last).toMatchObject({ via: 'read', servers: [{ name: 'github', state: 'ready', tools: 1 }] })
    expect(await starts()).toBe(1)
  })

  it('refuses once the Host is closing, starting nothing', async () => {
    const { t, desktop, starts } = await codexHost()
    let release!: () => void
    const gate = new Promise<void>(resolve => (release = resolve))
    const hub = t.host.bridge as unknown as { readHarnessMcp(id: string, before: () => Promise<void>): Promise<void> }
    const original = hub.readHarnessMcp.bind(hub)
    vi.spyOn(hub, 'readHarnessMcp').mockImplementation(async (id, before) => {
      await gate
      return original(id, before)
    })
    const pending = desktop.request('agents/codex/mcp', { body: {} }).then(
      response => response.status,
      () => 'closed' as const,
    )
    await vi.waitFor(() => expect(hub.readHarnessMcp).toHaveBeenCalled())
    const closed = t.close()
    release()
    expect(await pending).not.toBe(200)
    await closed
    expect(await starts()).toBe(0)
  })
})
