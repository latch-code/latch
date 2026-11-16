// 「Xcode」 in 设置 › MCP: Xcode's own MCP bridge as a preset, with a stand-in for finding Xcode. Nothing here runs
// `xcrun mcpbridge` or starts Xcode.
import { randomUUID } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { McpServerView, McpXcodeCheck, TaskDetail } from '@latch/protocol'
import { FAKE_ACP_AGENT, FAKE_MCP_STDIO } from '@latch/testkit'
import { XCODE_INSTRUCTIONS, XCODE_KNOWN_TOOLS, XCODE_TOOLS_OFF, checkXcodeBridge, xcodeToolRisk } from '../src/mcp-xcode.ts'
import { startTestHost } from './helpers/host.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const addBody = () => ({ requestId: randomUUID(), baseRevision: 0, preset: 'xcode', scope: { all: false, agents: [], projects: [] } })

describe('Xcode bridge check', () => {
  it('knows exactly the tools Xcode 27.2’s bridge listed', async () => {
    const fixture = JSON.parse(await readFile(join(import.meta.dirname, 'fixtures', 'xcode-mcpbridge-tools.json'), 'utf8')) as {
      tools: Array<{ name: string }>
    }
    expect([...XCODE_KNOWN_TOOLS].toSorted()).toEqual(fixture.tools.map(tool => tool.name).toSorted())
  })

  it('says absent, too old or found, from xcrun alone', async () => {
    expect(await checkXcodeBridge({ probe: async () => ({ bridge: false }) })).toMatchObject({ state: 'absent' })
    expect(await checkXcodeBridge({ probe: async () => ({ bridge: true, version: '26.4' }) })).toMatchObject({
      state: 'old',
      version: '26.4',
    })
    expect(await checkXcodeBridge({ probe: async () => ({ bridge: true }) })).toMatchObject({ state: 'old' })
    expect(await checkXcodeBridge({ probe: async () => ({ bridge: true, version: '27.2' }) })).toMatchObject({
      state: 'ok',
      version: '27.2',
      command: '/usr/bin/xcrun mcpbridge',
    })
  })

  it('classes looking R0, acting on a device or building R1, editing files, running code and unknown tools R2', () => {
    expect(xcodeToolRisk('GetConsoleOutput')).toBe('R0')
    expect(xcodeToolRisk('XcodeRead')).toBe('R0')
    expect(xcodeToolRisk('DeviceInteractionEndSession')).toBe('R0')
    for (const tool of ['DeviceInteractionStartSession', 'DeviceInteractionSynthesize', 'DeviceInteractionInstallAndRun', 'BuildProject'])
      expect(xcodeToolRisk(tool)).toBe('R1')
    for (const tool of [...XCODE_TOOLS_OFF, 'SomeNewTool']) expect(xcodeToolRisk(tool)).toBe('R2')
    for (const tool of ['XcodeWrite', 'XcodeRM', 'RunCodeSnippet', 'InvokeDebuggerCommand', 'GetTopCrashIssues'])
      expect(XCODE_TOOLS_OFF).toContain(tool)
    for (const tool of XCODE_TOOLS_OFF) expect(XCODE_KNOWN_TOOLS).toContain(tool)
    expect(XCODE_INSTRUCTIONS).toMatch(/UDID/u)
    expect(XCODE_INSTRUCTIONS).toMatch(/device_\*/u)
  })
})

describe('「Xcode」 in 设置 › MCP', () => {
  it('is offered and added only on this Mac, with the Host’s own definition, the confirmation and its record', async () => {
    const t = await startTestHost({ demo: false, xcodeBridge: { probe: async () => ({ bridge: true, version: '27.2' }) } })
    cleanups.push(() => t.close())
    const desktop = await t.enroll({ listener: 'unix' })
    const browser = await t.enroll({ scopes: ['view', 'run', 'admin'] })
    expect((await browser.request('mcp/xcode')).status).toBe(403)
    expect((await browser.request('mcp/servers', { body: addBody() })).status).toBe(403)
    expect(await desktop.json<McpXcodeCheck>('mcp/xcode')).toMatchObject({ state: 'ok', version: '27.2' })
    expect((await desktop.request('mcp/servers', { body: { ...addBody(), command: '/bin/sh' } })).status).toBe(400)
    const asked = await desktop.request('mcp/servers', { body: addBody() })
    expect(asked.status).toBe(403)
    const ticket = (await asked.json()).confirmation
    expect(ticket).toMatchObject({ action: 'mcp.server.apply' })
    expect(ticket.lines).toContainEqual({ label: '命令', value: '/usr/bin/xcrun' })
    expect(ticket.lines).toContainEqual({ label: '参数', value: 'mcpbridge' })
    const { server } = await desktop.confirmedJson<{ server: McpServerView }>('mcp/servers', { body: addBody() })
    expect(server).toMatchObject({
      name: 'xcode',
      transport: 'stdio',
      preset: 'xcode',
      command: '/usr/bin/xcrun',
      args: ['mcpbridge'],
      disabledTools: [...XCODE_TOOLS_OFF],
      knownTools: [...XCODE_KNOWN_TOOLS],
    })
    const records = (await readFile(join(t.dataDir, 'audit', 'audit.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { action: string; detail: Record<string, unknown> })
    expect(records.find(record => record.action === 'mcp.server.added')?.detail).toMatchObject({ serverId: server.id, preset: 'xcode' })
    expect(await desktop.json<McpXcodeCheck>('mcp/xcode')).toMatchObject({ added: server.id })
    expect((await desktop.request('mcp/servers', { body: addBody() })).status).toBe(409)
  })

  it('refuses an Xcode too old, and is not there on a Host that does not look for it', async () => {
    const t = await startTestHost({ demo: false, xcodeBridge: { probe: async () => ({ bridge: true, version: '26.3' }) } })
    cleanups.push(() => t.close())
    const desktop = await t.enroll({ listener: 'unix' })
    expect((await desktop.request('mcp/servers', { body: addBody() })).status).toBe(409)
    const plain = await startTestHost({ demo: false })
    cleanups.push(() => plain.close())
    const other = await plain.enroll({ listener: 'unix' })
    expect((await other.request('mcp/xcode')).status).toBe(404)
  })
})

/** A stand-in for `xcrun`: given `mcpbridge`, a fake MCP server listing a few of Xcode's tool names. */
async function fakeXcrun(root: string): Promise<string> {
  const program = join(root, 'xcrun')
  const tools = ['DeviceInteractionStartSession', 'DeviceInteractionSynthesize', 'DeviceInteractionEndSession', 'XcodeWrite'].join(',')
  await writeFile(
    program,
    `#!/bin/sh\nFAKE_MCP_EXTRA_TOOLS='${tools}' FAKE_MCP_INSTRUCTIONS='Request Xcode perform the action you specify.' exec '${process.execPath}' '${FAKE_MCP_STDIO}'\n`,
  )
  await chmod(program, 0o755)
  return program
}

describe('「Xcode」 in sessions', () => {
  it('gives Latch’s rules, classes and records each call with its device, and refuses the tools that are off', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-xcode-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const t = await startTestHost({
      demo: false,
      xcodeBridge: { probe: async () => ({ bridge: true, version: '27.2' }), command: await fakeXcrun(root) },
    })
    cleanups.push(() => t.close())
    const desktop = await t.enroll({ listener: 'unix' })
    await desktop.confirmedJson('agents', {
      body: { id: 'mcp-agent', name: 'MCP Agent', command: process.execPath, args: [FAKE_ACP_AGENT], env: { FAKE_ACP_MCP: 'dsh' } },
    })
    const added = await desktop.confirmedJson<{ server: McpServerView }>('mcp/servers', { body: addBody() })
    await desktop.json(`mcp/servers/${added.server.id}`, {
      method: 'PATCH',
      body: { requestId: randomUUID(), baseRevision: added.server.revision, scope: { all: true, agents: [], projects: [] } },
    })
    const said = async (sessionId: string) => {
      for (let attempt = 0; attempt < 400; attempt++) {
        const detail = await desktop.json<TaskDetail>(`tasks/${sessionId}`)
        if (!['running', 'waiting-approval', 'starting'].includes(detail.summary.status))
          return detail.messages.filter(message => message.role === 'assistant').at(-1)?.text ?? ''
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      throw new Error('timed out')
    }
    const { sessionId } = await desktop.confirmedJson<{ sessionId: string }>('tasks', {
      body: { prompt: 'mcp-instructions xcode', requestId: randomUUID(), harnessId: 'mcp-agent' },
    })
    expect(await said(sessionId)).toBe(XCODE_INSTRUCTIONS)
    const ask = async (prompt: string) => {
      await desktop.json(`tasks/${sessionId}/prompt`, { body: { requestId: randomUUID(), prompt } })
      return said(sessionId)
    }
    const udid = '3767D0E9-F4D5-49E4-8023-F85C6FB82B13'
    expect(
      await ask(`mcp xcode DeviceInteractionStartSession {"deviceIdentifier":"${udid.toLowerCase()}","sessionIdentifier":"Check"}`),
    ).toBe('xcode.DeviceInteractionStartSession: ok: DeviceInteractionStartSession: ok')
    expect(await ask('mcp xcode DeviceInteractionEndSession {"interactionSessionKey":"k"}')).toMatch(/: ok: /u)
    expect(await ask('mcp xcode XcodeWrite {"filePath":"a"}')).toMatch(/^xcode\.XcodeWrite: error: /u)
    const records = (await readFile(join(t.dataDir, 'audit', 'audit.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { action: string; detail: Record<string, unknown> })
      .filter(record => record.action === 'mcp.tool.called' && record.detail.serverId === added.server.id)
    expect(records.map(record => [record.detail.risk, record.detail.udid])).toEqual([
      ['R1', udid],
      ['R0', undefined],
    ])
  })
})
