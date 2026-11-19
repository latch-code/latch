// The Host's reads and removals in goose's, DeepSeek Harness's and Qwen Code's own stores (src/cli-stores.ts). Every
// home is a temporary directory; every record is written here in the shape the program writes (goose 1.57.0's SQLite
// tables and message JSON, dsh 0.2.2-rc.1's Zstandard session log, Qwen Code 0.27.4's managed update files).
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import {
  gooseChildSessions,
  gooseResumeState,
  gooseTurnUsage,
  gooseSessionsDb,
  qwenRunningCode,
  removeDshSession,
} from '../src/cli-stores.ts'
import { dshProjectKey } from '../src/cli-usage.ts'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const uid = process.getuid!()

async function temp(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}

// ---- goose ------------------------------------------------------------------------------------------------------

type Content = Record<string, unknown>
const text = (value: string): Content => ({ type: 'text', text: value })
const toolRequest = (id: string): Content => ({
  type: 'toolRequest',
  id,
  toolCall: { status: 'success', value: { name: 'developer__shell', arguments: { command: 'touch /tmp/x' } } },
})
const toolResponse = (id: string): Content => ({
  type: 'toolResponse',
  id,
  toolResult: { status: 'success', value: { content: [{ type: 'text', text: 'done' }] } },
})
const confirmation = (id: string): Content => ({
  type: 'actionRequired',
  data: { actionType: 'toolConfirmation', id, toolName: 'developer__shell', arguments: {}, prompt: null },
})
const confirmed = (id: string, permission = 'allow_once'): Content => ({
  type: 'actionRequired',
  data: { actionType: 'toolConfirmationResponse', id, permission },
})
type Message = { role: 'user' | 'assistant'; content: Content[]; visible?: boolean }
const user = (...content: Content[]): Message => ({ role: 'user', content })
const hidden = (...content: Content[]): Message => ({ role: 'user', content, visible: false })
const assistant = (...content: Content[]): Message => ({ role: 'assistant', content })

/** goose's tables as 1.57.0 creates them, the columns read here among the rest. */
function gooseTables(db: DatabaseSync): void {
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', session_type TEXT NOT NULL DEFAULT 'user',
      working_dir TEXT NOT NULL, extension_data TEXT DEFAULT '{}', parent_session_id TEXT);
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT, session_id TEXT NOT NULL REFERENCES sessions(id),
      role TEXT NOT NULL, content_json TEXT NOT NULL, created_timestamp INTEGER NOT NULL, timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      tokens INTEGER, metadata_json TEXT);`)
}

/** A goose home (its XDG data directory) whose database holds `sessions`, each with its messages in order. */
async function gooseHome(sessions: Record<string, { messages: Message[]; parent?: string }>) {
  const home = await temp('latch-goose-home-')
  const path = gooseSessionsDb(home, {})
  await mkdir(join(path, '..'), { recursive: true })
  const db = new DatabaseSync(path)
  gooseTables(db)
  const addSession = db.prepare('INSERT INTO sessions (id, working_dir, session_type, parent_session_id) VALUES (?, ?, ?, ?)')
  const addMessage = db.prepare(
    'INSERT INTO messages (message_id, session_id, role, content_json, created_timestamp, metadata_json) VALUES (?, ?, ?, ?, ?, ?)',
  )
  for (const [id, { messages, parent }] of Object.entries(sessions)) {
    addSession.run(id, '/Users/someone/project', parent ? 'sub_agent' : 'acp', parent ?? null)
    messages.forEach((message, index) =>
      addMessage.run(
        randomUUID(),
        id,
        message.role,
        JSON.stringify(message.content),
        1_763_500_000 + index,
        JSON.stringify({ userVisible: message.visible ?? true, agentVisible: true }),
      ),
    )
  }
  db.close()
  return { home, path }
}

describe("goose's record before a session is opened again", () => {
  it('is clear only when the last turn holds no confirmation or answer whose tool has not run', async () => {
    const { home } = await gooseHome({
      done: { messages: [user(text('list files')), assistant(toolRequest('t1')), user(toolResponse('t1')), assistant(text('done'))] },
      // Asked and answered, then run: goose answers the tool, and the turn ended.
      answered: {
        messages: [
          user(text('remove it')),
          assistant(toolRequest('t2')),
          assistant(confirmation('t2')),
          hidden(confirmed('t2')),
          user(toolResponse('t2')),
          assistant(text('removed')),
        ],
      },
      // Stopped on the question: loading asks it again and goes on with the turn.
      pending: { messages: [user(text('remove it')), assistant(toolRequest('t3')), assistant(confirmation('t3'))] },
      // Answered (in goose, or in Latch before a crash) but never run: loading applies the answer and goes on, unasked.
      approved: {
        messages: [user(text('remove it')), assistant(toolRequest('t4')), assistant(confirmation('t4')), hidden(confirmed('t4'))],
      },
      // A refusal not applied yet is still a turn goose goes on with: not certain, so not opened.
      refused: {
        messages: [
          user(text('remove it')),
          assistant(toolRequest('t5')),
          assistant(confirmation('t5')),
          hidden(confirmed('t5', 'deny_once')),
        ],
      },
      // An old turn's question no longer counts once a new turn began with the person's next message.
      earlier: {
        messages: [
          user(text('remove it')),
          assistant(toolRequest('t6')),
          assistant(confirmation('t6')),
          user(text('never mind')),
          assistant(text('ok')),
        ],
      },
      empty: { messages: [] },
    })
    const state = (sessionId: string) => gooseResumeState({ home, env: {}, uid, sessionId })
    expect(state('done')).toBe('clear')
    expect(state('answered')).toBe('clear')
    expect(state('earlier')).toBe('clear')
    expect(state('empty')).toBe('clear')
    expect(state('pending')).toBe('blocked')
    expect(state('approved')).toBe('blocked')
    expect(state('refused')).toBe('blocked')
    // A session the database does not have, or an ID that is no goose ID, says nothing: not opened.
    expect(state('missing')).toBe('blocked')
    expect(state("x' OR 1=1 --")).toBe('blocked')
  })

  it('reads the database goose uses: its root, else the XDG data directory, else the home; nothing it cannot see is clear', async () => {
    const home = '/Users/someone'
    expect(gooseSessionsDb(home, {})).toBe('/Users/someone/.local/share/goose/sessions/sessions.db')
    expect(gooseSessionsDb(home, { XDG_DATA_HOME: '/data' })).toBe('/data/goose/sessions/sessions.db')
    expect(gooseSessionsDb(home, { GOOSE_PATH_ROOT: '/root', XDG_DATA_HOME: '/data' })).toBe('/root/data/sessions/sessions.db')
    // goose ignores a relative root and a relative XDG directory.
    expect(gooseSessionsDb(home, { GOOSE_PATH_ROOT: 'root', XDG_DATA_HOME: 'data' })).toBe(
      '/Users/someone/.local/share/goose/sessions/sessions.db',
    )

    const { path } = await gooseHome({ done: { messages: [user(text('hi'))] } })
    const root = await temp('latch-goose-root-')
    await mkdir(join(root, 'data', 'sessions'), { recursive: true })
    await symlink(path, join(root, 'data', 'sessions', 'sessions.db'))
    // Through a link, or with no database at all, nothing is certain.
    expect(gooseResumeState({ home: root, env: { GOOSE_PATH_ROOT: root }, uid, sessionId: 'done' })).toBe('blocked')
    expect(gooseResumeState({ home: await temp('latch-goose-none-'), env: {}, uid, sessionId: 'done' })).toBe('blocked')
    // A broken message is not read past.
    const broken = await gooseHome({ done: { messages: [user(text('hi'))] } })
    const db = new DatabaseSync(broken.path)
    db.prepare("UPDATE messages SET content_json = 'not json'").run()
    db.close()
    expect(gooseResumeState({ home: broken.home, env: {}, uid, sessionId: 'done' })).toBe('blocked')
  })

  it('reads while goose holds the database open and writes nothing beside it', async () => {
    const { home, path } = await gooseHome({ pending: { messages: [user(text('x')), assistant(confirmation('t1'))] } })
    const before = (await readdir(join(path, '..'))).sort()
    expect(gooseResumeState({ home, env: {}, uid, sessionId: 'pending' })).toBe('blocked')
    expect((await readdir(join(path, '..'))).sort()).toEqual(before)
    // goose itself has it open, in WAL with a write not yet checkpointed: the reader sees that write.
    const writer = new DatabaseSync(path)
    cleanups.push(() => writer.close())
    writer
      .prepare('INSERT INTO messages (session_id, role, content_json, created_timestamp, metadata_json) VALUES (?, ?, ?, ?, ?)')
      .run('pending', 'user', JSON.stringify([toolResponse('t1')]), 1_763_600_000, '{"userVisible":false,"agentVisible":true}')
    expect(gooseResumeState({ home, env: {}, uid, sessionId: 'pending' })).toBe('clear')
  })

  it('finds the subagent sessions of a session at any depth, and nothing for an unreadable database', async () => {
    const { home } = await gooseHome({
      parent: { messages: [] },
      child: { messages: [], parent: 'parent' },
      grandchild: { messages: [], parent: 'child' },
      other: { messages: [] },
      stranger: { messages: [], parent: 'other' },
    })
    expect(gooseChildSessions({ home, env: {}, uid, sessionIds: ['parent'] }).sort()).toEqual(['child', 'grandchild'])
    expect(gooseChildSessions({ home, env: {}, uid, sessionIds: ['nobody'] })).toEqual([])
    expect(gooseChildSessions({ home: await temp('latch-goose-none-'), env: {}, uid, sessionIds: ['parent'] })).toEqual([])
  })
})

describe("a goose turn's tokens from its own ledger", () => {
  /** A ledger row as goose's `record_usage` writes it: one per model call, stamped to the second. */
  async function ledger(
    rows: Array<{ at: number; input: number | null; output: number | null; read?: number | null; write?: number | null }>,
  ) {
    const { home, path } = await gooseHome({ session: { messages: [] }, other: { messages: [] } })
    const db = new DatabaseSync(path)
    db.exec(`CREATE TABLE usage_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, created_timestamp INTEGER NOT NULL,
      model TEXT, input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
      cost REAL, cost_source TEXT, is_compaction INTEGER DEFAULT 0)`)
    const add = db.prepare(
      'INSERT INTO usage_ledger (session_id, created_timestamp, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens) VALUES (?, ?, ?, ?, ?, ?)',
    )
    for (const row of rows) add.run('session', row.at, row.input, row.output, row.read ?? null, row.write ?? null)
    add.run('other', 1_000_005, 999, 999, 0, 0)
    db.close()
    return home
  }
  const turn = (home: string, from = 1_000_000_500, to = 1_000_010_000) =>
    gooseTurnUsage({ home, env: {}, uid, sessionId: 'session', from, to })

  it("adds up the session's calls inside the turn, cached input already in the input", async () => {
    const home = await ledger([
      { at: 999_000, input: 50, output: 5, read: 0, write: 0 },
      { at: 1_000_002, input: 1_000, output: 40, read: 900, write: 0 },
      { at: 1_000_009, input: 1_200, output: 60, read: 1_100, write: 20 },
      { at: 1_000_020, input: 70, output: 7, read: 0, write: 0 },
    ])
    expect(turn(home)).toEqual({ inputTokens: 2_200, outputTokens: 100, cacheReadTokens: 2_000, cacheWriteTokens: 20 })
  })

  it('is unknown with a call in the second the turn began, a count that is none, or no call at all', async () => {
    expect(turn(await ledger([{ at: 1_000_000, input: 10, output: 1 }]))).toBeUndefined()
    expect(turn(await ledger([{ at: 1_000_002, input: null, output: 1 }]))).toBeUndefined()
    expect(turn(await ledger([]))).toBeUndefined()
    // A cache count goose did not get is left out, not taken as zero.
    expect(turn(await ledger([{ at: 1_000_002, input: 10, output: 1 }]))).toEqual({ inputTokens: 10, outputTokens: 1 })
  })
})

// ---- DeepSeek Harness -------------------------------------------------------------------------------------------

const frame = (rows: Array<Record<string, unknown>>) => zstdCompressSync(Buffer.from(rows.map(row => `${JSON.stringify(row)}\n`).join('')))
const dshHeader = (id: string, cwd: string, parentSession?: string) => ({
  type: 'session',
  version: 4,
  id,
  createdAt: 1,
  isSeeded: false,
  delegationDepth: parentSession ? 1 : 0,
  cwd,
  ...(parentSession ? { parentSession, origin: 'subagent' } : {}),
})

/** A dsh home with these sessions in `cwd`'s project directory, each with its log, lock and cached projection. */
async function dshHome(cwd: string, sessions: Array<{ id: string; parent?: string; headerCwd?: string }>) {
  const home = await temp('latch-dsh-home-')
  const project = join(home, '.dsh', 'sessions', dshProjectKey(cwd))
  const cache = join(home, '.dsh', 'storages', 'session_projcache', 'sessions')
  await mkdir(cache, { recursive: true })
  for (const { id, parent, headerCwd } of sessions) {
    await mkdir(join(project, id), { recursive: true })
    await writeFile(
      join(project, id, 'session.v4.jsonl.zstd'),
      Buffer.concat([
        frame([dshHeader(id, headerCwd ?? cwd, parent)]),
        frame([{ type: 'turn/start', seq: 1, time: 2, data: { turn: 0 } }]),
      ]),
    )
    await writeFile(join(project, id, 'session.lock'), '')
    await writeFile(join(cache, `${id}.json`), '{}')
  }
  return { home, project, cache }
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  )

describe("DeepSeek Harness's record of a session Latch opened", () => {
  const cwd = '/Users/someone/project x'
  const official = async () => 'official' as const

  it('is removed with its subagent sessions and cached projections, and nothing of another session', async () => {
    const [own, child, grandchild, other] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()]
    const { home, project, cache } = await dshHome(cwd, [
      { id: own },
      { id: child, parent: own },
      { id: grandchild, parent: child },
      { id: other },
    ])
    expect(await removeDshSession({ home, env: {}, uid, sessionId: own, cwd, config: official })).toBe(true)
    for (const id of [own, child, grandchild]) {
      expect(await exists(join(project, id))).toBe(false)
      expect(await exists(join(cache, `${id}.json`))).toBe(false)
    }
    expect(await exists(join(project, other, 'session.v4.jsonl.zstd'))).toBe(true)
    expect(await exists(join(cache, `${other}.json`))).toBe(true)
  })

  it('stays when the log does not name this session and folder, the home moved, or a layer of the person names the store', async () => {
    const own = randomUUID()
    const elsewhere = await dshHome(cwd, [{ id: own, headerCwd: '/Users/someone/other' }])
    expect(await removeDshSession({ home: elsewhere.home, env: {}, uid, sessionId: own, cwd, config: official })).toBe(false)
    expect(await exists(join(elsewhere.project, own))).toBe(true)

    const { home, project } = await dshHome(cwd, [{ id: own }])
    expect(await removeDshSession({ home, env: { DSH_HOME: join(home, 'elsewhere') }, uid, sessionId: own, cwd, config: official })).toBe(
      false,
    )
    expect(await removeDshSession({ home, env: {}, uid, sessionId: '../etc', cwd, config: official })).toBe(false)
    expect(await removeDshSession({ home, env: {}, uid, sessionId: randomUUID(), cwd, config: official })).toBe(false)
    // DeepSeek Harness's own composition says a layer changed its session store.
    expect(await removeDshSession({ home, env: {}, uid, sessionId: own, cwd, config: async () => 'changed' })).toBe(false)
    expect(await exists(join(project, own))).toBe(true)
  })
})

// ---- Qwen Code --------------------------------------------------------------------------------------------------

describe('what Qwen Code runs after updating itself', () => {
  /** An installed entry and a Qwen home; `active` writes the update it points at. */
  async function qwen() {
    const home = await temp('latch-qwen-home-')
    const entry = join(home, 'install', 'cli.js')
    await mkdir(join(home, 'install'), { recursive: true })
    await writeFile(entry, '')
    const bin = join(home, 'bin-qwen')
    await symlink(entry, bin)
    const launcher = (qwenHome: string) => join(qwenHome, 'updates', 'npm', createHash('sha256').update(entry).digest('hex').slice(0, 16))
    const active = async (qwenHome: string, version: string) => {
      const root = launcher(qwenHome)
      const pkg = join(root, 'versions', version, 'node_modules', '@qwen-code', 'qwen-code')
      await mkdir(pkg, { recursive: true })
      await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: '@qwen-code/qwen-code', version }))
      await writeFile(join(root, 'active.json'), JSON.stringify({ version, bootstrap: entry, baseVersion: '0.26.8' }))
    }
    return { home, bin, active }
  }

  it('is nothing while it runs itself, and changes with the version its update runs', async () => {
    const { home, bin, active } = await qwen()
    expect(qwenRunningCode({ home, env: {}, command: bin })).toBeUndefined()
    await active(join(home, '.qwen'), '0.27.4')
    const first = qwenRunningCode({ home, env: {}, command: bin })
    expect(first).toMatch(/^[0-9a-f]{64}$/u)
    await active(join(home, '.qwen'), '0.27.5')
    const second = qwenRunningCode({ home, env: {}, command: bin })
    expect(second).toMatch(/^[0-9a-f]{64}$/u)
    expect(second).not.toBe(first)
  })

  it('looks where QWEN_HOME points, from the environment or from its home files', async () => {
    const { home, bin, active } = await qwen()
    const moved = join(home, 'moved')
    await active(moved, '0.27.4')
    expect(qwenRunningCode({ home, env: {}, command: bin })).toBeUndefined()
    expect(qwenRunningCode({ home, env: { QWEN_HOME: moved }, command: bin })).toMatch(/^[0-9a-f]{64}$/u)
    await mkdir(join(home, '.qwen'), { recursive: true })
    await writeFile(join(home, '.qwen', '.env'), `OTHER=1\nexport QWEN_HOME="${moved}"\n`)
    expect(qwenRunningCode({ home, env: {}, command: bin })).toBe(qwenRunningCode({ home, env: { QWEN_HOME: moved }, command: bin }))
  })
})
