import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ClaudeStore } from '../src/claude-store.ts'
import { promptText, replayUpdates } from '../src/wires/claude-history.ts'
import { answer, claudeFixture, line, prompt, result, uuidOf, type ClaudeFixture } from './helpers/claude-store.ts'

const S1 = '11111111-1111-4111-8111-111111111111'
const S2 = '22222222-2222-4222-8222-222222222222'
const S3 = '33333333-3333-4333-8333-333333333333'

let fixture: ClaudeFixture | undefined
afterEach(async () => {
  await fixture?.remove()
  fixture = undefined
})

/** A terminal session with a read, a subagent, a compaction, a slash command and an image; and one an SDK started. */
async function sessions(f: ClaudeFixture) {
  const l = line(S1, f.project)
  await f.write(S1, [
    l(prompt(uuidOf(1), null, 'hello first prompt')),
    l(
      answer(uuidOf(2), uuidOf(1), 'msg_1', [
        { type: 'thinking', thinking: 'hmm', signature: 's' },
        { type: 'text', text: 'I will read' },
        { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: join(f.project, 'a.txt') } },
      ]),
    ),
    l(result(uuidOf(3), uuidOf(2), 'toolu_1', 'file body')),
    l(answer(uuidOf(4), uuidOf(3), 'msg_2', [{ type: 'text', text: 'first answer' }])),
    l({
      type: 'system',
      subtype: 'compact_boundary',
      uuid: uuidOf(5),
      parentUuid: null,
      logicalParentUuid: uuidOf(4),
      content: 'Conversation compacted',
    }),
    l({ ...prompt(uuidOf(6), uuidOf(5), 'This session is being continued… summary'), isCompactSummary: true, isMeta: true }),
    l(
      prompt(
        uuidOf(7),
        uuidOf(6),
        '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>',
      ),
    ),
    l(
      prompt(uuidOf(8), uuidOf(7), [
        { type: 'text', text: 'see image' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
      ]),
    ),
    l(
      answer(uuidOf(9), uuidOf(8), 'msg_3', [
        { type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'ls', description: 'list' } },
      ]),
    ),
    l(result(uuidOf(10), uuidOf(9), 'toolu_2', 'boom', true)),
    l(answer(uuidOf(11), uuidOf(10), 'msg_4', [{ type: 'text', text: 'nice image' }])),
    { type: 'custom-title', customTitle: 'My titled session', sessionId: S1 },
  ])
  await mkdir(join(f.projectDir, S1, 'subagents'), { recursive: true })
  await writeFile(join(f.projectDir, S1, 'subagents', 'agent-abc.jsonl'), '')
  await mkdir(join(f.config, 'file-history', S1), { recursive: true })
  const sdk = line(S2, f.project, 'sdk-ts')
  await f.write(S2, [
    sdk(prompt(uuidOf(201), null, 'sdk prompt')),
    sdk(answer(uuidOf(202), uuidOf(201), 'msg_x', [{ type: 'text', text: 'sdk answer' }])),
  ])
}

describe('Claude store reader (real Agent SDK, a configuration directory of the test’s own)', () => {
  it('lists the sessions a terminal started, never those an SDK started, newest first, with their titles', async () => {
    fixture = await claudeFixture()
    await sessions(fixture)
    const store = new ClaudeStore(fixture.env)
    const page = await store.list(0, 100)
    expect(page.sessions.map(row => row.sessionId)).toEqual([S1])
    expect(page.sessions[0]).toMatchObject({ cwd: fixture.project, title: 'My titled session' })
    expect(page.more).toBe(false)
    expect(await store.info(S1, fixture.project)).toMatchObject({ exists: true })
    expect(await store.info(S3, fixture.project)).toEqual({ exists: false })
  })

  it('reads the session the environment names, not the Host’s: another directory holds none of it', async () => {
    fixture = await claudeFixture()
    await sessions(fixture)
    const elsewhere = new ClaudeStore({ ...fixture.env, CLAUDE_CONFIG_DIR: join(fixture.root, 'other') })
    expect((await elsewhere.list(0, 100)).sessions).toEqual([])
    expect(process.env.CLAUDE_CONFIG_DIR).not.toBe(fixture.config)
  })

  it('replays words, tool calls and results, without Claude’s notes, summaries, its own commands or image bytes', async () => {
    fixture = await claudeFixture()
    await sessions(fixture)
    const read = await new ClaudeStore(fixture.env).messages(S1, fixture.project, 8 * 1024 * 1024)
    // Only what came after the last compaction: Claude's own read returns that part.
    expect(read.compacted).toBe(true)
    expect(JSON.stringify(read)).not.toContain('iVBORw0KGgo')
    const updates = replayUpdates(read.messages, fixture.project)
    expect(updates.map(update => update.sessionUpdate)).toEqual([
      'user_message_chunk',
      'tool_call',
      'tool_call_update',
      'agent_message_chunk',
    ])
    expect(updates[0]).toMatchObject({ content: { text: 'see image' } })
    expect(updates[1]).toMatchObject({ toolCallId: 'toolu_2', title: 'ls', kind: 'execute' })
    expect(updates[2]).toMatchObject({ toolCallId: 'toolu_2', status: 'failed' })
    expect(updates[3]).toMatchObject({ messageId: 'msg_4', content: { text: 'nice image' } })
  })

  it('keeps a person’s own slash command and hides those Claude Code answers itself', () => {
    expect(promptText('<command-name>/review</command-name><command-args>main</command-args>')).toBe('/review main')
    expect(promptText('<command-name>/compact</command-name><command-args></command-args>')).toBeUndefined()
    expect(promptText('<local-command-stdout>ok</local-command-stdout>')).toBeUndefined()
    expect(promptText('look <system-reminder>secret note</system-reminder>')).toBe('look')
  })

  it('deletes a transcript and its folder, leaves Claude’s other leftovers, and finds nothing the second time', async () => {
    fixture = await claudeFixture()
    await sessions(fixture)
    const store = new ClaudeStore(fixture.env)
    expect(await store.delete(S1, fixture.project)).toEqual({ deleted: true })
    expect(existsSync(join(fixture.projectDir, `${S1}.jsonl`))).toBe(false)
    expect(existsSync(join(fixture.projectDir, S1))).toBe(false)
    // Claude cleans these up itself (cleanupPeriodDays).
    expect(existsSync(join(fixture.config, 'file-history', S1))).toBe(true)
    expect(await store.delete(S1, fixture.project)).toEqual({ deleted: false })
    // A folder that is gone is looked past: the session is found in any project.
    expect(await store.delete(S2, join(fixture.root, 'gone'))).toEqual({ deleted: true })
  })

  it('forks at the turn Latch’s message opened, through the last line before the next prompt, even across a compaction', async () => {
    fixture = await claudeFixture()
    const first = uuidOf(901)
    const second = uuidOf(902)
    const l = line(S3, fixture.project, 'sdk-ts')
    await fixture.write(S3, [
      l(prompt(first, null, 'first')),
      l(answer(uuidOf(2), first, 'msg_1', [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/x' } }])),
      l(result(uuidOf(3), uuidOf(2), 'toolu_1', 'x')),
      l(answer(uuidOf(4), uuidOf(3), 'msg_2', [{ type: 'text', text: 'one' }])),
      l({ type: 'system', subtype: 'compact_boundary', uuid: uuidOf(5), parentUuid: null, logicalParentUuid: uuidOf(4), content: 'c' }),
      l({ ...prompt(uuidOf(6), uuidOf(5), 'summary'), isCompactSummary: true, isMeta: true }),
      l(prompt(second, uuidOf(6), 'second')),
      l(answer(uuidOf(8), second, 'msg_3', [{ type: 'text', text: 'two' }])),
    ])
    const store = new ClaudeStore(fixture.env)
    const forked = await store.fork(S3, first, fixture.project)
    expect('sessionId' in forked).toBe(true)
    const id = (forked as { sessionId: string }).sessionId
    const copied = (await readFile(join(fixture.projectDir, `${id}.jsonl`), 'utf8'))
      .trim()
      .split('\n')
      .map(text => JSON.parse(text) as Record<string, any>)
      .filter(entry => entry.type === 'user' || entry.type === 'assistant')
    expect(copied.at(-1)!.forkedFrom).toEqual({ sessionId: S3, messageUuid: uuidOf(4) })
    expect(copied.some(entry => entry.forkedFrom?.messageUuid === second)).toBe(false)
    // Through the last turn: the whole session.
    const whole = (await store.fork(S3, second, fixture.project)) as { sessionId: string }
    const tail = (await readFile(join(fixture.projectDir, `${whole.sessionId}.jsonl`), 'utf8'))
      .trim()
      .split('\n')
      .map(text => JSON.parse(text))
    expect(tail.filter(entry => entry.type === 'assistant').at(-1).forkedFrom.messageUuid).toBe(uuidOf(8))
    expect(await store.fork(S3, uuidOf(999), fixture.project)).toEqual({ refused: 'missing' })
  })

  it('reads settings as facts: disabled modes, the rules that allow and where each is written, never a value', async () => {
    fixture = await claudeFixture()
    await writeFile(
      join(fixture.config, 'settings.json'),
      JSON.stringify({
        permissions: { disableBypassPermissionsMode: 'disable', defaultMode: 'acceptEdits', allow: ['Bash(npm test:*)'] },
        env: { SECRET_THING: 'do-not-leak-1234' },
        cleanupPeriodDays: 7,
        maxEffortLevel: 'medium',
      }),
    )
    await mkdir(join(fixture.project, '.claude'), { recursive: true })
    await writeFile(
      join(fixture.project, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Read'], disableAutoMode: 'disable' } }),
    )
    await writeFile(join(fixture.project, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { defaultMode: 'auto' } }))
    const read = await new ClaudeStore(fixture.env).settings(fixture.project)
    expect(read).toMatchObject({ disableBypass: true, disableAuto: true, cleanupPeriodDays: 7, maxEffortLevel: 'medium' })
    expect(read.allow).toEqual(
      expect.arrayContaining(
        [
          { rule: 'Bash(npm test:*)', source: 'userSettings' },
          { rule: 'Read', source: 'projectSettings' },
        ].map(item => expect.objectContaining({ rule: item.rule })),
      ),
    )
    // The local layer's `auto` is not honoured from a project's files, and does not fall back to the user's mode.
    expect(read.startMode).toBeUndefined()
    expect(JSON.stringify(read)).not.toContain('do-not-leak')
  })

  it('says a session is open in another claude only from a live process’s own record, never from a .key file', async () => {
    fixture = await claudeFixture()
    const store = new ClaudeStore(fixture.env)
    const registry = join(fixture.config, 'sessions')
    await mkdir(registry, { recursive: true })
    expect(await store.busy(S1)).toEqual({ busy: false })
    // The test's own process stands for a running claude: alive, with its start time as `ps` gives it.
    const procStart = execFileSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } })
      .toString()
      .trim()
    await writeFile(join(registry, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: S1, procStart, status: 'idle' }))
    await writeFile(join(registry, `${process.pid}.key`), 'never opened')
    expect(await store.busy(S1)).toEqual({ busy: true })
    expect(await store.busy(S2)).toEqual({ busy: false })
    // A reused pid (another start time) does not count.
    await writeFile(
      join(registry, `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, sessionId: S1, procStart: 'Mon Jan  1 00:00:00 2001' }),
    )
    expect(await store.busy(S1)).toEqual({ busy: false })
    expect((await readdir(registry)).sort()).toEqual([`${process.pid}.json`, `${process.pid}.key`])
  })

  it('refuses what is not a session ID before the SDK sees it', async () => {
    fixture = await claudeFixture()
    await expect(new ClaudeStore(fixture.env).delete('../../etc', fixture.project)).rejects.toMatchObject({ refused: true })
  })
})
