import { expect, it } from 'vitest'
import { directRouteFor, type AgentRecord } from '../src/index.ts'

const saved = (over: Partial<AgentRecord> = {}): AgentRecord => ({
  id: 'opencode',
  name: 'OpenCode',
  presetId: 'opencode',
  command: 'opencode',
  args: ['acp'],
  env: {},
  enabled: true,
  ...over,
})

it('leaves alone every definition that is not exactly what the preset saved on its adapter', async () => {
  for (const record of [
    saved({ args: ['acp', '--print-logs'] }),
    saved({ args: [] }),
    saved({ command: '/opt/tools/opencode' }),
    saved({ env: { OPENCODE_CONFIG: '/tmp/config.json' } }),
    saved({ routeKept: true }),
    saved({ migratedFrom: { command: 'opencode', args: ['acp'] } }),
    saved({ enabled: false }),
    saved({ presetId: 'codex', command: 'codex', args: [] }),
    saved({ presetId: undefined }),
    saved({ id: 'claude', presetId: 'claude-agent', command: 'claude-agent-acp', args: ['--hide-claude-auth'] }),
  ])
    expect(await directRouteFor(record)).toBeUndefined()
})

it('moves nothing while the program cannot be found or its version cannot be read', async () => {
  // No command search and no permission to run programs are set in this test: the preset's own program is unknown.
  expect(await directRouteFor(saved())).toBeUndefined()
  expect(await directRouteFor(saved({ id: 'claude', presetId: 'claude-agent', command: 'claude-agent-acp', args: [] }))).toBeUndefined()
})
