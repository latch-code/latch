import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { AgentPreset, AppSnapshot, TaskDetail } from '@latch/protocol'
import { detectPresetCommands } from '../src/server.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'

const binary = process.env.LATCH_AGY_BINARY
const evidenceDir = process.env.LATCH_AGY_EVIDENCE_DIR

type Json = Record<string, unknown>
interface Frame {
  t: number
  dir: 'spawn' | 'exit' | 'out' | 'in' | 'stderr'
  text?: string
  frame?: Json
  pid?: number
  args?: string[]
  code?: number | null
  signal?: string | null
}

const SECRET = /\b(?:ya29\.[\w.-]+|1\/\/[\w-]{20,}|AIza[\w-]{20,}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}|[\w.+-]+@[\w-]+\.[\w.-]+)\b/gu

/** Strings clipped and token- or address-shaped text removed, so a frame shows its shape and not what was said. */
function trimmed(value: unknown, root: string, limit = 160): unknown {
  if (typeof value === 'string') {
    const text = value.replaceAll(root, '<tmp>').replace(SECRET, '<redacted>')
    return text.length > limit ? `${text.slice(0, limit)}…(${text.length})` : text
  }
  if (Array.isArray(value)) return value.map(item => trimmed(item, root, limit))
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, trimmed(item, root, limit)]))
  return value
}

/**
 * A stand-in named `agy` that starts the real one and copies each line either way to a file: the Host's ACP driver
 * speaks to the real program, and the frames are kept for the record. `--version` and the like pass straight through.
 */
async function teeCommand(directory: string, real: string, log: string): Promise<void> {
  const script = `#!${process.execPath}
const { spawn, spawnSync } = require('node:child_process')
const { appendFileSync } = require('node:fs')
const real = ${JSON.stringify(real)}
const log = ${JSON.stringify(log)}
const args = process.argv.slice(2)
if (args[0] !== 'acp' || args.includes('--login')) {
  const done = spawnSync(real, args, { stdio: 'inherit' })
  process.exit(done.status ?? 1)
}
const note = entry => appendFileSync(log, JSON.stringify({ t: Date.now(), ...entry }) + '\\n')
const child = spawn(real, args, { stdio: ['pipe', 'pipe', 'pipe'] })
child.stderr.on('data', chunk => {
  process.stderr.write(chunk)
  note({ dir: 'stderr', text: chunk.toString('utf8') })
})
note({ dir: 'spawn', pid: child.pid, args })
const lines = (stream, dir, forward) => {
  let rest = ''
  stream.on('data', chunk => {
    forward(chunk)
    rest += chunk.toString('utf8')
    for (let at = rest.indexOf('\\n'); at >= 0; at = rest.indexOf('\\n')) {
      const line = rest.slice(0, at)
      rest = rest.slice(at + 1)
      if (!line.trim()) continue
      try { note({ dir, frame: JSON.parse(line) }) } catch { note({ dir, frame: { noise: line.length } }) }
    }
  })
}
lines(process.stdin, 'out', chunk => child.stdin.write(chunk))
lines(child.stdout, 'in', chunk => process.stdout.write(chunk))
process.stdin.on('end', () => child.stdin.end())
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => child.kill(signal))
child.on('exit', (code, signal) => {
  note({ dir: 'exit', pid: child.pid, code, signal })
  process.exit(code ?? 1)
})
`
  await writeFile(join(directory, 'agy'), script, { mode: 0o700 })
  await chmod(join(directory, 'agy'), 0o700)
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * A real Antigravity CLI through a test Host, with its own login: detection and the version gate, the catalogue, a
 * turn, approvals, modes, thinking and model, cancel, a restart, and a second folder. Opt-in: only with the owner's
 * leave and `LATCH_AGY_BINARY`; a handful of tiny prompts in a temporary project. Nothing of the CLI's own files is
 * read. With `LATCH_AGY_EVIDENCE_DIR` it writes what it saw there, frames trimmed of their text.
 */
it.skipIf(!binary)(
  'drives a real Antigravity CLI through the Host',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-agy-live-')))
    const evidence: Json = {}
    const steps: Array<{ step: string; ok: boolean; note?: string }> = []
    const step = async (name: string, run: () => Promise<void>): Promise<boolean> => {
      try {
        await run()
        steps.push({ step: name, ok: true })
        return true
      } catch (error) {
        steps.push({ step: name, ok: false, note: String(trimmed(error instanceof Error ? error.message : String(error), root, 1500)) })
        return false
      }
    }
    const log = join(root, 'frames.ndjson')
    const frames = async (): Promise<Frame[]> =>
      (await readFile(log, 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as Frame)
    const keep = async (name: string, value: unknown) => {
      if (!evidenceDir) return
      await mkdir(evidenceDir, { recursive: true })
      await writeFile(join(evidenceDir, name), `${JSON.stringify(trimmed(value, root), null, 2)}\n`)
    }
    const plain = join(root, 'plain')
    const tee = join(root, 'tee')
    const project = join(root, 'project')
    for (const directory of [plain, tee, project]) await mkdir(directory, { recursive: true })
    await symlink(binary!, join(plain, 'agy'))
    await teeCommand(tee, binary!, log)
    await writeFile(join(project, 'note.txt'), 'pineapple\n')
    const data = { dataDir: join(root, 'host'), workspaceRoot: join(root, 'workspace') }
    await mkdir(data.workspaceRoot, { recursive: true })
    const detect = (preset: AgentPreset) => (preset.id === 'antigravity' ? detectPresetCommands(preset) : { found: false })
    const hosts: TestHost[] = []
    const open = async (directory: string, at = data) => {
      await mkdir(at.workspaceRoot, { recursive: true })
      const host = await startTestHost({
        demo: false,
        ...at,
        commandDirectories: () => [directory],
        loginPrograms: (name: string) => (name === 'agy' ? join(directory, 'agy') : undefined),
        detectPreset: detect,
      })
      hosts.push(host)
      return host
    }
    const pids = async () => (await frames()).filter(frame => frame.dir === 'spawn').map(frame => frame.pid!)
    try {
      // ---- 1. detection and the version gate, on the real file --------------------------------------------------
      let host = await open(plain, { dataDir: join(root, 'host-plain'), workspaceRoot: join(root, 'workspace-plain') })
      let owner = await host.enroll({ listener: 'unix' })
      const presetOf = async () =>
        (await owner.json<{ presets: Array<AgentPreset & { detected: Json }> }>('agents')).presets.find(item => item.id === 'antigravity')!
      await step('1 detection', async () => {
        const before = await presetOf()
        const added = await owner.confirmed('agents', {
          method: 'POST',
          body: { id: 'antigravity', name: 'Antigravity', presetId: 'antigravity', command: before.command, args: before.args, env: {} },
        })
        const after = await presetOf()
        const harness = (await owner.json<AppSnapshot>('snapshot')).catalog!.harnesses.find(item => item.id === 'antigravity')
        evidence.detection = { before: before.detected, added: added.status, after: after.detected, harness }
        expect(before.detected).toMatchObject({ found: true })
        expect(added.status).toBe(201)
        expect(after.detected).not.toHaveProperty('outdated')
        expect(after.detected).not.toHaveProperty('versionUnread')
      })
      await keep('01-detection.json', evidence.detection)
      await host.close()

      // ---- the rest through the copying stand-in ----------------------------------------------------------------
      host = await open(tee)
      owner = await host.enroll({ listener: 'unix' })
      await step('1b defined on the stand-in', async () => {
        const preset = await presetOf()
        const added = await owner.confirmed('agents', {
          method: 'POST',
          body: { id: 'antigravity', name: 'Antigravity', presetId: 'antigravity', command: preset.command, args: preset.args, env: {} },
        })
        expect(added.status).toBe(201)
      })
      const harnessInfo = async () =>
        (await owner.json<AppSnapshot>('snapshot')).catalog!.harnesses.find(item => item.id === 'antigravity')!
      const detail = (sessionId: string) => owner.json<TaskDetail>(`tasks/${sessionId}`)
      const waitFor = async (sessionId: string, wanted: (detail: TaskDetail) => boolean, ms = 120_000): Promise<TaskDetail> => {
        const end = Date.now() + ms
        for (;;) {
          const now = await detail(sessionId)
          if (wanted(now)) return now
          if (Date.now() > end) throw new Error(`timed out; status ${now.summary.status}`)
          await sleep(200)
        }
      }
      const idle = (sessionId: string, ms?: number) =>
        waitFor(sessionId, now => !['running', 'waiting-approval'].includes(now.summary.status), ms)
      const prompt = async (sessionId: string, text: string) => {
        const response = await owner.request(`tasks/${sessionId}/prompt`, {
          method: 'POST',
          body: { prompt: text, requestId: randomUUID() },
        })
        if (!response.ok) throw new Error(`prompt ${response.status}: ${await response.text()}`)
      }
      const said = (now: TaskDetail) => now.messages.map(message => ({ id: message.id, role: message.role, text: message.text }))
      const configOf = (now: TaskDetail) =>
        (now.config ?? []).map(option => ({
          id: option.id,
          category: option.category,
          current: option.currentValue,
          options: option.options.map(item => item.value),
        }))
      const setConfig = async (sessionId: string, configId: string, value: string) => {
        const response = await owner.confirmed(`tasks/${sessionId}/config`, {
          method: 'POST',
          body: { configId, value, requestId: randomUUID() },
        })
        const body = (await response.json().catch(() => ({}))) as Json
        const now = await detail(sessionId)
        return {
          status: response.status,
          error: body.error,
          message: body.message,
          readback: configOf(now).find(item => item.id === configId)?.current,
        }
      }

      // ---- 2. the catalogue, read on request --------------------------------------------------------------------
      await step('2 catalogue on request', async () => {
        const before = await harnessInfo()
        const read = await owner.request('agents/antigravity/catalogue', { method: 'POST', body: { auto: false } })
        const answer = (await read.json().catch(() => ({}))) as Json
        const after = await harnessInfo()
        evidence.catalogue = {
          before: { catalogue: before.catalogue, catalogueRead: before.catalogueRead },
          status: read.status,
          answer,
          after,
        }
        expect(read.status).toBe(200)
        expect(after.catalogue).toBeDefined()
      })
      await keep('02-catalogue.json', evidence.catalogue)

      // ---- 3. one turn that reads a file ------------------------------------------------------------------------
      let sessionId = ''
      const { workspace } = (await (await owner.addFolders({ paths: [project], name: 'agy-project' })).json()) as {
        workspace: { id: string }
      }
      await step('3 turn', async () => {
        const started = await owner.confirmed('tasks', {
          method: 'POST',
          body: {
            harnessId: 'antigravity',
            workspaceId: workspace.id,
            prompt: 'Read note.txt and reply with only the word in it.',
            requestId: randomUUID(),
            config: [{ configId: 'mode', value: 'default' }],
          },
        })
        const body = (await started.json()) as { sessionId?: string }
        if (!body.sessionId) throw new Error(`start ${started.status}: ${JSON.stringify(body)}`)
        sessionId = body.sessionId
        const ids = new Set<string>()
        const seen: string[] = []
        let now = await detail(sessionId)
        const end = Date.now() + 120_000
        while (Date.now() < end) {
          now = await detail(sessionId)
          for (const message of now.messages.filter(item => item.role === 'assistant')) ids.add(message.id)
          if (now.summary.status === 'waiting-approval') {
            // A read may ask too under the person's own rules; allow it once and go on.
            for (const approval of now.approvals) {
              seen.push(`approval:${approval.toolName}`)
              await owner.confirmed(`approvals/${approval.id}`, { method: 'POST', body: { decision: 'allow', requestId: randomUUID() } })
            }
          }
          if (!['running', 'waiting-approval'].includes(now.summary.status)) break
          await sleep(150)
        }
        evidence.turn = {
          status: now.summary.status,
          summary: now.summary,
          messages: said(now),
          assistantIdsSeenWhileStreaming: [...ids],
          seen,
          config: configOf(now),
          permission: now.permission,
        }
        expect(now.summary.status).toBe('idle')
        expect(
          now.messages
            .filter(item => item.role === 'assistant')
            .map(item => item.text)
            .join('\n'),
        ).toContain('pineapple')
      })
      await keep('03-turn.json', evidence.turn)
      if (!sessionId) throw new Error('no session started')
      const first = (await detail(sessionId)).messages.findLast(item => item.role === 'assistant')?.text ?? ''
      // The CLI's own refusal (not signed in, region, service): nothing after it would say anything about Latch.
      if (/terminated due to error/iu.test(first)) throw new Error(`Antigravity answered: ${first.trim()}`)

      // ---- 4. approvals -----------------------------------------------------------------------------------------
      const approvalTurn = async (file: string, decision: 'allow' | 'reject') => {
        await prompt(sessionId, `Create the file ${file} containing exactly: hi`)
        const waiting = await waitFor(sessionId, now => now.summary.status !== 'running', 120_000)
        const approvals = waiting.approvals
        const decided: Json[] = []
        if (waiting.summary.status === 'waiting-approval')
          for (const approval of approvals) {
            const response = await owner.confirmed(`approvals/${approval.id}`, {
              method: 'POST',
              body: { decision, requestId: randomUUID() },
            })
            decided.push({ status: response.status, body: await response.json().catch(() => ({})) })
          }
        // A denied write may be asked for again by another tool; every later request gets the same answer.
        let now = await detail(sessionId)
        const end = Date.now() + 120_000
        while (Date.now() < end) {
          now = await detail(sessionId)
          if (now.summary.status === 'waiting-approval')
            for (const approval of now.approvals) {
              const response = await owner.confirmed(`approvals/${approval.id}`, {
                method: 'POST',
                body: { decision, requestId: randomUUID() },
              })
              decided.push({ status: response.status, later: true })
            }
          if (!['running', 'waiting-approval'].includes(now.summary.status)) break
          await sleep(200)
        }
        return {
          statusAtAsk: waiting.summary.status,
          approvals,
          decided,
          statusAfter: now.summary.status,
          fileExists: existsSync(join(project, file)),
          content: existsSync(join(project, file)) ? await readFile(join(project, file), 'utf8') : undefined,
          lastAssistant: said(now).findLast(item => item.role === 'assistant'),
        }
      }
      await step('4a approval allowed', async () => {
        const result = await approvalTurn('hello.txt', 'allow')
        evidence.allow = result
        expect(result.statusAtAsk).toBe('waiting-approval')
        expect(result.fileExists).toBe(true)
        expect(result.statusAfter).toBe('idle')
      })
      await step('4b approval denied', async () => {
        const result = await approvalTurn('bye.txt', 'reject')
        evidence.deny = result
        expect(result.statusAtAsk).toBe('waiting-approval')
        expect(result.fileExists).toBe(false)
        expect(result.statusAfter).toBe('idle')
      })
      await keep('04-approvals.json', { allow: evidence.allow, deny: evidence.deny })

      // ---- 5 and 6. modes, thinking, model ----------------------------------------------------------------------
      await step('5 modes', async () => {
        const changes: Json = {}
        for (const mode of ['accept-edits', 'auto', 'plan', 'default']) changes[mode] = await setConfig(sessionId, 'mode', mode)
        const now = await detail(sessionId)
        evidence.modes = { changes, permission: now.permission, config: configOf(now) }
        for (const mode of ['accept-edits', 'auto', 'plan', 'default']) expect(changes[mode]).toMatchObject({ status: 200, readback: mode })
        expect(now.permission?.modeTiers?.plan).toBeUndefined()
      })
      await keep('05-modes.json', evidence.modes)
      await step('6 thinking and model', async () => {
        const before = configOf(await detail(sessionId))
        const changes: Json = { before }
        const chosen: Record<string, string> = {}
        for (const option of before.filter(item => item.category !== 'mode')) {
          const other = option.options.find(value => value !== option.current)
          if (!other) continue
          chosen[option.id] = other
          changes[option.id] = { to: other, ...(await setConfig(sessionId, option.id, other)) }
        }
        changes.afterSet = configOf(await detail(sessionId))
        await prompt(sessionId, 'Reply with only: ok')
        const now = await idle(sessionId)
        changes.afterTurn = configOf(now)
        changes.turnStatus = now.summary.status
        changes.lastAssistant = said(now).findLast(item => item.role === 'assistant')
        evidence.options = changes
        expect(Object.keys(chosen).length).toBeGreaterThan(0)
        expect(now.summary.status).toBe('idle')
        for (const [id, value] of Object.entries(chosen)) expect(configOf(now).find(item => item.id === id)?.current, id).toBe(value)
      })
      await keep('06-options.json', evidence.options)

      // ---- 7. cancel mid-turn -----------------------------------------------------------------------------------
      await step('7 cancel', async () => {
        const at = (await frames()).length
        await prompt(sessionId, 'Write the numbers from 1 to 400, one per line, with a short sentence about each.')
        const running = await waitFor(
          sessionId,
          now => now.summary.status === 'running' && now.messages.at(-1)?.role === 'assistant',
          60_000,
        ).catch(() => detail(sessionId))
        const asked = Date.now()
        const response = await owner.request(`tasks/${sessionId}/cancel`, {
          method: 'POST',
          body: { requestId: randomUUID(), ...(running.summary.runId ? { runId: running.summary.runId } : {}) },
        })
        const answered = Date.now()
        const body = (await response.json().catch(() => ({}))) as Json
        const now = await idle(sessionId, 60_000)
        const later = (await frames()).slice(at)
        const cancelAt = later.find(frame => frame.dir === 'out' && frame.frame?.method === 'session/cancel')?.t
        const settledAt = later.find(frame => frame.dir === 'in' && (frame.frame?.result as Json | undefined)?.stopReason !== undefined)
        const spawned = await pids()
        evidence.cancel = {
          statusWhenAsked: running.summary.status,
          cancelStatus: response.status,
          cancelBody: body,
          answeredAfterMs: answered - asked,
          cancelNotificationSent: cancelAt !== undefined,
          promptResult: settledAt?.frame,
          promptSettledBeforeAnswer: settledAt ? settledAt.t <= answered : false,
          statusAfter: now.summary.status,
          lastAssistant: said(now).findLast(item => item.role === 'assistant'),
          processes: spawned.map(pid => ({ pid, alive: alive(pid) })),
        }
        expect(response.status).toBe(200)
        expect(['idle', 'cancelled']).toContain(now.summary.status)
      })
      await keep('07-cancel.json', evidence.cancel)

      // ---- 8. restart on the same data --------------------------------------------------------------------------
      await step('8 restart', async () => {
        const before = await pids()
        const chosen = configOf(await detail(sessionId)).filter(item => item.category !== 'mode')
        await host.close()
        await sleep(500)
        const afterClose = before.map(pid => ({ pid, alive: alive(pid) }))
        const at = (await frames()).length
        host = await open(tee)
        owner = await host.enroll({ listener: 'unix' })
        const loaded = await detail(sessionId)
        await prompt(sessionId, 'Reply with only the word you read from note.txt earlier.')
        const now = await idle(sessionId)
        const later = (await frames()).slice(at)
        evidence.restart = {
          processesAfterClose: afterClose,
          loadedStatus: loaded.summary.status,
          loadedMessages: loaded.messages.length,
          methodsAfterRestart: later.filter(frame => frame.dir === 'out' && frame.frame?.method).map(frame => frame.frame!.method),
          errors: later.filter(frame => frame.dir === 'in' && frame.frame?.error).map(frame => frame.frame),
          statusAfter: now.summary.status,
          lastAssistant: said(now).findLast(item => item.role === 'assistant'),
          configBefore: chosen,
          config: configOf(now),
        }
        expect(afterClose.every(entry => !entry.alive)).toBe(true)
        expect(now.summary.status).toBe('idle')
        // The CLI opens the session again with its defaults; the driver sets what the session ran on before the prompt.
        for (const option of chosen) expect(configOf(now).find(item => item.id === option.id)?.current, option.id).toBe(option.current)
      })
      await keep('08-restart.json', evidence.restart)

      // ---- 9. project configuration and a second folder ---------------------------------------------------------
      await step('9a project configuration', async () => {
        await mkdir(join(project, '.agents'), { recursive: true })
        await writeFile(join(project, '.agents', 'note.md'), 'fixture\n')
        const response = await owner.request(`tasks/${sessionId}/prompt`, {
          method: 'POST',
          body: { prompt: 'Reply with only: ok', requestId: randomUUID() },
        })
        const body = (await response.json().catch(() => ({}))) as Json
        evidence.projectConfig = { status: response.status, error: body.error, message: body.message }
        await rm(join(project, '.agents'), { recursive: true, force: true })
        if (response.ok) await idle(sessionId)
        expect(response.status).toBe(409)
      })
      await step('9b second folder', async () => {
        const at = (await frames()).length
        const first = join(root, 'two-a')
        const second = join(root, 'two-b')
        for (const directory of [first, second]) await mkdir(directory)
        await writeFile(join(second, 'other.txt'), 'walnut\n')
        const added = await owner.addFolders({ paths: [first, second], name: 'agy-two' })
        const two = (await added.json()) as { workspace?: { id: string } }
        const started = await owner.confirmed('tasks', {
          method: 'POST',
          body: {
            harnessId: 'antigravity',
            workspaceId: two.workspace?.id,
            prompt: `Read ${join(second, 'other.txt')} and reply with only the word in it.`,
            requestId: randomUUID(),
          },
        })
        const body = (await started.json().catch(() => ({}))) as Json
        let now: TaskDetail | undefined
        if (typeof body.sessionId === 'string') {
          const other = body.sessionId
          const end = Date.now() + 120_000
          while (Date.now() < end) {
            now = await detail(other)
            if (now.summary.status === 'waiting-approval')
              for (const approval of now.approvals)
                await owner.confirmed(`approvals/${approval.id}`, { method: 'POST', body: { decision: 'allow', requestId: randomUUID() } })
            if (!['running', 'waiting-approval'].includes(now.summary.status)) break
            await sleep(200)
          }
        }
        const later = (await frames()).slice(at)
        evidence.folders = {
          addStatus: added.status,
          startStatus: started.status,
          startBody: body,
          sessionNew: later.find(frame => frame.dir === 'out' && frame.frame?.method === 'session/new')?.frame,
          status: now?.summary.status,
          folders: now?.summary.folders,
          folderAccess: now?.summary.folderAccess,
          lastAssistant: now ? said(now).findLast(item => item.role === 'assistant') : undefined,
          projectFolders: (await harnessInfo()).projectFolders,
        }
        expect(started.status).toBe(201)
        expect((evidence.folders as { sessionNew?: { params?: Json } }).sessionNew?.params).toMatchObject({
          cwd: first,
          additionalDirectories: [second],
        })
        expect(now?.summary.status).toBe('idle')
        expect(now ? said(now).findLast(item => item.role === 'assistant')?.text : '').toContain('walnut')
      })
      await keep('09-folders.json', { projectConfig: evidence.projectConfig, folders: evidence.folders })
    } finally {
      for (const host of hosts) await host.close().catch(() => {})
      await sleep(500)
      const all = await frames()
      const spawned = all.filter(frame => frame.dir === 'spawn')
      const left = spawned.map(frame => ({ pid: frame.pid!, alive: alive(frame.pid!) }))
      for (const entry of left) if (entry.alive) process.kill(entry.pid, 'SIGKILL')
      const audit = (await readFile(join(data.dataDir, 'audit', 'audit.jsonl'), 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as { action: string })
      await keep('00-steps.json', {
        steps,
        processes: left,
        launches: spawned.map(frame => frame.args),
        auditActions: audit.map(record => record.action),
      })
      await keep('10-frames.json', all)
      await rm(root, { recursive: true, force: true })
    }
    expect(steps.filter(entry => !entry.ok)).toEqual([])
  },
  900_000,
)
