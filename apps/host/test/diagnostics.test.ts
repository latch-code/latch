import { randomUUID } from 'node:crypto'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { describe, expect, it } from 'vitest'
import type { HarnessInfo, PluginInfo } from '@latch/protocol'
import { DiagnosticLog, diagnosticText, diagnosticsBundle } from '../src/diagnostics.ts'
import { defaultPolicy } from '../src/policy.ts'
import { startTestHost } from './helpers/host.ts'

const HOME = '/Users/alice'
/** One of each secret shape `redactSecrets` knows, as text that might reach a log line or a status message. */
const SECRETS = [
  `lnw1.${'A'.repeat(43)}`,
  `ldc1.dev_${'B'.repeat(22)}.${'C'.repeat(43)}`,
  `lmg1.${'D'.repeat(43)}`,
  'lpi1-ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  `LATCHPAIR2.${'E'.repeat(40)}`,
  `sk-ant-${'F'.repeat(30)}`,
  `sk-proj-${'G'.repeat(30)}`,
  `ghp_${'H'.repeat(36)}`,
  'AKIAABCDEFGHIJKLMNOP',
  `xoxb-${'1'.repeat(12)}`,
  `AIza${'I'.repeat(35)}`,
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'Latch-Device opaque-device-value',
  'https://user:hunter2@example.com/path',
  'https://example.com/?token=abc123def',
]
const PRIVATE = ['Alice 的 MacBook', '季度复盘', 'alpha-project']
const leaky = (label: string) => `${label} ${SECRETS.join(' ')} ${PRIVATE.join(' ')} ${HOME}/code/app/main.ts /Users/bob/notes.txt`

function harness(id: string): HarnessInfo {
  return {
    id,
    status: 'unavailable',
    statusMessage: leaky('启动失败'),
    level: 'L1',
    modes: ['agent'],
  } as unknown as HarnessInfo
}

function assertClean(text: string) {
  for (const secret of SECRETS) expect(text, secret).not.toContain(secret)
  for (const word of PRIVATE) expect(text, word).not.toContain(word)
  expect(text).not.toContain(HOME)
  expect(text).not.toContain('/Users/bob')
  expect(text).not.toContain('hunter2')
}

describe('诊断导出', () => {
  it('keeps no secret, private word or path in any field, and only the first line of a status', () => {
    const log = new DiagnosticLog(() => 0)
    for (let index = 0; index < 5; index++)
      log.note('harness-load-failed', { id: 'codex', error: Object.assign(new Error(leaky('m')), { code: 'ENOENT' }) })
    // An ID or code that is not shaped like one is dropped, never kept as text.
    log.note('provider-load-failed', { id: leaky('请帮我总结季度复盘'), error: { code: SECRETS[5] } })
    const bundle = diagnosticsBundle({
      version: '0.1.0',
      startedAt: '2026-11-13T00:00:00.000Z',
      now: () => 0,
      home: HOME,
      harnesses: [{ ...harness(leaky('h')), statusMessage: `启动失败 /private/var/folders/x/run.sock\n请帮我总结季度复盘 ${SECRETS[0]}` }],
      plugins: [{ id: leaky('p'), name: leaky('n'), version: leaky('v'), enabled: true, activeRuns: 0 } as unknown as PluginInfo],
      policy: {
        ...defaultPolicy('darwin'),
        hostEgressAllow: ['secret-host.internal:443'],
        confirmedAddresses: ['https://models.example.com/v1'],
      },
      devices: { active: 2, revoked: 1 },
      streams: { unix: 1 },
      log,
      private: PRIVATE,
    })
    const text = JSON.stringify(bundle)
    assertClean(text)
    expect(text).not.toContain('secret-host.internal')
    expect(text).not.toContain('models.example.com')
    expect(text).not.toContain('请帮我总结')
    expect(text).not.toContain('/private/var')
    expect(bundle.harnesses[0]!.message).toBe('启动失败 ‹路径›')
    expect(bundle.policy).toMatchObject({ egressAllowCount: 1, confirmedAddressCount: 1, presenceBackend: 'macos-helper' })
    expect(bundle.events).toHaveLength(6)
    expect(bundle.events[0]).toEqual({ at: '1970-01-01T00:00:00.000Z', category: 'harness-load-failed', id: 'codex', code: 'ENOENT' })
    expect(bundle.events[5]).toEqual({ at: '1970-01-01T00:00:00.000Z', category: 'provider-load-failed' })
    // Only the listed fields leave: no plugin name or description, no device names, no transcript.
    expect(Object.keys(bundle).sort()).toEqual([
      'connections',
      'createdAt',
      'errors',
      'events',
      'format',
      'harnesses',
      'host',
      'plugins',
      'policy',
      'version',
    ])
    expect(Object.keys(bundle.plugins[0]!).sort()).toEqual(['activeRuns', 'enabled', 'id', 'version'])
  })

  it('names a Harness the person defined by its place and preset, never by the ID or name they gave it', () => {
    const log = new DiagnosticLog(() => 0)
    log.note('agent-load-failed', { id: 'acme-payroll' })
    const defined = (id: string, label: string, mark?: string) =>
      ({
        id,
        editable: true,
        status: 'unavailable',
        statusMessage: `${label} 启动失败：进程退出（退出码 1）`,
        level: 'L3',
        modes: ['agent'],
        capabilities: { display: { label, ...(mark ? { mark } : {}) } },
      }) as unknown as HarnessInfo
    const bundle = diagnosticsBundle({
      version: '0.1.0',
      startedAt: '2026-11-13T00:00:00.000Z',
      now: () => 0,
      home: HOME,
      harnesses: [
        { ...harness('standard'), status: 'ready', statusMessage: undefined } as unknown as HarnessInfo,
        defined('acme-payroll', 'Acme 工资系统', 'codex'),
        defined('dsh', 'DeepSeek Harness', 'dsh'),
      ],
      plugins: [{ id: 'agent-acme-payroll', version: '1', enabled: true, activeRuns: 0 } as unknown as PluginInfo],
      policy: defaultPolicy('darwin'),
      devices: { active: 1, revoked: 0 },
      streams: {},
      log,
    })
    const text = JSON.stringify(bundle)
    expect(text).not.toContain('acme')
    expect(text).not.toContain('Acme')
    expect(bundle.harnesses.map(item => [item.id, item.preset])).toEqual([
      ['standard', undefined],
      ['harness-1', 'codex'],
      ['harness-2', 'dsh'],
    ])
    // A preset's own name is no secret and stays readable.
    expect(bundle.harnesses[2]!.message).toBe('DeepSeek Harness 启动失败：进程退出（退出码 1）')
    expect(bundle.plugins[0]!.id).toBe('agent-harness-1')
    expect(bundle.events[0]).toMatchObject({ category: 'agent-load-failed', id: 'harness-1' })
  })

  it('labels every saved definition, a turned-off or unloaded one too, in its events', () => {
    const log = new DiagnosticLog(() => 0)
    log.note('agent-load-failed', { id: 'payroll-off' })
    log.note('plugin-cleanup-failed', { id: 'acme-payroll' })
    const bundle = diagnosticsBundle({
      version: '0.1.0',
      startedAt: '2026-11-13T00:00:00.000Z',
      now: () => 0,
      home: HOME,
      // Only the built-in one is mounted; neither definition is.
      harnesses: [{ ...harness('standard'), status: 'ready', statusMessage: undefined } as unknown as HarnessInfo],
      definitions: [
        { id: 'acme-payroll', name: 'Acme 工资系统', presetId: 'codex' },
        { id: 'payroll-off', name: '关掉的', presetId: 'dsh' },
      ],
      plugins: [],
      policy: defaultPolicy('darwin'),
      devices: { active: 1, revoked: 0 },
      streams: {},
      log,
    })
    expect(JSON.stringify(bundle)).not.toMatch(/acme|payroll|Acme|关掉的/u)
    expect(bundle.events.map(event => [event.category, event.id])).toEqual([
      ['agent-load-failed', 'harness-2'],
      ['plugin-cleanup-failed', 'harness-1'],
    ])
  })

  it("writes the home folder as ~, another user's as ~other and any other absolute path as a placeholder", () => {
    expect(diagnosticText(`${HOME}/a ${HOME} ${HOME}2/b /tmp/x.sock https://example.com/a/b`, HOME)).toBe(
      '~/a ~ ~other/b ‹路径› https://example.com/a/b',
    )
  })

  it('keeps a bounded tail of events, failures apart, and nothing outside its categories', () => {
    const log = new DiagnosticLog(() => 0)
    for (let index = 0; index < 1000; index++) log.note(index === 10 ? 'request-failed' : 'project-unavailable', { id: `p${index}` })
    log.note('agent stderr: 请帮我' as never)
    const { events, errors } = log.recent()
    expect(events).toHaveLength(400)
    expect(events.at(-1)!.id).toBe('p999')
    expect(errors.map(event => event.id)).toEqual(['p10'])
  })

  it('answers only this computer, audits counts, and keeps device names and folders out', async () => {
    const t = await startTestHost()
    try {
      const desktop = await t.enroll({ listener: 'unix', name: 'Alice 的 MacBook' })
      const response = await desktop.request('diagnostics', { method: 'POST', body: {} })
      expect(response.status).toBe(200)
      const text = await response.text()
      expect(JSON.parse(text)).toMatchObject({ format: 'latch-diagnostics', version: 1, connections: { devices: { active: 1 } } })
      expect(text).not.toContain('Alice 的 MacBook')
      expect(text).not.toContain(t.workspaceRoot)
      expect(text).not.toContain(t.dataDir)
      const record = t.host.security.audit.lastOf('diagnostics.exported')
      expect(record).toMatchObject({ actor: { deviceId: desktop.id, listener: 'unix' } })
      expect(Object.keys(record!.detail as object).sort()).toEqual(['errors', 'harnesses', 'logLines', 'plugins'])
      // The command line on host.sock, without a device.
      expect((await t.raw('unix', 'api/diagnostics', { method: 'POST', body: {} })).status).toBe(200)
      // A browser, even an admin one on loopback, is another device: refused, and nothing is recorded.
      const before = t.host.security.audit.head().seq
      const browser = await t.enroll({ name: '浏览器', scopes: ['view', 'run', 'approve:standard', 'admin'] })
      const remote = await browser.request('diagnostics', { method: 'POST', body: {} })
      expect(remote.status).toBe(403)
      expect(await remote.json()).toMatchObject({ error: 'local-only' })
      const viewer = await t.enroll({ listener: 'unix', name: '只看', scopes: ['view'] })
      expect((await viewer.request('diagnostics', { method: 'POST', body: {} })).status).toBe(403)
      expect(t.host.security.audit.lastOf('diagnostics.exported')?.seq).toBeLessThan(before + 1)
    } finally {
      await t.close()
    }
  })
})

describe('诊断导出 from a real Host', () => {
  it('never carries an agent stderr tail, its text or the outbound allow-list', async () => {
    const lines: string[] = []
    const t = await startTestHost({ egressAllow: ['secret-host.internal:443'], log: text => lines.push(text) })
    try {
      const desktop = await t.enroll({ listener: 'unix' })
      await desktop.confirmedJson('agents', {
        body: {
          id: 'leaky-agent',
          name: 'Leaky Agent',
          command: process.execPath,
          args: [FAKE_ACP_AGENT],
          env: {
            FAKE_ACP_INIT_ERROR: '1',
            FAKE_ACP_INIT_DIAGNOSTIC: '请帮我总结季度复盘的机密内容',
            FAKE_SECRET: `sk-ant-${'Q'.repeat(30)}`,
          },
        },
      })
      await desktop.confirmed('tasks', { body: { prompt: '你好', requestId: randomUUID(), harnessId: 'leaky-agent' } })
      // The Host did log the agent's stderr tail and the allow-list: the export must not carry them.
      await expect.poll(() => lines.join('\n'), { timeout: 30_000 }).toContain('startup diagnostics')
      expect(lines.join('\n')).toContain('secret-host.internal')
      const text = await (await desktop.request('diagnostics', { method: 'POST', body: {} })).text()
      expect(text).toContain('latch-diagnostics')
      expect(text).not.toContain('请帮我总结')
      expect(text).not.toContain('QQQQQQQQ')
      expect(text).not.toContain('secret-host.internal')
      expect(text).not.toContain('startup diagnostics')
      expect(text).not.toContain('stderr')
    } finally {
      await t.close()
    }
  }, 60_000)
})
