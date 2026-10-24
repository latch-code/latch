import { describe, expect, it } from 'vitest'
import type { Change } from '../scripts/repository.ts'
import { testProjects, verificationPlan, type TestProject } from '../scripts/verify-plan.ts'

const PROJECTS: TestProject[] = [
  { name: 'harness-link', dir: 'tests' },
  { name: '@latch/host', dir: 'apps/host/test' },
  { name: '@latch/web', dir: 'apps/web/test' },
  { name: '@latch/desktop', dir: 'apps/desktop/test' },
]

const changed = (...paths: string[]): Change[] => paths.map(path => ({ status: 'M', path }))
const commands = (paths: string[]) => verificationPlan(changed(...paths), PROJECTS).run.map(item => item.command)

describe('verification plan', () => {
  it('always lists the quick checks and docs:affected, and nothing else for a documentation change', () => {
    const plan = verificationPlan(
      changed('docs/STREAMING.md', 'apps/web/AGENTS.md', '.agents/skills/latch-verify/SKILL.md'),
      PROJECTS,
      'main',
    )
    expect(plan.run.map(item => item.command)).toEqual(['pnpm check:quick', 'pnpm docs:affected -- --base main'])
    expect(plan.skipped).toContain('pnpm test')
    expect(plan.skipped).toContain('pnpm test:e2e')
    expect(plan.unknown).toEqual([])
  })

  it('runs only the Vitest project of a changed test file', () => {
    expect(commands(['apps/web/test/client-diff.test.ts', 'tests/redact.test.ts'])).toEqual([
      'pnpm check:quick',
      'pnpm knip',
      'pnpm test --project @latch/web --project harness-link',
      'pnpm docs:affected -- --base HEAD',
    ])
  })

  it('runs every unit test, the build with its test-code check and the browser e2e for a Host source change', () => {
    const plan = verificationPlan(changed('apps/host/src/server.ts'), PROJECTS)
    expect(plan.run.map(item => item.command)).toEqual([
      'pnpm check:quick',
      'pnpm knip',
      'pnpm test',
      'pnpm build',
      expect.stringMatching(/^grep -rnE .* dist\/$/u),
      'pnpm test:e2e',
      'pnpm docs:affected -- --base HEAD',
    ])
    expect(plan.run.find(item => item.command === 'pnpm test')?.because).toEqual(['apps/host/src/server.ts'])
  })

  it('adds the Electron suite for the desktop shell, its launcher and the files it relies on, and the layout check for page changes', () => {
    expect(commands(['apps/desktop/src/main.cjs'])).toContain(
      'HARNESS_ELECTRON_E2E=1 pnpm exec vitest run --config e2e/vitest.config.ts e2e/desktop.e2e.ts',
    )
    expect(commands(['apps/host/scripts/desktop-host.ts'])).toContain(
      'HARNESS_ELECTRON_E2E=1 pnpm exec vitest run --config e2e/vitest.config.ts e2e/desktop.e2e.ts',
    )
    expect(commands(['apps/host/src/host-state.ts'])).toContain(
      'HARNESS_ELECTRON_E2E=1 pnpm exec vitest run --config e2e/vitest.config.ts e2e/desktop.e2e.ts',
    )
    expect(commands(['apps/host/src/hub.ts'])).not.toContain(
      'HARNESS_ELECTRON_E2E=1 pnpm exec vitest run --config e2e/vitest.config.ts e2e/desktop.e2e.ts',
    )
    expect(commands(['apps/web/src/components/ToolCard.tsx']).some(command => command.includes('深色模式'))).toBe(true)
    expect(commands(['apps/web/vite.config.ts']).some(command => command.includes('深色模式'))).toBe(false)
    expect(commands(['apps/web/src/core/api.ts']).some(command => command.includes('深色模式'))).toBe(false)
  })

  it('runs every check for dependency files and for paths no rule knows, and names the unknown ones', () => {
    const dependencies = verificationPlan(changed('apps/web/package.json'), PROJECTS)
    expect(dependencies.unknown).toEqual([])
    // The whole set already covers the targeted runs.
    expect(dependencies.skipped).toEqual([
      expect.stringContaining('apps/host/test/crypto.test.ts'),
      expect.stringMatching(/^pnpm build:presence/u),
    ])
    const unknown = verificationPlan(changed('mystery/file.txt'), PROJECTS)
    expect(unknown.unknown).toEqual(['mystery/file.txt'])
    expect(unknown.run.map(item => item.command)).toEqual(
      expect.arrayContaining(['pnpm test', 'pnpm build', 'pnpm test:e2e', 'pnpm check:supply', 'pnpm check:workflows']),
    )
  })

  it('adds the shared-encoding tests and the confirmation helper rebuild only for the files that call for them', () => {
    const encoding = commands(['packages/protocol/src/text.ts'])
    expect(encoding.some(command => command.includes('apps/host/test/crypto.test.ts'))).toBe(true)
    expect(encoding.some(command => command.startsWith('pnpm build:presence'))).toBe(false)
    expect(commands(['native/macos/LatchPresence.swift']).some(command => command.startsWith('pnpm build:presence'))).toBe(true)
    expect(commands(['mystery/file.txt']).some(command => command.includes('apps/host/test/crypto.test.ts'))).toBe(false)
  })

  it('checks a renamed file under both its old and its new path', () => {
    const plan = verificationPlan([{ status: 'R', path: 'apps/host/src/new.ts', from: 'tests/old.test.ts' }], PROJECTS)
    expect(plan.run.find(item => item.command === 'pnpm test')?.because).toEqual(['apps/host/src/new.ts'])
    expect(plan.run[0]?.because).toEqual(['apps/host/src/new.ts', 'tests/old.test.ts'])
  })

  it('reads each Vitest project and the fixed directory of its include patterns from the configuration', () => {
    const config = {
      test: {
        projects: [
          { extends: true, test: { name: 'root', include: ['tests/**/*.test.ts'] } },
          { test: { name: '@latch/x', include: ['apps/x/test/unit/*.test.ts', 'apps/x/test/one.test.ts'] } },
          { test: { include: ['nameless/**'] } },
          'packages/*',
        ],
      },
    }
    expect(testProjects(config)).toEqual([
      { name: 'root', dir: 'tests' },
      { name: '@latch/x', dir: 'apps/x/test/unit' },
      { name: '@latch/x', dir: 'apps/x/test' },
    ])
    expect(testProjects(undefined)).toEqual([])
  })
})
