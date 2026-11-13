import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FAKE_CODEX_APP_SERVER } from '@latch/testkit'
import { codexGatewayEnvironment } from '../src/profiles/codex-environment.ts'
import { CodexWire } from '../src/wires/codex.ts'

describe('Codex gateway command environment', () => {
  const response = (shell_environment_policy: unknown) => ({ config: { shell_environment_policy } })

  it('keeps legacy exclusions and inclusion limits without copying explicit environment values', () => {
    expect(
      codexGatewayEnvironment(
        response({
          inherit: 'core',
          exclude: ['PRIVATE_*', '*TOKEN*'],
          include_only: ['PATH', 'HOME'],
          set: { PRIVATE_VALUE: 'never-projected' },
          ignore_default_excludes: false,
        }),
      ),
    ).toEqual({ exclude: ['PRIVATE_*', '*TOKEN*', 'LMG_TOKEN'], include_only: ['PATH', 'HOME'] })
    expect(codexGatewayEnvironment(response({ filters: null, exclude: null, include_only: null }))).toEqual({ exclude: ['LMG_TOKEN'] })
  })

  it('keeps keyed filters and tightens a case-insensitive explicit token inclusion', () => {
    expect(
      codexGatewayEnvironment(
        response({
          filters: {
            'PRIVATE_*': 'exclude',
            '*': 'include',
            lmg_token: 'include',
          },
        }),
      ),
    ).toEqual({ filters: { 'PRIVATE_*': 'exclude', '*': 'include', LMG_TOKEN: 'exclude' } })
  })

  it.each([
    undefined,
    {},
    { config: {} },
    response(null),
    response({ filters: { SAME: 'include', same: 'exclude' } }),
    response({ filters: { BAD: 'other' } }),
    response({ filters: {}, exclude: [] }),
    response({ filters: {}, include_only: [] }),
    response({ exclude: 'PRIVATE_*' }),
  ])('refuses missing or ambiguous policy %j', value => {
    expect(codexGatewayEnvironment(value)).toBeUndefined()
  })

  it.each([{ exclude: ['PRIVATE_*'], include_only: ['PATH', 'HOME'] }, { filters: { 'PRIVATE_*': 'exclude', '*': 'include' } }])(
    'reads the same directory before both new and resumed threads and keeps its filters %j',
    async original => {
      const cwd = await mkdtemp(join(tmpdir(), 'latch-codex-filters-'))
      const log = join(cwd, 'wire.jsonl')
      const wire = CodexWire.spawn(
        {
          command: process.execPath,
          args: [FAKE_CODEX_APP_SERVER],
          cwd,
          env: { FAKE_ACP_LOG: log, FAKE_CODEX_STATE: join(cwd, 'state.json'), FAKE_CODEX_SHELL_ENVIRONMENT: JSON.stringify(original) },
          maxLineBytes: 1 << 20,
          redact: text => text,
        },
        { request: async () => ({}), notification: () => {}, exit: () => {} },
        { model: 'fake-model', models: ['fake-model'] },
      )
      try {
        await wire.request('initialize', {}, 5_000)
        const opened = (await wire.request('session/new', { cwd }, 5_000)) as { sessionId: string }
        await wire.request('session/resume', { cwd, sessionId: opened.sessionId }, 5_000)
        const events = (await readFile(log, 'utf8'))
          .split('\n')
          .filter(Boolean)
          .map(line => JSON.parse(line) as { event: string; method?: string; params?: Record<string, unknown> })
        const received = events.filter(event => event.event === 'recv')
        const reads = received.filter(event => event.method === 'config/read')
        expect(reads.map(event => event.params)).toEqual([
          { cwd, includeLayers: false },
          { cwd, includeLayers: false },
        ])
        const requests = received.filter(event => event.method === 'thread/start' || event.method === 'thread/resume')
        expect(requests).toHaveLength(2)
        for (const request of requests) {
          expect(received.indexOf(request)).toBeGreaterThan(received.indexOf(reads[requests.indexOf(request)]!))
          expect(request.params).toMatchObject({ config: { shell_environment_policy: codexGatewayEnvironment(response(original)) } })
        }
      } finally {
        await wire.stop('stop', 100)
        await rm(cwd, { recursive: true, force: true })
      }
    },
  )

  it('opens no thread when the effective filters are malformed', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'latch-codex-bad-filters-'))
    const log = join(cwd, 'wire.jsonl')
    const wire = CodexWire.spawn(
      {
        command: process.execPath,
        args: [FAKE_CODEX_APP_SERVER],
        cwd,
        env: { FAKE_ACP_LOG: log, FAKE_CODEX_SHELL_ENVIRONMENT: JSON.stringify({ filters: 'invalid' }) },
        maxLineBytes: 1 << 20,
        redact: text => text,
      },
      { request: async () => ({}), notification: () => {}, exit: () => {} },
      { model: 'fake-model', models: ['fake-model'] },
    )
    try {
      await wire.request('initialize', {}, 5_000)
      await expect(wire.request('session/new', { cwd }, 5_000)).rejects.toThrow('无法读取 Codex 的命令环境规则')
      expect(await readFile(log, 'utf8')).not.toContain('"method":"thread/start"')
    } finally {
      await wire.stop('stop', 100)
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
