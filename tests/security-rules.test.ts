import { describe, expect, it } from 'vitest'
import { coChangeReminders, scanAddedLines } from '../scripts/security-rules.ts'

const credential = `ldc1.dev_${'A'.repeat(22)}.${'b'.repeat(43)}`
const scan = (files: Record<string, string[]>) => scanAddedLines(new Map(Object.entries(files)))

describe('security scan', () => {
  it('finds credential and key shapes in added lines and shows them redacted', () => {
    const findings = scan({
      'apps/host/src/server.ts': [`log('${credential}')`, 'const ok = 1'],
      'README.md': ['key: sk-ant-abcdefghijklmnopqrstuvwxyz0123'],
      'pnpm-lock.yaml': [`integrity: ${credential}`],
    })
    expect(findings.map(finding => [finding.path, finding.rule, finding.line, finding.inTest])).toEqual([
      ['apps/host/src/server.ts', 'secret-shape', "log('[redacted]')", false],
      ['README.md', 'secret-shape', 'key: [redacted]', false],
    ])
  })

  it('lists matches in test code as test findings, which do not fail the scan', () => {
    const findings = scan({
      'tests/redact.test.ts': [`'${credential}'`],
      'apps/web/test/x.test.ts': ['new EventSource(url)'],
      'packages/testkit/src/host.ts': ['invite lpi1-ABCDEFGHIJKLMNOPQRSTUVWXYZ'],
    })
    expect(findings.map(finding => [finding.path, finding.inTest])).toEqual([
      ['packages/testkit/src/host.ts', true],
      ['tests/redact.test.ts', true],
    ])
  })

  it('applies each API rule only to the paths it covers', () => {
    const findings = scan({
      'apps/web/src/core/api.ts': ['const source = new EventSource(url)', 'el.innerHTML = text'],
      'apps/host/src/listeners.ts': ["const ip = request.headers['x-forwarded-for']", 'const source = new EventSource(url)'],
      'apps/host/src/plugins/providers/demo/index.ts': ["import { request } from 'node:https'"],
      'apps/host/src/server.ts': ["import { request } from 'node:https'", 'return new Function(code)'],
      'apps/desktop/src/main.cjs': ['webPreferences: { contextIsolation: false }', 'win.loadURL(target)'],
      'packages/harness-acp/src/connection.ts': ['spawn(command, { env: { ...process.env } })'],
      'scripts/tool.ts': ['eval(code)'],
    })
    expect(findings.map(finding => `${finding.path} ${finding.rule}`)).toEqual([
      'apps/desktop/src/main.cjs electron-isolation',
      'apps/desktop/src/main.cjs electron-navigation',
      'apps/host/src/listeners.ts proxy-header',
      'apps/host/src/plugins/providers/demo/index.ts plugin-network',
      'apps/host/src/server.ts dynamic-code',
      'apps/web/src/core/api.ts event-source',
      'apps/web/src/core/api.ts html-injection',
      'packages/harness-acp/src/connection.ts agent-environment',
    ])
  })

  it('flags a node entry in package.json that does not disable SIGUSR1', () => {
    const findings = scan({
      'package.json': [
        '"serve": "node --import tsx apps/host/scripts/start.ts",',
        '"start": "node --disable-sigusr1 dist/start.js",',
        '"build": "tsx build.ts",',
      ],
    })
    expect(findings.map(finding => finding.line)).toEqual(['"serve": "node --import tsx apps/host/scripts/start.ts",'])
  })

  it('reminds about files that change together, profile versions and the confirmation helper signature', () => {
    const reminders = coChangeReminders([
      'apps/host/src/host-state.ts',
      'e2e/helpers/host.ts',
      'apps/host/test/helpers/host.ts',
      'apps/desktop/test/helpers/host.ts',
      'packages/harness-acp/src/profiles/codex.ts',
      'native/macos/LatchPresence.swift',
    ])
    expect(reminders.map(reminder => [reminder.changed, reminder.unchanged])).toEqual([
      [
        ['native/macos/LatchPresence.swift'],
        [
          'packages/testkit/vectors/security-v1.json',
          'apps/host/src/crypto.ts',
          'apps/host/src/auth.ts',
          'apps/host/src/presence.ts',
          'packages/core/src/node-kit/digest.ts',
          'packages/protocol/src/text.ts',
          'apps/web/src/core/deviceKey.ts',
          'apps/web/src/core/contentHash.ts',
          'apps/desktop/src/credentials.cjs',
        ],
      ],
      [['apps/host/src/host-state.ts'], ['apps/desktop/src/host.cjs']],
      [['packages/harness-acp/src/profiles/codex.ts'], []],
      [['native/macos/LatchPresence.swift'], []],
    ])
  })
})
