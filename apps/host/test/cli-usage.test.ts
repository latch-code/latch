// DeepSeek Harness's token counts, read by the Host from its own log of a session Latch started (src/cli-usage.ts;
// docs/HARNESSES.md#用量). Every home is a temporary directory; every log is written here in the shape
// @deepseek-ai/dsh-session-persistence-jsonl 0.2.2-rc.1 writes (format 4, a Zstandard frame per append).
import { randomBytes, randomUUID } from 'node:crypto'
import { appendFile, chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { dshProjectKey, readDshTurnUsage } from '../src/cli-usage.ts'
import { startTestHost } from './helpers/host.ts'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const uid = process.getuid!()
const SECRET_TEXT = 'private-reply-text'

async function temp(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}

type Row = Record<string, unknown>
const header = (id: string, cwd: string): Row => ({
  type: 'session',
  version: 4,
  id,
  createdAt: 1,
  isSeeded: false,
  delegationDepth: 0,
  cwd,
})
const event = (type: string, time: number, data: Row, seq = 0): Row => ({ type, seq, time, data })
const start = (turn: number, time: number) => event('turn/start', time, { turn })
const end = (turn: number, time: number) => event('turn/end', time, { turn, reason: { kind: 'completed' } })
const reply = (turn: number, time: number, usage?: Row) =>
  event('assistant/message', time, {
    turn,
    step: 0,
    message: { role: 'assistant', content: [{ type: 'text', text: SECRET_TEXT }] },
    stream: [],
    ...(usage ? { usage } : {}),
  })
const frame = (rows: Row[]) => zstdCompressSync(Buffer.from(rows.map(row => `${JSON.stringify(row)}\n`).join('')))

/** A home whose `~/.dsh/sessions` holds one session log of `frames`, one Zstandard frame each. */
async function fixture(frames: Row[][], options: { id?: string; cwd?: string } = {}) {
  const home = await temp('latch-cli-usage-home-')
  const id = options.id ?? randomUUID()
  const cwd = options.cwd ?? '/Users/someone/project x'
  const dir = join(home, '.dsh', 'sessions', dshProjectKey(cwd), id)
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'session.v4.jsonl.zstd')
  await writeFile(file, Buffer.concat([frame([header(id, cwd)]), ...frames.map(frame)]))
  return { home, id, cwd, dir, file }
}

const read = (
  place: { home: string; id: string; cwd: string },
  from: number,
  to: number,
  extra: Partial<Parameters<typeof readDshTurnUsage>[0]> = {},
) =>
  readDshTurnUsage({
    home: place.home,
    env: {},
    uid,
    cwd: place.cwd,
    sessionId: place.id,
    from,
    to,
    signal: AbortSignal.timeout(5_000),
    ...extra,
  })

const USAGE = { inputTokens: 100, outputTokens: 40, cacheReadTokens: 900, reasoningTokens: 10 }

describe('the project folder’s directory name', () => {
  it('is dsh’s: separators to one dash, other characters escaped, bounded', () => {
    expect(dshProjectKey('/Users/a b/c::d')).toBe('--Users-a~0020b-c-d--')
    expect(dshProjectKey('/')).toBe('--root--')
    expect(dshProjectKey('/~x')).toBe('--~007Ex--')
    expect(dshProjectKey(`/${'a'.repeat(400)}`)).toHaveLength(255)
  })
})

describe('reading a turn’s tokens', () => {
  it('adds up the turn’s model calls, puts the cached input back in the input, and returns numbers only', async () => {
    const place = await fixture([
      [start(0, 1_000), reply(0, 1_100, { inputTokens: 5, outputTokens: 5 }), end(0, 1_200)],
      [start(1, 2_000), event('user/message', 2_001, { turn: 1, step: 0 }), reply(1, 2_100, USAGE)],
      [reply(1, 2_200, { ...USAGE, cacheWriteTokens: 50 }), event('tool/call', 2_250, { turn: 1, name: 'x', arguments: SECRET_TEXT })],
      [end(1, 2_300)],
    ])
    const usage = await read(place, 1_900, 2_400)
    // Only the parts both calls reported: the second's cache write is left out.
    expect(usage).toEqual({ inputTokens: 2 * (100 + 900) + 50, outputTokens: 80, cacheReadTokens: 1_800, reasoningTokens: 20 })
    expect(JSON.stringify(usage)).not.toContain(SECRET_TEXT)
    // The earlier turn is its own.
    expect(await read(place, 900, 1_300)).toEqual({ inputTokens: 5, outputTokens: 5 })
  })

  it('writes nothing rather than guess: a turn across either edge, unfinished, without usage, or with a subagent', async () => {
    const across = await fixture([[start(0, 1_000), reply(0, 1_100, USAGE), end(0, 1_200)]])
    expect(await read(across, 1_050, 2_000)).toBeUndefined()
    expect(await read(across, 900, 1_150)).toBeUndefined()
    expect(await read(across, 1_300, 2_000)).toBeUndefined()
    const open = await fixture([[start(0, 1_000), reply(0, 1_100, USAGE)]])
    expect(await read(open, 900, 2_000)).toBeUndefined()
    const unreported = await fixture([[start(0, 1_000), reply(0, 1_100, USAGE), reply(0, 1_150), end(0, 1_200)]])
    expect(await read(unreported, 900, 2_000)).toBeUndefined()
    const helped = await fixture([
      [start(0, 1_000), event('subagent/catalog', 1_050, { childId: randomUUID(), childCreatedAt: 1, version: 0, mode: 'one-shot' })],
      [reply(0, 1_100, USAGE), end(0, 1_200)],
      [start(1, 2_000), reply(1, 2_100, USAGE), end(1, 2_200)],
    ])
    expect(await read(helped, 900, 1_300)).toBeUndefined()
    // A child from an earlier turn may still run: the session's later turns are not known either.
    expect(await read(helped, 1_900, 2_300)).toBeUndefined()
  })

  it('reads only a log of the expected ID, folder and format, in lines of the shape it writes', async () => {
    const turn = [start(0, 1_000), reply(0, 1_100, USAGE), end(0, 1_200)]
    const place = await fixture([turn])
    expect(await read(place, 900, 1_300)).toBeDefined()
    // Another folder Latch did not send: another directory, and the header must agree as well.
    expect(await read({ ...place, cwd: '/Users/someone/other' }, 900, 1_300)).toBeUndefined()
    await writeFile(place.file, Buffer.concat([frame([{ ...header(place.id, '/elsewhere') }]), frame(turn)]))
    expect(await read(place, 900, 1_300)).toBeUndefined()
    await writeFile(place.file, Buffer.concat([frame([{ ...header(place.id, place.cwd), version: 5 }]), frame(turn)]))
    expect(await read(place, 900, 1_300)).toBeUndefined()
    await writeFile(
      place.file,
      Buffer.concat([frame([header(place.id, place.cwd)]), frame([{ seq: 0, type: 'turn/start', time: 1_000, data: { turn: 0 } }])]),
    )
    expect(await read(place, 900, 1_300)).toBeUndefined()
  })

  it('keeps the complete lines before a frame cut short as dsh appends', async () => {
    const place = await fixture([[start(0, 1_000), reply(0, 1_100, USAGE), end(0, 1_200)]])
    const torn = frame([start(1, 2_000)])
    await appendFile(place.file, torn.subarray(0, torn.length - 4))
    expect(await read(place, 900, 1_300)).toEqual({ inputTokens: 1_000, outputTokens: 40, cacheReadTokens: 900, reasoningTokens: 10 })
  })

  it('refuses an ID of another shape, a link anywhere on the way, another owner, and a log past its bounds', async () => {
    const turn = [start(0, 1_000), reply(0, 1_100, USAGE), end(0, 1_200)]
    const place = await fixture([turn])
    for (const id of ['../x', `${place.id}/..`, place.id.toUpperCase(), 'sess-1', `${place.id}x`, ''])
      expect(await read({ ...place, id }, 900, 1_300)).toBeUndefined()
    expect(await read(place, 900, 1_300, { uid: uid + 1 })).toBeUndefined()
    expect(await read(place, 900, 1_300, { bounds: { file: 16, text: 1 << 20, line: 1 << 20 } })).toBeUndefined()
    expect(await read(place, 900, 1_300, { bounds: { file: 1 << 20, text: 64, line: 1 << 20 } })).toBeUndefined()
    expect(await read(place, 900, 1_300, { bounds: { file: 1 << 20, text: 1 << 20, line: 64 } })).toBeUndefined()

    // The log a link to a file elsewhere.
    const elsewhere = await fixture([turn], { id: place.id, cwd: place.cwd })
    await rm(place.file)
    await symlink(elsewhere.file, place.file)
    expect(await read(place, 900, 1_300)).toBeUndefined()
    // The session's directory, its project's, `sessions` or `~/.dsh` a link.
    for (const level of [0, 1, 2, 3]) {
      const linked = await fixture([turn])
      const real = await fixture([turn], { id: linked.id, cwd: linked.cwd })
      const parts = [linked.dir, join(linked.dir, '..'), join(linked.dir, '..', '..'), join(linked.home, '.dsh')]
      const target = [real.dir, join(real.dir, '..'), join(real.dir, '..', '..'), join(real.home, '.dsh')][level]!
      await rm(parts[level]!, { recursive: true })
      await symlink(target, parts[level]!)
      expect(await read(linked, 900, 1_300)).toBeUndefined()
    }
  })

  it('settles and lets go of the file when the read is stopped part way', async () => {
    // Many frames of long replies that do not compress: the file is still being read when the read is stopped.
    const frames: Row[][] = []
    for (let turn = 0; turn < 400; turn++)
      frames.push([
        start(turn, 1_000 + turn * 10),
        { ...reply(turn, 1_001 + turn * 10, USAGE), pad: randomBytes(15_000).toString('base64') },
        end(turn, 1_002 + turn * 10),
      ])
    const place = await fixture(frames)
    const open = async () => (await readdir('/dev/fd')).length
    const before = await open()
    for (const after of [0, 1, 5]) {
      const stop = new AbortController()
      const reading = read(place, 900, 1_005, { signal: stop.signal })
      setTimeout(() => stop.abort(), after)
      await expect(reading).resolves.toBeUndefined()
    }
    await vi.waitFor(async () => expect(await open()).toBeLessThanOrEqual(before))
    // Unstopped, the same log is read whole.
    expect(await read(place, 900, 1_005)).toEqual({ inputTokens: 1_000, outputTokens: 40, cacheReadTokens: 900, reasoningTokens: 10 })
  })

  it('reads nothing when DeepSeek Harness’s home or session store is moved', async () => {
    const turn = [start(0, 1_000), reply(0, 1_100, USAGE), end(0, 1_200)]
    const place = await fixture([turn])
    expect(await read(place, 900, 1_300, { env: { DSH_HOME: place.home } })).toBeUndefined()
    expect(await read(place, 900, 1_300, { env: { DSH_HOME: ' ' } })).toBeDefined()
    for (const layer of [join('.dsh', 'cordis.patch.yml'), join('.dsh', 'profiles', 'acp', 'cordis.patch.yml')]) {
      const moved = await fixture([turn])
      await mkdir(join(moved.home, '.dsh', 'profiles', 'acp'), { recursive: true })
      await writeFile(join(moved.home, layer), '- id: session-persistence-jsonl\n  config:\n    root: /tmp/elsewhere\n')
      expect(await read(moved, 900, 1_300)).toBeUndefined()
      await writeFile(join(moved.home, layer), '- id: system-prompt\n')
      expect(await read(moved, 900, 1_300)).toBeDefined()
    }
  })
})

async function everything(dir: string): Promise<string> {
  let text = ''
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []))
    if (entry.isFile()) text += await readFile(join(entry.parentPath, entry.name), 'utf8').catch(() => '')
  return text
}

it('records a DeepSeek Harness turn with the tokens of its own log, only for the preset’s own command and a set home', async () => {
  const root = await temp('latch-cli-usage-host-')
  const bin = join(root, 'bin')
  await mkdir(bin)
  const person = await temp('latch-cli-usage-person-')
  await mkdir(join(person, '.dsh'))
  const usage = { inputTokens: 120, outputTokens: 30, cacheReadTokens: 880, reasoningTokens: 4 }
  await writeFile(
    join(bin, 'dsh'),
    `#!/bin/sh\nif [ "$1" = --version ]; then echo 0.2.2-rc.1; exit 0; fi\nexport FAKE_ACP_PROCESS_MODE=1 FAKE_ACP_CONFIG=options FAKE_ACP_MODES=read-only,workspace-write,danger-full-access FAKE_ACP_INITIAL_MODE=read-only FAKE_ACP_DSH_LOG='${person}' FAKE_ACP_DSH_USAGE='${JSON.stringify(usage)}'\nexec '${process.execPath}' '${FAKE_ACP_AGENT}' "$@"\n`,
  )
  await chmod(join(bin, 'dsh'), 0o755)
  const lines: string[] = []
  const dataDir = join(root, 'data')
  const options = {
    demo: false,
    dataDir,
    workspaceRoot: join(root, 'project'),
    log: (line: string) => void lines.push(line),
    commandDirectories: () => [bin],
    loginPrograms: (name: string) => (name === 'dsh' ? join(bin, 'dsh') : undefined),
    detectPreset: (preset: { id: string }) => (preset.id === 'dsh' ? { found: true, path: join(bin, 'dsh') } : { found: false }),
    cliUsage: { home: person },
  }
  const t = await startTestHost(options)
  cleanups.push(() => t.close())
  const owner = await t.enroll({ listener: 'unix' })
  await owner.confirmedJson('agents', {
    body: { id: 'dsh', name: 'DeepSeek Harness', presetId: 'dsh', command: 'dsh', args: ['--profile', 'acp'], env: {} },
  })
  const turns = async () => {
    const text = await everything(join(dataDir, 'usage'))
    return text
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as Record<string, unknown>)
  }
  const { sessionId } = await owner.confirmedJson<{ sessionId: string }>('tasks', {
    body: { prompt: `echo ${SECRET_TEXT}`, requestId: randomUUID(), harnessId: 'dsh' },
  })
  await vi.waitFor(async () => expect(await turns()).toHaveLength(1), { timeout: 10_000, interval: 50 })
  expect((await turns())[0]).toMatchObject({
    sessionId,
    harness: 'dsh',
    inputTokens: 1_000,
    outputTokens: 30,
    cacheReadTokens: 880,
    reasoningTokens: 4,
  })
  // A turn with a subagent in the session is recorded without tokens.
  await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'echo with-subagent', requestId: randomUUID() } })
  await vi.waitFor(async () => expect(await turns()).toHaveLength(2), { timeout: 10_000, interval: 50 })
  expect((await turns())[1]).not.toHaveProperty('inputTokens')
  // Nothing of the log's text went anywhere but its own file.
  const kept = `${await everything(dataDir)}\n${lines.join('\n')}`
  expect(kept).not.toContain('private prompt')
  expect(JSON.stringify(await turns())).not.toContain(SECRET_TEXT)
})
