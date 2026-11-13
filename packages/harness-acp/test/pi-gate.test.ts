import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GATE_COMMAND, writeGate } from '../src/wires/pi-gate.ts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function extension() {
  const root = await mkdtemp(join(tmpdir(), 'latch-pi-gate-'))
  roots.push(root)
  const path = writeGate(root)
  const source = await readFile(path, 'utf8')
  // The shipped extension is JavaScript-valid TypeScript. Loading exactly those bytes exercises its real handlers.
  const module = join(root, 'gate.mjs')
  await writeFile(module, source)
  const plugin = (await import(pathToFileURL(module).href)) as { default(pi: unknown): void }
  const events = new Map<string, (event: unknown, context: unknown) => unknown>()
  const commands = new Map<string, { handler(args: string, context: unknown): Promise<void> }>()
  plugin.default({
    on: (name: string, handler: (event: unknown, context: unknown) => unknown) => events.set(name, handler),
    registerCommand: (name: string, command: { handler(args: string, context: unknown): Promise<void> }) => commands.set(name, command),
  })
  const confirm = vi.fn(async (_title: string, _message: string) => true)
  const setStatus = vi.fn()
  const context = { ui: { confirm, setStatus } }
  return { path, context, confirm, setStatus, events, set: (mode: string) => commands.get(GATE_COMMAND)!.handler(mode, context) }
}

describe('the pi extension actually passed to the process', () => {
  it('starts in ask, reads its own mode, and never grants an unknown level', async () => {
    const gate = await extension()
    gate.events.get('session_start')!({}, gate.context)
    expect(gate.setStatus).toHaveBeenLastCalledWith(GATE_COMMAND, 'ask')
    await gate.set('invented')
    expect(gate.setStatus).toHaveBeenLastCalledWith(GATE_COMMAND, 'ask')
    expect((await stat(gate.path)).mode & 0o777).toBe(0o600)
  })

  it.each(['plan', 'ask', 'rule', 'never'] as const)(
    'applies %s to built-in reads, edits, commands and unknown extension tools',
    async mode => {
      const gate = await extension()
      await gate.set(mode)
      for (const toolName of ['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash', 'other-extension']) {
        gate.confirm.mockClear()
        const read = ['read', 'grep', 'find', 'ls'].includes(toolName)
        const edit = ['edit', 'write'].includes(toolName)
        const blocked = mode === 'plan' && !read
        const asks = !read && (mode === 'ask' || (mode === 'rule' && !edit))
        const result = await gate.events.get('tool_call')!({ toolName, toolCallId: 'call-one', input: { path: 'a.txt' } }, gate.context)
        if (blocked) expect(result).toMatchObject({ block: true })
        else expect(result).toBeUndefined()
        expect(gate.confirm).toHaveBeenCalledTimes(asks ? 1 : 0)
        if (asks)
          expect(JSON.parse(gate.confirm.mock.calls[0]![1] as string)).toMatchObject({ latchGate: 1, toolCallId: 'call-one', toolName })
      }
    },
  )

  it('blocks a refused call and fails closed when asking fails', async () => {
    const gate = await extension()
    const call = { toolName: 'bash', toolCallId: 'call-one', input: { command: 'echo ok' } }
    gate.confirm.mockResolvedValueOnce(false)
    expect(await gate.events.get('tool_call')!(call, gate.context)).toMatchObject({ block: true })
    gate.confirm.mockRejectedValueOnce(new Error('connection closed'))
    await expect(gate.events.get('tool_call')!(call, gate.context)).rejects.toThrow('connection closed')
  })
})
