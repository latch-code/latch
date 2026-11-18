import { expect, it } from 'vitest'
import { MAX_HARNESS_PLUGINS, readHarnessPluginReport } from '@latch/protocol'
import { piPlugins } from '../src/wires/pi-plugins.ts'

const noSecrets = (text: string) => text

const extension = (path: unknown, source: object = {}) => ({
  name: 'check',
  source: 'extension',
  sourceInfo: { origin: 'top-level', source: 'auto', path, ...source },
})

it('groups pi resources by their package and extension directory and keeps standalone names', () => {
  const gate = '/private/runtime/latch-permission.ts'
  const baseDir = '/private/pkg/review-tools'
  const workspace = '/private/work/.pi'
  const commands = [
    extension(gate, { source: 'cli' }),
    extension('builtin:example', { source: 'builtin' }),
    extension(`${baseDir}/checks/index.ts`, { baseDir, origin: 'package', source: 'npm:hidden-source' }),
    extension(`${baseDir}/file.ts`, { baseDir, origin: 'package' }),
    extension(`${workspace}/extensions/project-tools/lib/check.ts`, { baseDir: workspace }),
    extension(`${workspace}/extensions/project-tools/lib/preview.ts`, { baseDir: workspace }),
    extension(`${workspace}/extensions/standalone.ts`, { baseDir: workspace }),
    extension('C:\\Users\\Operator\\extensions\\windows-tools\\index.ts'),
    { source: 'prompt', sourceInfo: { path: '/private/other-prompt.md' } },
    { source: 'skill', sourceInfo: { path: '/private/another-skill/SKILL.md' } },
  ]
  expect(piPlugins(commands, gate, noSecrets)).toEqual({ names: ['review-tools', 'project-tools', 'standalone', 'windows-tools'] })
  expect(piPlugins([commands[0]], gate, noSecrets)).toEqual({ names: [] })
})

it('omits pi labels that are ambiguous, unsupported, or contain a known secret', () => {
  const known = 'materialized-key-for-fixture'
  const redact = (value: string) => value.replace(known, '[redacted]')
  const commands = [
    extension('/private/a/extensions/checks/index.ts'),
    extension('/private/b/extensions/checks/index.ts'),
    extension('/private/b/extensions/checks/index.ts'),
    extension('/private/b/extensions/audit/index.ts'),
    extension('/index.ts'),
    extension('/private/../unsafe/index.ts'),
    extension(`/private/${known}/index.ts`),
    extension('relative/file.ts'),
    extension('/private/other/index.ts', { origin: 'package', baseDir: '/private/unrelated' }),
    extension('/private/code/index.ts', { origin: 'package' }),
    extension(null),
    { source: 'extension', name: 'unknown-source' },
  ]
  expect(piPlugins(commands, undefined, redact)).toEqual({ names: ['audit'], truncated: true })
})

it('bounds the pi inventory and revalidates the public shape', () => {
  const names = Array.from({ length: MAX_HARNESS_PLUGINS + 1 }, (_, index) => `plugin-${index}`)
  expect(
    piPlugins(
      names.map(name => extension(`/private/extensions/${name}.ts`)),
      undefined,
      noSecrets,
    ),
  ).toEqual({
    names: names.slice(0, -1),
    truncated: true,
  })
  expect(readHarnessPluginReport({ names: ['lint'], privatePath: '/private/pi' })).toEqual({ names: ['lint'] })
  expect(readHarnessPluginReport({ names: ['/private/pi'] })).toBeUndefined()
})
