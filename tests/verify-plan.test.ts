import { readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Change } from '../scripts/repository.ts'
import { FLOW_E2E, testProjects, verificationPlan, type TestProject } from '../scripts/verify-plan.ts'

const PROJECTS: TestProject[] = [
  { name: 'latch', dir: 'tests' },
  { name: '@latch/host', dir: 'apps/host/test' },
  { name: '@latch/web', dir: 'apps/web/test' },
  { name: '@latch/desktop', dir: 'apps/desktop/test' },
]
const E2E = [
  'board.e2e.ts',
  'board-items.e2e.ts',
  'design.e2e.ts',
  'desktop.e2e.ts',
  'desktop-notifications.e2e.ts',
  'enrollment.e2e.ts',
  'notifications.e2e.ts',
  'questions.e2e.ts',
  'questions-harnesses.e2e.ts',
  'settings.e2e.ts',
  'settings-pages.e2e.ts',
  'visual.e2e.ts',
]
const E2E_RUN = 'pnpm exec vitest run --config e2e/vitest.config.ts'
const COPY =
  'pnpm exec vitest run --config vitest.config.ts tests/glossary.test.ts tests/i18n-coverage.test.ts tests/error-copy-coverage.test.ts'

const changed = (...paths: string[]): Change[] => paths.map(path => ({ status: 'M', path }))
const commands = (paths: string[]) => verificationPlan(changed(...paths), PROJECTS, { e2e: E2E }).run.map(item => item.command)

describe('verification plan', () => {
  it('always lists the quick checks and docs:affected, and nothing else for a documentation change', () => {
    const plan = verificationPlan(changed('docs/STREAMING.md', 'apps/web/AGENTS.md', '.agents/skills/latch-verify/SKILL.md'), PROJECTS, {
      base: 'main',
      e2e: E2E,
    })
    expect(plan.run.map(item => item.command)).toEqual(['pnpm check:quick', 'pnpm docs:affected -- --base main'])
    expect(plan.skipped).toContain('pnpm test')
    expect(plan.skipped).toContain('pnpm test:e2e')
    expect(plan.unknown).toEqual([])
  })

  it('captures every surface again for the design system and its gallery, but not for the other design system tests', () => {
    const projects = [...PROJECTS, { name: '@latch/ui', dir: 'packages/ui/test' }]
    const plan = (path: string) => verificationPlan(changed(path), projects, { e2e: E2E }).run.map(item => item.command)
    expect(plan('packages/ui/test/gallery/Gallery.tsx')).toEqual([
      'pnpm check:quick',
      'pnpm knip',
      'pnpm test --project @latch/ui --project @latch/ui-touch',
      'pnpm build',
      expect.stringMatching(/^grep -rnE .* dist\/$/u),
      `${E2E_RUN} e2e/design.e2e.ts e2e/visual.e2e.ts`,
      expect.stringContaining('深色模式'),
      'pnpm docs:affected -- --base HEAD',
    ])
    expect(plan('packages/ui/test/button.test.tsx')).toEqual([
      'pnpm check:quick',
      'pnpm knip',
      'pnpm test --project @latch/ui',
      'pnpm docs:affected -- --base HEAD',
    ])
  })

  it('runs only the website test for the website, with a look at its pages for a page change', () => {
    const projects = [...PROJECTS, { name: '@latch/site', dir: 'apps/site/test' }]
    const plan = (path: string) => verificationPlan(changed(path), projects, { e2e: E2E })
    expect(plan('apps/site/scripts/seo-check.ts').run.map(item => item.command)).toEqual([
      'pnpm check:quick',
      'pnpm knip',
      'pnpm test --project @latch/site',
      'pnpm docs:affected -- --base HEAD',
    ])
    const page = plan('apps/site/src/components/Home.astro')
    expect(page.unknown).toEqual([])
    expect(page.run.map(item => item.command)).toEqual([
      'pnpm check:quick',
      'pnpm knip',
      'pnpm test --project @latch/site',
      expect.stringContaining('深色模式'),
      'pnpm docs:affected -- --base HEAD',
    ])
  })

  it('runs only the Vitest project of a changed test file', () => {
    expect(commands(['apps/web/test/client-diff.test.ts', 'tests/redact.test.ts'])).toEqual([
      'pnpm check:quick',
      'pnpm knip',
      'pnpm test --project @latch/web --project latch',
      'pnpm docs:affected -- --base HEAD',
    ])
  })

  it('runs the projects that run a source file, the copy scans and the e2e named after it, and leaves the whole e2e suite for --full', () => {
    const plan = verificationPlan(changed('apps/host/src/questions.ts'), PROJECTS, { e2e: E2E })
    expect(plan.run.map(item => item.command)).toEqual([
      'pnpm check:quick',
      'pnpm knip',
      'pnpm test --project @latch/host',
      COPY,
      'pnpm build',
      expect.stringMatching(/^grep -rnE .* dist\/$/u),
      `${E2E_RUN} e2e/questions-harnesses.e2e.ts e2e/questions.e2e.ts`,
      'pnpm docs:affected -- --base HEAD',
    ])
    expect(plan.skipped).toContain('pnpm test:e2e')
    expect(plan.skipped).toContain('pnpm test')

    // A file named after no e2e runs none, and no build.
    expect(commands(['apps/web/src/components/ToolCard.tsx'])).toEqual([
      'pnpm check:quick',
      'pnpm knip',
      'pnpm test --project @latch/web',
      COPY,
      expect.stringContaining('深色模式'),
      'pnpm docs:affected -- --base HEAD',
    ])
    // Directory names count, in either number; a page's settings match the settings e2e files only.
    expect(commands(['apps/web/src/settings/LocalNetworkHint.tsx'])).toContain(`${E2E_RUN} e2e/settings-pages.e2e.ts e2e/settings.e2e.ts`)
    expect(commands(['apps/web/src/board/ItemCard.tsx'])).toContain(`${E2E_RUN} e2e/board-items.e2e.ts e2e/board.e2e.ts`)
    // The desktop shell's files match the desktop-* files, and other files never do.
    expect(commands(['apps/desktop/src/notifications.cjs'])).toContain(`LATCH_ELECTRON_E2E=1 ${E2E_RUN} e2e/desktop-notifications.e2e.ts`)
    expect(commands(['apps/web/src/notifications.ts'])).toContain(`${E2E_RUN} e2e/notifications.e2e.ts`)
    // Flows run their e2e whatever the file is called.
    expect(commands(['apps/web/src/core/credentials.ts'])).toContain(`${E2E_RUN} e2e/enrollment.e2e.ts`)
    // A package runs the projects that depend on it; one that the root project covers needs no separate copy scans.
    expect(commands(['packages/core/src/registry.ts'])).toEqual([
      'pnpm check:quick',
      'pnpm knip',
      'pnpm test --project @latch/harness-acp --project @latch/host --project latch',
      'pnpm docs:affected -- --base HEAD',
    ])
  })

  it('lists the whole set with --full, even with nothing changed', () => {
    const full = verificationPlan(changed('apps/host/src/questions.ts'), PROJECTS, { full: true, e2e: E2E }).run.map(item => item.command)
    expect(full).toEqual(
      expect.arrayContaining(['pnpm knip', 'pnpm test', 'pnpm build', 'pnpm test:e2e', 'pnpm check:supply', 'pnpm check:workflows']),
    )
    expect(full.some(command => command.startsWith(E2E_RUN))).toBe(false)
    expect(full).not.toContain(COPY)
    const empty = verificationPlan([], PROJECTS, { full: true })
    expect(empty.run.find(item => item.command === 'pnpm test:e2e')?.because).toEqual(['--full'])
  })

  it('names only e2e files that exist for the flows it knows', () => {
    const files = new Set(readdirSync(new URL('../e2e/', import.meta.url)))
    expect(FLOW_E2E.flatMap(([, list]) => list).filter(file => !files.has(file))).toEqual([])
  })

  it('adds the Electron suite for the desktop shell, its launcher and the files it relies on, and the layout check for page changes', () => {
    expect(commands(['apps/desktop/src/main.cjs'])).toContain(
      'LATCH_ELECTRON_E2E=1 pnpm exec vitest run --config e2e/vitest.config.ts e2e/desktop.e2e.ts',
    )
    expect(commands(['apps/host/scripts/desktop-host.ts'])).toContain(
      'LATCH_ELECTRON_E2E=1 pnpm exec vitest run --config e2e/vitest.config.ts e2e/desktop.e2e.ts',
    )
    expect(commands(['apps/host/src/host-state.ts'])).toContain(
      'LATCH_ELECTRON_E2E=1 pnpm exec vitest run --config e2e/vitest.config.ts e2e/desktop.e2e.ts',
    )
    expect(commands(['apps/host/src/hub.ts'])).not.toContain(
      'LATCH_ELECTRON_E2E=1 pnpm exec vitest run --config e2e/vitest.config.ts e2e/desktop.e2e.ts',
    )
    expect(commands(['apps/web/src/components/ToolCard.tsx']).some(command => command.includes('深色模式'))).toBe(true)
    expect(commands(['packages/ui/src/tokens.css'])).toEqual([
      'pnpm check:quick',
      'pnpm knip',
      'pnpm test --project @latch/ui --project @latch/ui-touch --project @latch/web',
      COPY,
      'pnpm build',
      expect.stringMatching(/^grep -rnE .* dist\/$/u),
      `${E2E_RUN} e2e/design.e2e.ts e2e/visual.e2e.ts`,
      expect.stringContaining('深色模式'),
      'pnpm docs:affected -- --base HEAD',
    ])
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
    expect(commands(['apps/host/test/native-swift.test.ts'])).toContain('pnpm test --project @latch/host-swift')
    expect(commands(['mystery/file.txt']).some(command => command.includes('apps/host/test/crypto.test.ts'))).toBe(false)
  })

  it('checks a renamed file under both its old and its new path', () => {
    const plan = verificationPlan([{ status: 'R', path: 'apps/host/src/new.ts', from: 'tests/old.test.ts' }], PROJECTS)
    expect(plan.run.find(item => item.command.startsWith('pnpm test '))?.because).toEqual(['apps/host/src/new.ts', 'tests/old.test.ts'])
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
          {
            test: {
              name: '@latch/y',
              include: ['packages/y/test/**/*.test.tsx'],
              browser: { instances: [{ name: '@latch/y' }, { name: '@latch/y-touch', include: ['packages/y/test/touch.test.tsx'] }] },
            },
          },
        ],
      },
    }
    expect(testProjects(config)).toEqual([
      { name: 'root', dir: 'tests' },
      { name: '@latch/x', dir: 'apps/x/test/unit' },
      { name: '@latch/x', dir: 'apps/x/test' },
      // A browser project's instances run as projects of their own names.
      { name: '@latch/y', dir: 'packages/y/test' },
      { name: '@latch/y-touch', dir: 'packages/y/test' },
    ])
    expect(testProjects(undefined)).toEqual([])
  })
})
