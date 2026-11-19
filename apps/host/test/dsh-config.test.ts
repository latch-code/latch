// What DeepSeek Harness's own `--dump-config` says of its profile (src/dsh-config.ts). The dumps here have the shape
// 0.2.2-rc.1 prints in a throwaway home; the live case runs the real program in one, with no prompt and no session.
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DSH_KEY_PLUGINS } from '../src/cli-quota.ts'
import { DSH_STORE_PLUGINS } from '../src/cli-usage.ts'
import { dshConfigCheck, judgeDshDump } from '../src/dsh-config.ts'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function temp(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}

/** An untouched `acp` profile's composition, cut to the entries that matter here. */
const OFFICIAL = `# == @deepseek-ai/dsh-base
- id: timer
  name: '@deepseek-ai/cordis-plugin-timer'
# == @deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-acp-app
- id: hmr
  name: '@deepseek-ai/dsh-hmr'
  disabled: true
# == @deepseek-ai/dsh-base
- id: deepseek-account
  name: '@deepseek-ai/dsh-deepseek-account'
- id: credentials
  name: '@deepseek-ai/dsh-credentials-local'
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
- id: session-persistence-jsonl
  name: '@deepseek-ai/dsh-session-persistence-jsonl'
  config:
    root: !!js 'ctx.dshHome("sessions")'
# == @deepseek-ai/dsh-acp-app
- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek-api-key'
`

describe("DeepSeek Harness's composition of its profile", () => {
  it('is official when every entry comes from its own bundles and only they patched the plugins asked about', () => {
    expect(judgeDshDump(OFFICIAL, DSH_KEY_PLUGINS)).toBe('official')
    expect(judgeDshDump(OFFICIAL, DSH_STORE_PLUGINS)).toBe('official')
  })

  it("is changed when a person's layer patched a plugin asked about, and only then", () => {
    const patched = OFFICIAL.replace(
      '# == @deepseek-ai/dsh-acp-app\n- id: llm-deepseek',
      '# == @deepseek-ai/dsh-acp-app, patched by /Users/someone/.dsh/profiles/acp/cordis.patch.yml\n- id: llm-deepseek',
    )
    expect(judgeDshDump(patched, DSH_KEY_PLUGINS)).toBe('changed')
    // The session store is another plugin: that patch says nothing about it.
    expect(judgeDshDump(patched, DSH_STORE_PLUGINS)).toBe('official')
    // A `--patch` file, or several layers at once, read the same way.
    const store = OFFICIAL.replace(
      "- id: llm-pi-ai\n  name: '@deepseek-ai/dsh-llm-pi-ai'\n",
      "- id: llm-pi-ai\n  name: '@deepseek-ai/dsh-llm-pi-ai'\n# == @deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-acp-app, /tmp/extra.json\n",
    )
    expect(judgeDshDump(store, DSH_STORE_PLUGINS)).toBe('changed')
    // A person's layer that changed another plugin leaves these alone.
    const other = OFFICIAL.replace(
      '# == @deepseek-ai/dsh-base\n- id: timer',
      '# == @deepseek-ai/dsh-base, patched by /Users/someone/.dsh/cordis.patch.yml\n- id: timer',
    )
    expect(judgeDshDump(other, DSH_KEY_PLUGINS)).toBe('official')
  })

  it('is changed when a plugin comes from anything but its own bundles, or one asked about is missing', () => {
    expect(judgeDshDump(`${OFFICIAL}# == some-bundle\n- id: interceptor\n  name: some-plugin\n`, DSH_KEY_PLUGINS)).toBe('changed')
    expect(judgeDshDump(`${OFFICIAL}# == /Users/someone/.dsh/cordis.patch.yml\n- id: mine\n`, DSH_STORE_PLUGINS)).toBe('changed')
    expect(judgeDshDump(OFFICIAL.replace('- id: credentials', '- id: credentials-elsewhere'), DSH_KEY_PLUGINS)).toBe('changed')
    expect(judgeDshDump(`- id: llm-deepseek\n${OFFICIAL}`, DSH_KEY_PLUGINS)).toBe('changed')
    expect(judgeDshDump('', DSH_STORE_PLUGINS)).toBe('changed')
  })

  it('asks the program once while its inputs stay as they were, and judges a failed or silent run as changed', async () => {
    const root = await temp('latch-dsh-config-')
    const home = join(root, 'home')
    await mkdir(join(home, '.dsh', 'profiles', 'acp'), { recursive: true })
    const runs = join(root, 'runs')
    const program = join(root, 'dsh')
    await writeFile(program, `#!/bin/sh\necho run >> '${runs}'\ncat <<'EOF'\n${OFFICIAL}EOF\n`, { mode: 0o755 })
    const path = () => process.env.PATH
    const check = dshConfigCheck({ home, path })
    expect(await check(program, DSH_KEY_PLUGINS)).toBe('official')
    expect(await check(program, DSH_KEY_PLUGINS)).toBe('official')
    const count = async () => (await readFile(runs, 'utf8')).split('\n').filter(Boolean).length
    expect(await count()).toBe(1)
    // The person changes their layer: asked again.
    await writeFile(join(home, '.dsh', 'profiles', 'acp', 'cordis.patch.yml'), '[]\n')
    expect(await check(program, DSH_KEY_PLUGINS)).toBe('official')
    expect(await count()).toBe(2)

    const failing = join(root, 'dsh-failing')
    await writeFile(failing, `#!/bin/sh\necho 'dsh: failed to parse overlay' >&2\nexit 1\n`, { mode: 0o755 })
    expect(await dshConfigCheck({ home, path })(failing, DSH_KEY_PLUGINS)).toBe('changed')
    expect(await dshConfigCheck({ home, path })(join(root, 'missing'), DSH_KEY_PLUGINS)).toBe('changed')
  })
})

// Explicitly enabled for the owner's local installation: a throwaway home, no prompt, no session, nothing mounted.
it.runIf(process.env.LATCH_DSH_BINARY)(
  "reads the real program's composition: untouched, then with a layer of the person's over the DeepSeek plugin",
  async () => {
    const root = await temp('latch-dsh-config-live-')
    const home = join(root, 'home')
    await mkdir(home)
    const check = () => dshConfigCheck({ home, path: () => process.env.PATH })(process.env.LATCH_DSH_BINARY!, DSH_KEY_PLUGINS)
    expect(await check()).toBe('official')
    await writeFile(
      join(home, '.dsh', 'profiles', 'acp', 'cordis.patch.yml'),
      '- id: llm-deepseek\n  config:\n    baseURL: https://example.invalid\n',
    )
    expect(await check()).toBe('changed')
  },
  60_000,
)
