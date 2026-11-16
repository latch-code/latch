import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import type { AgentPreset, McpServerView, TaskDetail } from '@latch/protocol'
import { COMPUTER_TOOLS_OFF } from '../src/mcp-computer.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'

/**
 * `<preset>=<program path>` entries, comma separated (`codex`, `claude-agent` for claude-agent-acp, `opencode`): each runs
 * the task with and without Latch's guide.
 */
const wanted = (process.env.LATCH_COMPUTER_GUIDE_LIVE ?? '')
  .split(',')
  .filter(Boolean)
  .map(entry => {
    const [presetId = '', path = ''] = entry.split('=')
    return { presetId, path }
  })
const evidenceDir = process.env.LATCH_COMPUTER_GUIDE_EVIDENCE_DIR
const ARGS: Record<string, string[]> = { codex: [], 'claude-agent': [], opencode: ['acp'] }

/** A test Host whose only Harness preset is this one, found at its path. */
function hostFor(presetId: string, path: string, run: string, extra: Record<string, unknown> = {}): Promise<TestHost> {
  return startTestHost({
    demo: false,
    dataDir: join(run, 'host'),
    workspaceRoot: join(run, 'workspace'),
    commandDirectories: () => [dirname(process.execPath), dirname(path)],
    detectPreset: (preset: AgentPreset) => (preset.id === presetId ? { found: true, path } : { found: false }),
    ...extra,
  })
}

const addHarness = (owner: Awaited<ReturnType<TestHost['enroll']>>, presetId: string, path: string) =>
  owner.confirmed('agents', {
    method: 'POST',
    body: { id: presetId, name: presetId, presetId, command: path, args: ARGS[presetId] ?? [], env: {} },
  })

/**
 * A stand-in for Cua Driver's MCP server: the tools a driver lists (those Latch switches off included), the driver's
 * own kind of guide as `instructions` (batch with run_steps, script with run_script, start apps with launch_app), a
 * TextEdit window and a Latch window. It records every call it gets; it drives nothing.
 */
const FAKE_DRIVER = String.raw`
const { appendFileSync } = require('node:fs')
const log = process.env.FAKE_DRIVER_LOG
const note = entry => appendFileSync(log, JSON.stringify({ at: Date.now(), ...entry }) + '\n')
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
const INSTRUCTIONS = [
  'cua-driver: operate one exact target, observe it narrowly, act by element, verify at checkpoints.',
  '1. Start with a targeted read: get_window_state({pid, window_id, query}).',
  '2. Act by element_token from the read; pixels only for surfaces missing from the tree.',
  '3. Act through run_steps({steps:[{tool,args}], observe:{}}), even for a single step. When the flow needs logic, write it as one run_script instead.',
  '4. To open an app or a file, use launch_app({bundle_id, urls}).',
  '5. Verify at checkpoints with verify_state. Call get_guide for the full guide.',
].join('\n')
const schema = properties => ({ type: 'object', properties, additionalProperties: true })
const target = { pid: { type: 'integer' }, window_id: { type: 'integer' } }
const TOOLS = [
  ['list_apps', 'List running apps with pid and bundle id.', {}],
  ['list_windows', 'List windows with pid, window_id, app and title.', {}],
  ['get_window_state', 'Read one window: accessibility tree rows [N] and a snapshot_id; element_token is "<snapshot_id>:N".', { ...target, query: { type: 'string' } }],
  ['click', 'Click an element by element_token, or x,y in the window.', { ...target, element_token: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } }],
  ['type_text', 'Type text into the focused element or an element_token.', { ...target, element_token: { type: 'string' }, text: { type: 'string' } }],
  ['set_value', 'Set the value of an element by element_token.', { ...target, element_token: { type: 'string' }, value: { type: 'string' } }],
  ['press_key', 'Press one key in a window.', { ...target, key: { type: 'string' } }],
  ['hotkey', 'Press a key combination in a window, such as ["cmd","s"].', { ...target, keys: { type: 'array', items: { type: 'string' } } }],
  ['invoke_menu', 'Choose a menu item by path, such as ["File","Save"].', { pid: { type: 'integer' }, path: { type: 'array', items: { type: 'string' } } }],
  ['bring_to_front', 'Bring a window to the front.', target],
  ['set_window_frame', 'Move, resize or minimize a window.', { ...target, minimized: { type: 'boolean' } }],
  ['verify_state', 'Check a window against an expectation.', { ...target, expect: { type: 'string' } }],
  ['get_guide', 'The driver guide.', {}],
  ...${JSON.stringify(COMPUTER_TOOLS_OFF)}.map(name => [name, 'A driver tool.', {}]),
].map(([name, description, properties]) => ({ name, description, inputSchema: schema(properties) }))
let text = 'Draft'
let saved = false
let snapshot = 0
function call(name, args) {
  const out = value => ({ content: [{ type: 'text', text: value }] })
  if (name === 'list_apps') return out(JSON.stringify([{ pid: 501, name: 'TextEdit', bundle_id: 'com.apple.TextEdit' }, { pid: 777, name: 'Latch', bundle_id: 'app.latch.desktop' }]))
  if (name === 'list_windows')
    return out(JSON.stringify([{ pid: 501, window_id: 11, app: 'TextEdit', title: 'Untitled.txt' }, { pid: 777, window_id: 22, app: 'Latch', title: 'Latch' }]))
  if (name === 'get_window_state') {
    snapshot++
    const id = 's' + String(snapshot).padStart(4, '0')
    if (args.pid === 777 || args.window_id === 22) return out('snapshot_id ' + id + '\n[1] AXWindow "Latch"\n[2] AXButton "minimize"')
    return out('snapshot_id ' + id + '\n[1] AXWindow "Untitled.txt' + (saved ? '' : ' — Edited') + '"\n[2] AXTextArea value="' + text + '"\n[3] AXMenuItem "Save"')
  }
  if (name === 'type_text') { text = args.text ?? text; saved = false; return out('ok') }
  if (name === 'set_value') { text = args.value ?? text; saved = false; return out('ok') }
  if (name === 'hotkey' && JSON.stringify(args.keys ?? []).toLowerCase().includes('s')) { saved = true; return out('ok') }
  if (name === 'invoke_menu' && JSON.stringify(args.path ?? []).includes('Save')) { saved = true; return out('ok') }
  if (name === 'verify_state') return out('text="' + text + '" saved=' + saved)
  if (name === 'get_guide') return out(INSTRUCTIONS)
  return out('ok')
}
let buffer = ''
process.stdin.setEncoding('utf8').on('data', chunk => {
  buffer += chunk
  for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
    const line = buffer.slice(0, end)
    buffer = buffer.slice(end + 1)
    let message
    try { message = JSON.parse(line) } catch { continue }
    const { id, method, params } = message
    if (id === undefined) continue
    if (method === 'initialize')
      send({ id, result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'cua-driver', version: '0.44.0' }, instructions: INSTRUCTIONS } })
    else if (method === 'tools/list') send({ id, result: { tools: TOOLS } })
    else if (method === 'tools/call') {
      note({ tool: params?.name, args: params?.arguments ?? {} })
      send({ id, result: call(params?.name, params?.arguments ?? {}) })
    } else if (method === 'ping') send({ id, result: {} })
    else send({ id, error: { code: -32601, message: 'Method not found' } })
  }
})
process.stdin.on('end', () => process.exit(0))
`

/** The same stand-in, as Cua Driver's app bundle: `--version` answers 0.44.0, anything else runs the server. */
async function fakeBundle(root: string, log: string): Promise<{ app: string; program: string }> {
  const app = join(root, 'CuaDriver.app')
  const bin = join(app, 'Contents', 'MacOS')
  await mkdir(bin, { recursive: true })
  const server = join(root, 'fake-driver.cjs')
  await writeFile(server, FAKE_DRIVER)
  const program = join(bin, 'cua-driver')
  await writeFile(
    program,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "cua-driver 0.44.0"; exit 0; fi\nFAKE_DRIVER_LOG='${log}' exec '${process.execPath}' '${server}'\n`,
  )
  await chmod(program, 0o755)
  return { app, program }
}

const TURNS = [
  'Using only the computer MCP server: in the open TextEdit window, replace the text with Hello and save the document. Keep it short.',
  'Now use the computer MCP server to minimize the Latch window.',
]
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Real agent CLIs through a test Host, each given the stand-in twice: as 「操控这台 Mac」 (Latch's guide in place of the
 * driver's, hints in refusals) and as a plain server with the same tools off (the driver's own text). Each run is the
 * same two tiny turns. Opt-in: only with `LATCH_COMPUTER_GUIDE_LIVE`; the CLIs use their own logins, which nothing
 * here reads. Nothing touches the desktop.
 */
it.skipIf(!wanted.length)(
  'real agents with Latch’s guide make no call to a tool switched off and do not drive the Latch window',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-computer-guide-live-')))
    const table: Array<Record<string, unknown>> = []
    try {
      for (const { presetId, path } of wanted) {
        for (const guided of [true, false].filter(arm => process.env.LATCH_COMPUTER_GUIDE_ARMS !== (arm ? 'plain' : 'guide'))) {
          const run = join(root, `${presetId}-${guided ? 'guide' : 'plain'}`)
          await mkdir(run, { recursive: true })
          const log = join(run, 'driver.jsonl')
          const { app, program } = await fakeBundle(run, log)
          const host = await hostFor(presetId, path, run, { computerDriver: { app, verify: async () => true } })
          try {
            const owner = await host.enroll({ listener: 'unix' })
            expect((await addHarness(owner, presetId, path)).status).toBe(201)
            const scope = { all: true, agents: [], projects: [] }
            if (guided) {
              const added = await owner.confirmedJson<{ server: McpServerView }>('mcp/servers', {
                body: { requestId: randomUUID(), baseRevision: 0, preset: 'computer', scope: { all: false, agents: [], projects: [] } },
              })
              await owner.json(`mcp/servers/${added.server.id}`, {
                method: 'PATCH',
                body: { requestId: randomUUID(), baseRevision: added.server.revision, scope },
              })
            } else {
              const added = await owner.confirmedJson<{ server: McpServerView }>('mcp/servers', {
                body: {
                  requestId: randomUUID(),
                  baseRevision: 0,
                  name: 'computer',
                  command: program,
                  args: ['mcp'],
                  env: {},
                  secrets: {},
                  projectCwd: false,
                  scope,
                },
              })
              await owner.json(`mcp/servers/${added.server.id}`, {
                method: 'PATCH',
                body: { requestId: randomUUID(), baseRevision: added.server.revision, disabledTools: [...COMPUTER_TOOLS_OFF] },
              })
            }
            let sessionId: string | undefined
            let seenRows = 0
            const turns: Array<Record<string, unknown>> = []
            for (const prompt of TURNS) {
              const before = (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).length
              if (!sessionId)
                sessionId = (
                  await owner.confirmedJson<{ sessionId: string }>('tasks', {
                    body: { prompt, requestId: randomUUID(), harnessId: presetId },
                  })
                ).sessionId
              else await owner.json(`tasks/${sessionId}/prompt`, { body: { requestId: randomUUID(), prompt } })
              await sleep(500)
              let detail = await owner.json<TaskDetail>(`tasks/${sessionId}`)
              const end = Date.now() + 240_000
              while (Date.now() < end) {
                detail = await owner.json<TaskDetail>(`tasks/${sessionId}`)
                if (detail.summary.status === 'waiting-approval')
                  for (const approval of detail.approvals)
                    await owner.confirmed(`approvals/${approval.id}`, {
                      method: 'POST',
                      body: { decision: 'allow', requestId: randomUUID() },
                    })
                if (!['running', 'waiting-approval', 'starting'].includes(detail.summary.status)) break
                await sleep(300)
              }
              const reached = (await readFile(log, 'utf8').catch(() => ''))
                .split('\n')
                .filter(Boolean)
                .slice(before)
                .map(line => JSON.parse(line) as { tool: string; args: Record<string, unknown> })
              // The agent's own tool rows, refused calls included: name and how each ended.
              const all = detail.messages
                .filter(message => message.role === 'tool')
                .map(message => {
                  const row = message as { toolName?: string; state?: string; text?: string }
                  return `${row.toolName ?? '?'} [${row.state ?? '?'}] ${(row.text ?? '').replace(/\s+/gu, ' ').slice(0, 160)}`
                })
              const rows = all.slice(seenRows)
              seenRows = all.length
              const off = rows.filter(row => COMPUTER_TOOLS_OFF.some(tool => new RegExp(`\\b${tool}\\b`, 'u').test(row)))
              turns.push({
                prompt: prompt.slice(0, 40),
                status: detail.summary.status,
                reached: reached.map(call => `${call.tool}${call.args.pid === 777 || call.args.window_id === 22 ? '@Latch' : ''}`),
                rows,
                off,
                answer: (detail.messages.filter(message => message.role === 'assistant').at(-1)?.text ?? '').slice(0, 400),
              })
            }
            table.push({ presetId, guided, turns })
          } finally {
            await host.close()
          }
        }
      }
    } finally {
      if (evidenceDir) {
        await mkdir(evidenceDir, { recursive: true })
        await writeFile(join(evidenceDir, 'computer-guide.json'), `${JSON.stringify(table, null, 2)}\n`)
      }
      await rm(root, { recursive: true, force: true })
    }
    // With the guide: nothing switched off reached the driver (the bridge refuses them anyway), and no call aimed at Latch.
    for (const entry of table.filter(item => item.guided))
      for (const turn of entry.turns as Array<{ reached: string[]; off: string[] }>) {
        expect(turn.reached.filter(call => call.endsWith('@Latch'))).toEqual([])
        expect(turn.off).toEqual([])
      }
  },
  1_800_000,
)

/**
 * Each real agent is asked to quote latch-browser's first rule without calling a tool, after saying whether it has that
 * server at all. The browser provider is registered with an open stream, so the session gets the server; no page is
 * opened. At least one agent must quote it; each answer is kept.
 */
it.skipIf(!wanted.length)(
  'real agents read latch-browser’s instructions',
  async () => {
    const answers: Array<Record<string, unknown>> = []
    for (const { presetId, path } of wanted) {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-browser-guide-live-')))
      const host = await hostFor(presetId, path, root)
      const stop = new AbortController()
      try {
        const owner = await host.enroll({ listener: 'unix' })
        expect((await addHarness(owner, presetId, path)).status).toBe(201)
        const { providerId } = (await (await owner.registerBrowserProvider()).json()) as { providerId: string }
        const stream = await owner.request('browser-provider/stream', { method: 'POST', body: { providerId }, signal: stop.signal })
        expect(stream.status).toBe(200)
        const prompt =
          'Do not call any tool. First say whether you have an MCP server named latch-browser and list its tool names. Then quote rule number 1 of the instructions that server gave you when it connected, word for word, or say you have none.'
        const { sessionId } = await owner.confirmedJson<{ sessionId: string }>('tasks', {
          body: { prompt, requestId: randomUUID(), harnessId: presetId },
        })
        let detail = await owner.json<TaskDetail>(`tasks/${sessionId}`)
        const end = Date.now() + 180_000
        while (Date.now() < end && ['running', 'waiting-approval', 'starting'].includes(detail.summary.status)) {
          await sleep(300)
          detail = await owner.json<TaskDetail>(`tasks/${sessionId}`)
        }
        const answer = detail.messages.filter(message => message.role === 'assistant').at(-1)?.text ?? ''
        answers.push({ presetId, status: detail.summary.status, quoted: /browser_viewport/u.test(answer), answer: answer.slice(0, 600) })
      } finally {
        stop.abort()
        await host.close()
        await rm(root, { recursive: true, force: true })
      }
    }
    if (evidenceDir) {
      await mkdir(evidenceDir, { recursive: true })
      await writeFile(join(evidenceDir, 'browser-guide.json'), `${JSON.stringify(answers, null, 2)}\n`)
    }
    expect(answers.some(answer => answer.quoted)).toBe(true)
  },
  900_000,
)
