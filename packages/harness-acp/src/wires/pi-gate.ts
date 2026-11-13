/**
 * Latch's own pi extension, passed to every pi it starts with `-e`: pi itself never asks before a tool runs, so this is
 * how a pi session has permission levels. It holds the level in the process, changes it only through its command,
 * which only the wire sends (pi's stdin is Latch's alone; the wire refuses the command in a person's message), and
 * reports every level it takes as a status entry, which is how Latch reads it back. It is written afresh before each
 * start, so a change to the file in between reaches no process. Not a sandbox: pi's other extensions and the tools
 * allowed at a level run as the person.
 */
import { chmodSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** The command the extension registers, and the status key it reports its level under. */
export const GATE_COMMAND = 'latch-permission'
export const GATE_FILE = 'latch-permission.ts'
/** Strictest first, as the profile's ladder. */
export const GATE_LEVELS = ['plan', 'ask', 'rule', 'never'] as const
type GateLevel = (typeof GATE_LEVELS)[number]
/** The level every pi process starts at: the profile's expected mode. */
export const GATE_START: GateLevel = 'ask'
/** What a confirmation from the extension carries, so the wire can put it on the call it asks about. */
export const GATE_MARK = 'latchGate'

/**
 * Read-only built-in tools run at every level; edits and writes run unasked from `rule`; anything else, commands and
 * other extensions' or MCP tools among them, asks below `never`, and in `plan` is blocked.
 */
const SOURCE = `// Written by Latch before each start; changes to this file are overwritten.
const LEVELS = ${JSON.stringify(GATE_LEVELS)}
const READ = new Set(['read', 'grep', 'find', 'ls'])
const EDIT = new Set(['edit', 'write'])
const COMMAND = ${JSON.stringify(GATE_COMMAND)}

export default function (pi) {
  let level = ${JSON.stringify(GATE_START)}
  const report = ctx => ctx.ui.setStatus(COMMAND, level)
  pi.registerCommand(COMMAND, {
    description: 'Set by Latch',
    handler: async (args, ctx) => {
      const next = String(args ?? '').trim()
      if (LEVELS.includes(next)) level = next
      report(ctx)
    },
  })
  pi.on('session_start', (_event, ctx) => report(ctx))
  pi.on('tool_call', async (event, ctx) => {
    const tool = event.toolName
    if (level === 'never' || READ.has(tool)) return undefined
    if (level === 'rule' && EDIT.has(tool)) return undefined
    if (level === 'plan') return { block: true, reason: 'Latch: this session only reads (只看不改); ' + tool + ' is blocked.' }
    const asked = JSON.stringify({ ${GATE_MARK}: 1, toolCallId: event.toolCallId, toolName: tool, input: event.input })
    const ok = await ctx.ui.confirm(tool, asked)
    return ok ? undefined : { block: true, reason: 'The person refused this call in Latch.' }
  })
}
`

/**
 * Writes the extension into the process's own temporary directory just before it starts, replacing what is there, and
 * returns its real path, which is how pi names it among its commands.
 */
export function writeGate(directory: string): string {
  const path = join(realpathSync(directory), GATE_FILE)
  const partial = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(partial, SOURCE, { mode: 0o600 })
  chmodSync(partial, 0o600)
  renameSync(partial, path)
  return path
}
