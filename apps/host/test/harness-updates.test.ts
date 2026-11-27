import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { FetchLike } from '../src/egress.ts'
import {
  HarnessUpdates,
  PI_LATEST_URL,
  distTagsUrl,
  homebrewUrl,
  readClaudeChannel,
  readDistTags,
  readHomebrew,
  readPiRelease,
  updateHint,
  type UpdateSource,
} from '../src/harness-updates.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function directory(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'latch-updates-')))
  cleanups.push(() => rm(path, { recursive: true, force: true }))
  return path
}

/** A registry that answers each package with these tags, recording each URL asked and the request's headers. */
function registry(tags: Record<string, unknown> | 'fail' | 'status' | 'garbage') {
  const asked: Array<{ url: string; init: RequestInit }> = []
  const fetch: FetchLike = async (url, init) => {
    asked.push({ url, init })
    if (tags === 'fail') throw new Error('offline')
    if (tags === 'status') return new Response('{}', { status: 404 })
    if (tags === 'garbage') return new Response('not json', { status: 200 })
    return new Response(JSON.stringify(tags), { status: 200 })
  }
  return { fetch, asked }
}

const dsh: UpdateSource = {
  lookup: { registry: 'npm', name: '@deepseek-ai/dsh' },
  current: '0.2.2',
  command: 'npm i -g @deepseek-ai/dsh@latest',
}

describe('the npm registry lookup', () => {
  it('asks only the dist-tags of a well-formed package name, with no identifying headers', async () => {
    expect(distTagsUrl('@openai/codex')).toBe('https://registry.npmjs.org/-/package/@openai%2Fcodex/dist-tags')
    expect(distTagsUrl('../evil')).toBeUndefined()
    expect(distTagsUrl('@a/b/c')).toBeUndefined()
    const { fetch, asked } = registry({ latest: '0.3.0' })
    const updates = new HarnessUpdates({ fetch, claudeDir: () => '/nonexistent' })
    await updates.settle([dsh], 1_000)
    expect(asked.map(item => item.url)).toEqual(['https://registry.npmjs.org/-/package/@deepseek-ai%2Fdsh/dist-tags'])
    expect(asked[0]!.init).toMatchObject({ method: 'GET', headers: { accept: 'application/json' }, redirect: 'manual' })
    expect(updates.hint(dsh)).toEqual({ current: '0.2.2', latest: '0.3.0', command: 'npm i -g @deepseek-ai/dsh@latest' })
  })

  it('hints only at a strictly newer release', () => {
    expect(updateHint(dsh, '0.3.0')).toEqual({ current: '0.2.2', latest: '0.3.0', command: dsh.command })
    expect(updateHint({ lookup: { registry: 'npm', name: 'x' }, current: '1.0.0' }, '1.0.1')).toEqual({ current: '1.0.0', latest: '1.0.1' })
    expect(updateHint(dsh, '0.2.2')).toBeUndefined()
    // A prerelease installed ahead of `latest`.
    expect(updateHint({ ...dsh, current: '0.3.0-rc.1' }, '0.2.9')).toBeUndefined()
    expect(updateHint({ ...dsh, current: 'unknown' }, '0.3.0')).toBeUndefined()
    expect(updateHint(dsh, undefined)).toBeUndefined()
  })

  it('keeps only release-shaped tags', () => {
    expect(readDistTags({ latest: '1.2.3', stable: '1.2.0', next: '2.0.0-beta.1' })).toEqual({ latest: '1.2.3', stable: '1.2.0' })
    expect(readDistTags({ latest: 'not a version' })).toBeUndefined()
    expect(readDistTags({ latest: `1.2.3-${'x'.repeat(80)}` })).toBeUndefined()
    expect(readDistTags(['1.2.3'])).toBeUndefined()
  })

  it.each(['fail', 'status', 'garbage'] as const)(
    'gives no hint when the lookup ends in %s, and does not ask again at once',
    async kind => {
      const { fetch, asked } = registry(kind)
      const updates = new HarnessUpdates({ fetch, claudeDir: () => '/nonexistent' })
      await updates.settle([dsh], 1_000)
      expect(updates.hint(dsh)).toBeUndefined()
      await updates.settle([dsh], 1_000)
      expect(asked).toHaveLength(1)
    },
  )

  it('asks once per package for six hours, then again', async () => {
    let now = 0
    const { fetch, asked } = registry({ latest: '0.3.0' })
    const updates = new HarnessUpdates({ fetch, claudeDir: () => '/nonexistent', now: () => now })
    await Promise.all([updates.settle([dsh, { ...dsh }], 1_000), updates.settle([dsh], 1_000)])
    expect(asked).toHaveLength(1)
    now += 6 * 60 * 60_000 - 1
    await updates.settle([dsh], 1_000)
    expect(asked).toHaveLength(1)
    now += 1
    await updates.settle([dsh], 1_000)
    expect(asked).toHaveLength(2)
  })
})

describe('the Homebrew lookup', () => {
  const goose: UpdateSource = {
    lookup: { registry: 'homebrew', kind: 'formula', name: 'block-goose-cli' },
    current: '1.57.0',
    command: 'brew upgrade block-goose-cli',
  }

  it('asks the formula or cask document of a well-formed name', async () => {
    expect(homebrewUrl('formula', 'block-goose-cli')).toBe('https://formulae.brew.sh/api/formula/block-goose-cli.json')
    expect(homebrewUrl('cask', 'claude-code')).toBe('https://formulae.brew.sh/api/cask/claude-code.json')
    expect(homebrewUrl('formula', '../evil')).toBeUndefined()
    expect(homebrewUrl('cask', 'a/b')).toBeUndefined()
    const { fetch, asked } = registry({ versions: { stable: '1.60.2', head: 'HEAD' } })
    const updates = new HarnessUpdates({ fetch, claudeDir: () => '/nonexistent' })
    await updates.settle([goose], 1_000)
    expect(asked.map(item => item.url)).toEqual(['https://formulae.brew.sh/api/formula/block-goose-cli.json'])
    expect(asked[0]!.init).toMatchObject({ method: 'GET', headers: { accept: 'application/json' }, redirect: 'manual' })
    expect(updates.hint(goose)).toEqual({ current: '1.57.0', latest: '1.60.2', command: 'brew upgrade block-goose-cli' })
  })

  it('reads a formula’s stable version and a cask’s version without its build', () => {
    expect(readHomebrew('formula', { versions: { stable: '1.60.2' } })).toBe('1.60.2')
    expect(readHomebrew('formula', { version: '1.60.2' })).toBeUndefined()
    expect(readHomebrew('cask', { version: '0.171.0' })).toBe('0.171.0')
    expect(readHomebrew('cask', { version: '2.1.323,abc123' })).toBe('2.1.323')
    expect(readHomebrew('cask', { version: 'latest' })).toBeUndefined()
    expect(readHomebrew('cask', ['0.171.0'])).toBeUndefined()
  })

  it('keeps a Homebrew install apart from the npm package of the same program', async () => {
    const asked: string[] = []
    const fetch: FetchLike = async url => {
      asked.push(url)
      const body = url.includes('formulae.brew.sh') ? { version: '2.1.323' } : { latest: '2.1.340', stable: '2.1.330' }
      return new Response(JSON.stringify(body), { status: 200 })
    }
    const cask: UpdateSource = {
      lookup: { registry: 'homebrew', kind: 'cask', name: 'claude-code' },
      current: '2.1.323',
      channel: 'claude',
    }
    const npm: UpdateSource = { lookup: { registry: 'npm', name: '@anthropic-ai/claude-code' }, current: '2.1.323', channel: 'claude' }
    const updates = new HarnessUpdates({ fetch, claudeDir: () => '/nonexistent' })
    await updates.settle([cask, npm], 1_000)
    expect(asked.sort()).toEqual([
      'https://formulae.brew.sh/api/cask/claude-code.json',
      'https://registry.npmjs.org/-/package/@anthropic-ai%2Fclaude-code/dist-tags',
    ])
    // The cask is current even though npm is ahead.
    expect(updates.hint(cask)).toBeUndefined()
    expect(updates.hint(npm)?.latest).toBe('2.1.340')
  })

  it('refuses a document larger than a formula is', async () => {
    const { fetch } = registry({ versions: { stable: '1.60.2' }, padding: 'x'.repeat(70 * 1024) })
    const updates = new HarnessUpdates({ fetch, claudeDir: () => '/nonexistent' })
    await updates.settle([goose], 1_000)
    expect(updates.hint(goose)).toBeUndefined()
  })
})

describe('the lookup for pi’s own installer', () => {
  const managed: UpdateSource = { lookup: { registry: 'pi' }, current: '1.6.0', command: 'pi update --self' }

  it('asks pi.dev for the release `pi update` installs, with no identifying headers', async () => {
    const { fetch, asked } = registry({ ok: true, version: '1.6.1', packageName: '@earendil-works/pi-coding-agent' })
    const updates = new HarnessUpdates({ fetch, claudeDir: () => '/nonexistent' })
    await updates.settle([managed], 1_000)
    expect(asked.map(item => item.url)).toEqual([PI_LATEST_URL])
    expect(PI_LATEST_URL).toBe('https://pi.dev/api/latest-version')
    expect(asked[0]!.init).toMatchObject({ method: 'GET', headers: { accept: 'application/json' }, redirect: 'manual' })
    expect(updates.hint(managed)).toEqual({ current: '1.6.0', latest: '1.6.1', command: 'pi update --self' })
  })

  it('reads only a release-shaped version', () => {
    expect(readPiRelease({ ok: true, version: '1.6.1' })).toBe('1.6.1')
    expect(readPiRelease({ latest: '1.6.1' })).toBeUndefined()
    expect(readPiRelease({ version: 'latest' })).toBeUndefined()
    expect(readPiRelease({ version: `1.6.1-${'x'.repeat(80)}` })).toBeUndefined()
    expect(readPiRelease(['1.6.1'])).toBeUndefined()
  })

  it('holds a managed install to pi.dev even when npm is ahead', async () => {
    const asked: string[] = []
    const fetch: FetchLike = async url => {
      asked.push(url)
      const body = url === PI_LATEST_URL ? { ok: true, version: '1.6.1' } : { latest: '1.7.0' }
      return new Response(JSON.stringify(body), { status: 200 })
    }
    const npm: UpdateSource = { lookup: { registry: 'npm', name: '@earendil-works/pi-coding-agent' }, current: '1.6.1' }
    const updates = new HarnessUpdates({ fetch, claudeDir: () => '/nonexistent' })
    await updates.settle([{ ...managed, current: '1.6.1' }, npm], 1_000)
    expect(asked.sort()).toEqual([PI_LATEST_URL, 'https://registry.npmjs.org/-/package/@earendil-works%2Fpi-coding-agent/dist-tags'])
    expect(updates.hint({ ...managed, current: '1.6.1' })).toBeUndefined()
    expect(updates.hint(npm)?.latest).toBe('1.7.0')
  })

  it('refuses an answer larger than a version is', async () => {
    const { fetch } = registry({ version: '1.6.1', padding: 'x'.repeat(8 * 1024) })
    const updates = new HarnessUpdates({ fetch, claudeDir: () => '/nonexistent' })
    await updates.settle([managed], 1_000)
    expect(updates.hint(managed)).toBeUndefined()
  })
})

describe('telling clients about a lookup', () => {
  it('stays quiet for one that lands in time, and refreshes once for those that land late', async () => {
    let calls = 0
    const quick = new HarnessUpdates({
      fetch: registry({ latest: '0.3.0' }).fetch,
      claudeDir: () => '/nonexistent',
      onChange: () => calls++,
    })
    await quick.settle([dsh], 1_000)
    await new Promise(resolve => setImmediate(resolve))
    expect(calls).toBe(0)

    let release!: () => void
    const gate = new Promise<void>(resolve => (release = resolve))
    const slow: FetchLike = async () => {
      await gate
      return new Response(JSON.stringify({ latest: '0.3.0' }), { status: 200 })
    }
    const late = new HarnessUpdates({ fetch: slow, claudeDir: () => '/nonexistent', onChange: () => calls++ })
    const codex: UpdateSource = { lookup: { registry: 'npm', name: '@openai/codex' }, current: '0.170.0' }
    await late.settle([dsh, codex], 10)
    expect(late.hint(dsh)).toBeUndefined()
    release()
    await expect.poll(() => late.hint(dsh)).toEqual({ current: '0.2.2', latest: '0.3.0', command: dsh.command })
    await new Promise(resolve => setImmediate(resolve))
    expect(calls).toBe(1)
  })
})

describe('Claude’s update channel', () => {
  const claude: UpdateSource = {
    lookup: { registry: 'npm', name: '@anthropic-ai/claude-code' },
    current: '2.1.322',
    channel: 'claude',
    command: 'claude update',
  }

  it('follows `autoUpdatesChannel`: stable picks the stable tag, anything else latest', async () => {
    const dir = await directory()
    const { fetch } = registry({ latest: '2.1.340', stable: '2.1.330' })
    const updates = new HarnessUpdates({ fetch, claudeDir: () => dir })
    await updates.settle([claude], 1_000)
    expect(updates.hint(claude)?.latest).toBe('2.1.340')
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ autoUpdatesChannel: 'stable', model: 'x' }))
    await updates.settle([claude], 1_000)
    expect(updates.hint(claude)).toEqual({ current: '2.1.322', latest: '2.1.330', command: 'claude update' })
    const other = { ...claude, claudeDirectory: await directory() }
    await updates.settle([claude, other], 1_000)
    expect(updates.hint(other)?.latest).toBe('2.1.340')
    expect(updates.hint(claude)?.latest).toBe('2.1.330')
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ autoUpdatesChannel: 'nightly' }))
    expect(await readClaudeChannel(dir)).toBe('latest')
    await writeFile(join(dir, 'settings.json'), '{ broken')
    expect(await readClaudeChannel(dir)).toBe('latest')
  })

  it('gives no hint when the chosen tag is absent', async () => {
    const dir = await directory()
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ autoUpdatesChannel: 'stable' }))
    const { fetch } = registry({ latest: '2.1.340' })
    const updates = new HarnessUpdates({ fetch, claudeDir: () => dir })
    await updates.settle([claude], 1_000)
    expect(updates.hint(claude)).toBeUndefined()
  })

  it('does not follow a link to the settings file', async () => {
    const dir = await directory()
    await mkdir(join(dir, 'elsewhere'))
    await writeFile(join(dir, 'elsewhere', 'settings.json'), JSON.stringify({ autoUpdatesChannel: 'stable' }))
    await symlink(join(dir, 'elsewhere', 'settings.json'), join(dir, 'settings.json'))
    expect(await readClaudeChannel(dir)).toBe('latest')
  })
})
