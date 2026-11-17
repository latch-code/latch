import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { ExtensionsResponse, TaskDetail, WorkspaceInfo } from '@latch/protocol'
import { FAKE_ACP_AGENT, FAKE_CODEX_APP_SERVER } from '@latch/testkit'
import { startTestHost } from './helpers/host.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture(codex = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-extensions-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'project')
  await mkdir(project)
  const second = join(root, 'second')
  await mkdir(second)
  const log = join(root, 'agent.jsonl')
  const commands = join(root, 'commands.json')
  await writeFile(commands, JSON.stringify([{ name: 'public-plan', description: '检查计划' }]))
  const skills = join(root, 'skills.json')
  await writeFile(
    skills,
    JSON.stringify([{ name: 'review', description: '审查', path: join(root, 'review', 'SKILL.md'), scope: 'repo', enabled: true }]),
  )
  const bin = join(root, 'bin')
  const program = join(bin, 'codex')
  if (codex) {
    await mkdir(bin)
    await writeFile(program, `#!/bin/sh\nexec '${process.execPath}' '${FAKE_CODEX_APP_SERVER}' "$@"\n`)
    await chmod(program, 0o755)
  }
  const host = await startTestHost({
    dataDir: join(root, 'data'),
    workspaceRoot: join(root, 'default'),
    ...(codex
      ? {
          commandDirectories: () => [bin],
          loginPrograms: (name: string) => (name === 'codex' ? program : undefined),
          detectPreset: (preset: { id: string }) => (preset.id === 'codex' ? { found: true, path: program } : { found: false }),
        }
      : {}),
  })
  cleanups.push(() => host.close())
  const owner = await host.enroll({ listener: 'unix' })
  const workspace = ((await (await owner.addFolders({ paths: [project], name: '扩展项目' })).json()) as { workspace: WorkspaceInfo })
    .workspace
  const other = ((await (await owner.addFolders({ paths: [second], name: '另一个项目' })).json()) as { workspace: WorkspaceInfo }).workspace
  await owner.confirmedJson('agents', {
    body: {
      id: 'fake',
      ...(codex ? { presetId: 'codex' } : {}),
      name: 'Fake',
      command: codex ? 'codex' : process.execPath,
      args: codex ? [] : [FAKE_ACP_AGENT],
      env: {
        FAKE_ACP_LOG: log,
        FAKE_ACP_COMMANDS_FILE: commands,
        ...(codex ? { FAKE_CODEX_SKILLS_FILE: skills, FAKE_CODEX_STATE: join(root, 'threads.json') } : {}),
      },
    },
  })
  const starts = async () =>
    (await readFile(log, 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as { event: string })
      .filter(line => line.event === 'start').length
  const create = async (workspaceId = workspace.id) => {
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { harnessId: 'fake', workspaceId, prompt: 'plan', requestId: randomUUID() },
    })
    await vi.waitFor(async () => expect((await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('idle'))
    return sessionId
  }
  const read = () => owner.json<ExtensionsResponse>('extensions')
  return { root, host, owner, workspace, other, commands, starts, create, read }
}

it('lists per Harness only what a session reported, for admin devices only, and starts no program to read it', async () => {
  const f = await fixture()
  expect(await f.read()).toEqual({ harnesses: [{ harnessId: 'fake' }] })
  expect(await f.starts()).toBe(0)

  for (const scopes of [['view'], ['view', 'run']] as const) {
    const device = await f.host.enroll({ scopes: [...scopes] })
    expect((await device.request('extensions')).status).toBe(403)
  }

  const id = await f.create()
  const started = await f.starts()
  await vi.waitFor(async () =>
    expect((await f.read()).harnesses[0]?.report).toMatchObject({
      commands: [{ name: 'public-plan', description: '检查计划' }],
      projectId: f.workspace.id,
    }),
  )
  const body = JSON.stringify(await f.read())
  expect(body).not.toContain(id)
  expect(body).not.toContain(f.root)
  expect((await f.read()).harnesses[0]?.report?.skills).toBeUndefined()
  expect(await f.starts()).toBe(started)
})

it('reads nothing from any CLI home: the same answer with every CLI home absent or unreadable', async () => {
  const f = await fixture()
  await f.create()
  await vi.waitFor(async () => expect((await f.read()).harnesses[0]?.report).toBeDefined())
  const before = await f.read()
  const locked = join(f.root, 'locked-home')
  await mkdir(join(locked, '.codex'), { recursive: true })
  await chmod(locked, 0o000)
  const names = ['HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'PI_CODING_AGENT_DIR'] as const
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]))
  try {
    for (const home of [locked, join(f.root, 'absent-home')]) {
      for (const name of names) process.env[name] = name === 'HOME' ? home : join(home, name.toLowerCase())
      expect(await f.read()).toEqual(before)
    }
  } finally {
    for (const name of names) {
      const value = saved[name]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await chmod(locked, 0o755)
  }
})

it('carries the skills Codex reported, with their scope and no private path', async () => {
  const f = await fixture(true)
  await f.create()
  await vi.waitFor(async () =>
    expect((await f.read()).harnesses[0]?.report?.skills).toEqual([
      { name: 'review', description: '审查', invocation: '$review', scope: 'project' },
    ]),
  )
  expect(JSON.stringify(await f.read())).not.toContain('SKILL.md')
})

it('never lists a report from a private session: it falls back to the newest ordinary one, or to none', async () => {
  const f = await fixture()
  const first = await f.create()
  await vi.waitFor(async () => expect((await f.read()).harnesses[0]?.report?.projectId).toBe(f.workspace.id))
  await writeFile(f.commands, JSON.stringify([{ name: 'private-plan', description: '私有' }]))
  const id = await f.create(f.other.id)
  await vi.waitFor(async () => expect((await f.read()).harnesses[0]?.report?.projectId).toBe(f.other.id))
  // A Host-owned private-context transition through the real Bridge, as for the draft cache.
  const makePrivate = async (sessionId: string) => {
    await f.host.host.bridge.prompt(sessionId, 'Continue', randomUUID(), {
      agentContext: { instructions: 'PRIVATE SOURCE CONTEXT', revision: 'a'.repeat(64) },
    })
    await vi.waitFor(async () => expect((await f.owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('idle'))
  }
  await makePrivate(id)
  const listed = await f.read()
  expect(listed.harnesses[0]?.report).toMatchObject({ commands: [{ name: 'public-plan' }], projectId: f.workspace.id })
  expect(JSON.stringify(listed)).not.toContain('private-plan')
  await makePrivate(first)
  expect(await f.read()).toEqual({ harnesses: [{ harnessId: 'fake' }] })
})
