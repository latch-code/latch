import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ACCENT_HUE_DISTANCE,
  ACCENT_HUE_RANGE,
  CONTRAST_FLOORS,
  CUSTOMIZATION_REVISION_LIMIT,
  DEFAULT_CUSTOMIZATION,
  MIN_PHONE_INPUT_PX,
  MIN_TEXT_PX,
  accentAt,
  accentFamilyIssues,
  accentIssues,
  allowedAccentHues,
  customizationIssues,
  parseCustomization,
  resolvableTokens,
  resolveAppearance,
  type AppSnapshot,
  type CustomizationDocument,
  type CustomizationReceipt,
  type CustomizationView,
} from '@latch/protocol'
import { verifyAuditFile } from '../src/audit.ts'
import { CustomizationStore, type PendingRevision } from '../src/customization.ts'
import { writeHostState } from '../src/host-state.ts'
import { defaultPolicy } from '../src/policy.ts'
import { runLatch, type CliIO } from '../scripts/latch.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open) }
})

const doc = (appearance: CustomizationDocument['appearance']): CustomizationDocument => ({ schema: 1, appearance })
const fields = (value: unknown) => customizationIssues(value).map(issue => issue.field)

describe('a customisation document', () => {
  it('accepts the default and a full appearance, and refuses unknown fields without correcting them', () => {
    expect(customizationIssues(DEFAULT_CUSTOMIZATION)).toEqual([])
    const full = doc({ accentHue: 300, radius: 'round', textSize: 'large' })
    expect(parseCustomization(full)).toBe(full)
    expect(fields({ schema: 1, appearance: {}, layout: {} })).toEqual([''])
    expect(fields({ schema: 1, appearance: { css: 'body{display:none}' } })).toEqual(['appearance'])
    expect(fields({ schema: 1, appearance: { amber: '#00ff00' } })).toEqual(['appearance'])
    expect(fields({ schema: 1, appearance: { density: 'compact', motion: 'reduce' } })).toEqual(['appearance'])
    expect(fields({ schema: 2, appearance: {} })).toEqual(['schema'])
    expect(fields({ schema: 1 })).toEqual(['appearance'])
    expect(fields(null)).toEqual([''])
    expect(fields([])).toEqual([''])
  })

  it('refuses a value outside its enumeration or range, and any text that could be CSS', () => {
    for (const hue of [-1, 360, 1.5, Number.NaN, '264', null])
      expect(fields(doc({ accentHue: hue as never }))).toEqual(['appearance.accentHue'])
    const hostile = ['url(https://example.com/x)', 'round; display: none', '}', '\\0000', 'sharp\n', 'var(--red)', '', 'ROUND']
    for (const value of hostile)
      for (const field of ['radius', 'textSize'] as const)
        expect(fields(doc({ [field]: value as never })), `${field}=${JSON.stringify(value)}`).toEqual([`appearance.${field}`])
    expect(parseCustomization(doc({ radius: 'round; display: none' as never }))).toBeNull()
  })

  it('keeps the accent 30° from amber, red and green in both themes, and says how close it came', () => {
    // Red, amber and green, by their hues in the two themes.
    for (const hue of [0, 27, 45, 60, 73, 100, 125, 152, 157, 185, 356]) {
      const issues = accentIssues(hue)
      expect(issues.length, String(hue)).toBeGreaterThan(0)
      expect(issues[0]).toMatchObject({ field: 'appearance.accentHue', required: ACCENT_HUE_DISTANCE })
      expect(issues[0]!.measured).toBeLessThan(ACCENT_HUE_DISTANCE)
      expect(issues[0]!.message).toMatch(/主色离(?:琥珀|红|绿)色太近（(?:浅色|深色)，相差 [\d.]+°，至少 30°）/u)
    }
    const allowed = allowedAccentHues()
    expect(allowed).toContain(262)
    // Teal through blue and violet to magenta, and nothing else: the yellow-greens between amber and green read as
    // amber, and the pinks past 330 sit beside red.
    expect(ACCENT_HUE_RANGE).toEqual({ from: 187, to: 330 })
    expect(allowed).toEqual(Array.from({ length: 144 }, (_, index) => 187 + index))
    for (const hue of [103, 110, 122, 331, 340, 354]) {
      expect(accentIssues(hue), String(hue)).toEqual([
        { field: 'appearance.accentHue', message: `主色色相需在 187–330 之间（现在是 ${hue}）`, measured: hue },
      ])
      expect(parseCustomization(doc({ accentHue: hue }))).toBeNull()
    }
  })

  it('keeps every allowed accent at the contrast the product keeps: white words, accent words and the focus ring', () => {
    // Each role keeps its luminance at another hue, so no hue can fall under a floor: every refusal is for the hue itself.
    for (let hue = 0; hue < 360; hue++)
      expect(
        accentIssues(hue).every(issue => !issue.message.includes('对比度')),
        String(hue),
      ).toBe(true)
    // The floor itself: a family that is too light for white words, or too dim on a surface, is refused with its ratio.
    const family = accentAt('light', 262)
    const pale = accentFamilyIssues('light', { ...family, accent: [150, 180, 255] })
    expect(pale.map(issue => [issue.required, issue.measured! < issue.required!])).toEqual([
      [CONTRAST_FLOORS.onAccent, true],
      [CONTRAST_FLOORS.focusRing, true],
    ])
    expect(pale[0]!.message).toMatch(/^主色上的白字对比度不足（浅色，[\d.]+:1，至少 4\.5:1）$/u)
    const dim = accentFamilyIssues('dark', { ...accentAt('dark', 262), ink: [40, 60, 120] })
    expect(dim.map(issue => issue.required)).toEqual([CONTRAST_FLOORS.accentInk])
    expect(accentFamilyIssues('light', family)).toEqual([])
    // Running work, ordinary words on the accent's tint, and the tinted drop under the primary button are held to floors
    // by the same rule.
    const label = (issues: ReturnType<typeof accentFamilyIssues>) => issues.map(issue => [issue.message.split('对比度')[0], issue.required])
    expect(label(accentFamilyIssues('light', { ...family, running: [170, 190, 255] }))).toEqual([['运行中的主色', CONTRAST_FLOORS.running]])
    expect(label(accentFamilyIssues('dark', { ...accentAt('dark', 262), running: [30, 40, 90] }))).toEqual([
      ['运行中的主色', CONTRAST_FLOORS.running],
    ])
    expect(label(accentFamilyIssues('light', { ...family, soft: [0, 0, 0] }))).toEqual([])
    expect(label(accentFamilyIssues('light', { ...family, shadow: [200, 215, 255] }))).toEqual([['主色投影', CONTRAST_FLOORS.shadow]])
  })

  it('expands to token values built from numbers alone, and to nothing for the default', () => {
    expect(resolveAppearance({})).toEqual({ base: {}, light: {}, dark: {}, phone: {} })
    expect(resolveAppearance({ radius: 'default', textSize: 'default' })).toEqual(resolveAppearance({}))
    const safe =
      /^(?:#[0-9a-f]{6}|\d+(?:\.\d+)?px|rgba\(\d+, \d+, \d+, 0\.\d+\)|inset 0 1px 0 rgba\(255, 255, 255, 0\.16\), 0 1px 2px rgba\(\d+, \d+, \d+, 0\.(?:24|4)\))$/u
    const names = new Set(resolvableTokens())
    const tables = [
      ...allowedAccentHues().map(hue => resolveAppearance({ accentHue: hue })),
      ...(['sharp', 'round'] as const).flatMap(radius =>
        (['small', 'large'] as const).map(textSize => resolveAppearance({ radius, textSize })),
      ),
    ].flatMap(resolved => [resolved.base, resolved.light, resolved.dark, resolved.phone])
    for (const table of tables)
      for (const [name, value] of Object.entries(table)) {
        expect(value, name).toMatch(safe)
        expect(names.has(name), name).toBe(true)
      }
    // The product's own hue gives back the product's own accent, within a rounding step.
    expect(resolveAppearance({ accentHue: 262 }).light['--accent']).toMatch(/^#2[0-9a-f]6[0-9a-f]e[0-9a-f]$/u)
    // Radii stay on the scale; no text goes under the smallest size, and a phone's input never under 16px.
    const px = (table: Record<string, string>, prefix: string) =>
      Object.entries(table)
        .filter(([name]) => name.startsWith(prefix))
        .map(([, value]) => parseFloat(value))
    for (const radius of ['sharp', 'round'] as const)
      expect(px(resolveAppearance({ radius }).base, '--r-').every(value => [2, 4, 6, 8, 12, 16].includes(value))).toBe(true)
    const small = resolveAppearance({ textSize: 'small' })
    expect(Math.min(...px(small.base, '--fs-'), ...px(small.phone, '--fs-'))).toBe(MIN_TEXT_PX)
    expect(small.phone['--fs-input']).toBe(`${MIN_PHONE_INPUT_PX}px`)
    expect(resolveAppearance({ textSize: 'large' }).base['--fs-ui']).toBe('15px')
    // Both themes say their own shadow under the primary button: the light one's is tinted with the accent, the dark
    // one's is black, and it is in the dark table so the tinted one does not stay on the root under the dark theme.
    const purple = resolveAppearance({ accentHue: 300 })
    expect(purple.light['--sh-accent']).toMatch(/^inset 0 1px 0 rgba\(255, 255, 255, 0\.16\), 0 1px 2px rgba\(\d+, \d+, \d+, 0\.24\)$/u)
    expect(purple.dark['--sh-accent']).toBe('inset 0 1px 0 rgba(255, 255, 255, 0.16), 0 1px 2px rgba(0, 0, 0, 0.4)')
    expect(Object.keys(purple.dark).toSorted()).toEqual(Object.keys(purple.light).toSorted())
  })
})

const directories: string[] = []
const hosts: TestHost[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.mocked(open).mockReset()
  for (const host of hosts.splice(0)) await host.close()
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function failFirstDirectorySync(dir: string) {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const interrupted = vi.fn(async () => {
    throw new Error('directory sync failed')
  })
  let fail = true
  vi.mocked(open).mockImplementation(async (...args) => {
    const handle = await actual.open(...args)
    if (fail && args[0] === dir && args[1] === 'r') {
      fail = false
      handle.sync = interrupted
    }
    return handle
  })
  return interrupted
}

describe('the customisation store', () => {
  async function store(now = () => Date.parse('2026-11-15T00:00:00Z')) {
    const dir = await mkdtemp(join(tmpdir(), 'latch-customization-'))
    directories.push(dir)
    return { dir, value: await CustomizationStore.open(dir, { now }) }
  }
  const noRecord = async () => {}
  const apply = (
    value: CustomizationStore,
    appearance: CustomizationDocument['appearance'],
    extra: { requestId?: string; base?: number } = {},
  ) =>
    value.write(
      {
        actor: 'dev_a',
        by: 'device',
        requestId: extra.requestId ?? randomUUID(),
        baseRevision: extra.base ?? value.state().revision,
        change: { kind: 'apply', doc: doc(appearance) },
      },
      noRecord,
    )

  it('starts at the default, saves a 0600 file and reads it back after a restart', async () => {
    const { dir, value } = await store()
    expect(value.state()).toEqual({ revision: 0, doc: DEFAULT_CUSTOMIZATION })
    const receipt = await apply(value, { accentHue: 300, radius: 'round' })
    expect(receipt).toMatchObject({ revision: 1, applied: 1, replayed: false, doc: doc({ accentHue: 300, radius: 'round' }) })
    expect((await stat(join(dir, 'customization.json'))).mode & 0o777).toBe(0o600)
    const reopened = await CustomizationStore.open(dir)
    expect(reopened.state()).toEqual({ revision: 1, doc: doc({ accentHue: 300, radius: 'round' }) })
    expect(reopened.view().revisions).toMatchObject([{ revision: 1, source: 'apply', by: 'device', at: '2026-11-15T00:00:00.000Z' }])
  })

  it('answers a repeated request with the first answer and refuses its ID for another change', async () => {
    const { value } = await store()
    const requestId = randomUUID()
    const first = await apply(value, { textSize: 'large' }, { requestId, base: 0 })
    await apply(value, { textSize: 'small' })
    // The retry carries the base it had; the answer is the first one's, not a conflict and not a second revision.
    const retry = await apply(value, { textSize: 'large' }, { requestId, base: 0 })
    expect([first.applied, retry.applied, retry.replayed, retry.revision]).toEqual([1, 1, true, 2])
    expect(value.view().revisions.map(item => item.revision)).toEqual([2, 1])
    await expect(apply(value, { textSize: 'default' }, { requestId, base: 0 })).rejects.toMatchObject({
      status: 409,
      code: 'request-id-reused',
    })
    // Another device may use the same ID: a request ID is one device's.
    const other = await value.write(
      { actor: 'dev_b', by: 'device', requestId, baseRevision: 2, change: { kind: 'apply', doc: doc({ radius: 'round' }) } },
      noRecord,
    )
    expect(other).toMatchObject({ applied: 3, replayed: false })
  })

  it('refuses a write over a newer revision, an invalid document and a revision no longer kept', async () => {
    const { value } = await store()
    await apply(value, { radius: 'sharp' })
    await expect(apply(value, { radius: 'round' }, { base: 0 })).rejects.toMatchObject({
      status: 409,
      code: 'customization-conflict',
      details: { revision: 1 },
    })
    await expect(apply(value, { accentHue: 60 })).rejects.toMatchObject({
      status: 400,
      code: 'customization-invalid',
      details: { field: 'appearance.accentHue' },
    })
    await expect(apply(value, { css: 'x' } as never)).rejects.toMatchObject({ status: 400, code: 'customization-invalid' })
    await expect(
      value.write(
        { actor: 'dev_a', by: 'device', requestId: randomUUID(), baseRevision: 1, change: { kind: 'restore', revision: 9 } },
        noRecord,
      ),
    ).rejects.toMatchObject({ status: 404, code: 'customization-revision-not-found' })
    expect(value.state().revision).toBe(1)
  })

  it(`keeps the last ${CUSTOMIZATION_REVISION_LIMIT} revisions, restores one as a new revision and resets to the default`, async () => {
    const { dir, value } = await store()
    for (let index = 0; index < CUSTOMIZATION_REVISION_LIMIT + 5; index++) await apply(value, { accentHue: 200 + index })
    const kept = value.view().revisions.map(item => item.revision)
    expect(kept).toHaveLength(CUSTOMIZATION_REVISION_LIMIT)
    expect([kept[0], kept.at(-1)]).toEqual([25, 6])
    const restored = await value.write(
      { actor: 'dev_a', by: 'device', requestId: randomUUID(), baseRevision: 25, change: { kind: 'restore', revision: 10 } },
      noRecord,
    )
    expect(restored).toMatchObject({ revision: 26, doc: doc({ accentHue: 209 }) })
    expect(value.view().revisions[0]).toMatchObject({ revision: 26, source: 'restore' })
    // Reset holds the revision the caller was looking at.
    const reset = await value.write(
      { actor: 'cli', by: 'cli', requestId: randomUUID(), baseRevision: 26, change: { kind: 'reset' } },
      noRecord,
    )
    expect(reset).toMatchObject({ revision: 27, doc: DEFAULT_CUSTOMIZATION })
    expect(value.view().revisions[0]).toMatchObject({ revision: 27, source: 'reset', by: 'cli' })
    expect(value.view().revisions).toHaveLength(CUSTOMIZATION_REVISION_LIMIT)
    expect((await CustomizationStore.open(dir)).state()).toEqual({ revision: 27, doc: DEFAULT_CUSTOMIZATION })
    // The same document again is not a new revision.
    const again = await value.write(
      { actor: 'cli', by: 'cli', requestId: randomUUID(), baseRevision: 27, change: { kind: 'reset' } },
      noRecord,
    )
    expect(again).toMatchObject({ revision: 27, applied: 27, replayed: false })
  })

  it('settles the original receipt before accepting another write after directory sync fails', async () => {
    const { dir, value } = await store()
    const interrupted = await failFirstDirectorySync(dir)
    const requestId = randomUUID()
    await expect(apply(value, { radius: 'round' }, { requestId, base: 0 })).rejects.toBeDefined()
    expect(interrupted).toHaveBeenCalledOnce()
    expect((await CustomizationStore.open(dir)).state()).toEqual({ revision: 1, doc: doc({ radius: 'round' }) })
    await expect(apply(value, { radius: 'sharp' }, { base: 0 })).rejects.toMatchObject({
      status: 503,
      code: 'customization-write-pending',
    })
    expect((await CustomizationStore.open(dir)).state()).toEqual({ revision: 1, doc: doc({ radius: 'round' }) })
    await expect(apply(value, { radius: 'round' }, { requestId, base: 0 })).resolves.toMatchObject({ applied: 1, revision: 1 })
    await expect(apply(value, { radius: 'sharp' }, { base: 1 })).resolves.toMatchObject({ applied: 2, revision: 2 })
    expect((await CustomizationStore.open(dir)).view().revisions.map(item => item.revision)).toEqual([2, 1])
  })

  it('records before it saves: a record that fails leaves the document as it was', async () => {
    const { value } = await store()
    const seen: PendingRevision[] = []
    await value.write(
      {
        actor: 'dev_a',
        by: 'device',
        requestId: randomUUID(),
        baseRevision: 0,
        change: { kind: 'apply', doc: doc({ accentHue: 300, textSize: 'large' }) },
      },
      async pending => {
        seen.push(pending)
      },
    )
    expect(seen).toMatchObject([{ revision: 1, previous: 0, source: 'apply', fields: ['accentHue', 'textSize'] }])
    expect(seen[0]!.hash).toMatch(/^[a-f0-9]{64}$/u)
    await expect(
      value.write(
        {
          actor: 'dev_a',
          by: 'device',
          requestId: randomUUID(),
          baseRevision: 1,
          change: { kind: 'apply', doc: doc({ radius: 'round' }) },
        },
        async () => {
          throw new Error('audit failed')
        },
      ),
    ).rejects.toThrow('audit failed')
    expect(value.state().revision).toBe(1)
  })

  const saved = (revisions: Array<{ revision: number; doc: unknown }>) =>
    JSON.stringify({
      version: 1,
      revisions: revisions.map(item => ({ ...item, hash: 'a'.repeat(64), at: '2026-11-14T00:00:00.000Z', source: 'apply', by: 'device' })),
      receipts: [],
    })

  it('starts at the default over a file it cannot use, keeps that file aside and says where', async () => {
    // A file that is not this shape at all, and one whose document in force a rule now refuses (a hue no longer allowed).
    for (const content of [
      JSON.stringify({ version: 1, revisions: [{ revision: 1, style: 'body{}' }], receipts: [] }),
      '{',
      saved([{ revision: 1, doc: doc({ accentHue: 110 }) }]),
    ]) {
      const dir = await mkdtemp(join(tmpdir(), 'latch-customization-'))
      directories.push(dir)
      await writeFile(join(dir, 'customization.json'), content, { mode: 0o644 })
      const logged: string[] = []
      const value = await CustomizationStore.open(dir, { log: text => logged.push(text), now: () => Date.parse('2026-11-15T01:02:03Z') })
      expect(value.state()).toEqual({ revision: 0, doc: DEFAULT_CUSTOMIZATION })
      const aside = 'customization.json.unreadable-20261115T010203000Z'
      expect((await readdir(dir)).toSorted()).toEqual([aside])
      expect(await readFile(join(dir, aside), 'utf8')).toBe(content)
      expect((await stat(join(dir, aside))).mode & 0o777).toBe(0o600)
      expect(logged).toEqual([`自定义文件无法使用，已按默认外观启动；原文件保留为 ${aside}。`])
      // The next write starts a new file beside it.
      await apply(value, { radius: 'round' })
      expect((await readdir(dir)).toSorted()).toEqual(['customization.json', aside])
    }
  })

  it('checks a kept revision again before going back to it: one saved under older rules is refused and stays in the history', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'latch-customization-'))
    directories.push(dir)
    await writeFile(
      join(dir, 'customization.json'),
      saved([
        { revision: 1, doc: doc({ accentHue: 110 }) },
        { revision: 2, doc: doc({ radius: 'round' }) },
      ]),
    )
    const logged: string[] = []
    const value = await CustomizationStore.open(dir, { log: text => logged.push(text) })
    // The document in force passes, so the file is used as it is.
    expect([value.state().revision, logged]).toEqual([2, []])
    await expect(
      value.write(
        { actor: 'dev_a', by: 'device', requestId: randomUUID(), baseRevision: 2, change: { kind: 'restore', revision: 1 } },
        noRecord,
      ),
    ).rejects.toMatchObject({ status: 400, code: 'customization-invalid', details: { field: 'appearance.accentHue' } })
    expect(value.state()).toEqual({ revision: 2, doc: doc({ radius: 'round' }) })
    expect(value.view().revisions.map(item => item.revision)).toEqual([2, 1])
  })
})

describe('customisation routes', { timeout: 30_000 }, () => {
  const errorOf = async (response: Response) => {
    const body = (await response.json()) as { error: string; field?: string }
    return { status: response.status, error: body.error }
  }
  const auditOf = async (t: TestHost) =>
    (await readFile(join(t.dataDir, 'audit', 'audit.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(
        line =>
          JSON.parse(line) as {
            action: string
            actor: Record<string, unknown>
            target?: string
            stepup?: string
            detail: Record<string, unknown>
          },
      )
      .filter(record => record.action === 'customization.applied')

  it.each(['audit', 'file preparation'])('refuses an appearance write after its device is revoked during %s', async phase => {
    const t = await startTestHost()
    hosts.push(t)
    const owner = await t.enroll({ listener: 'unix' })
    const editor = await t.enroll({ listener: 'loopback-tcp', scopes: ['view', 'run', 'admin'] })
    let entered!: () => void
    let release!: () => void
    const preparing = new Promise<void>(resolve => {
      entered = resolve
    })
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    const audit = t.host.security.audit
    const append = audit.append.bind(audit)
    if (phase === 'audit') {
      vi.spyOn(audit, 'append').mockImplementation(async event => {
        const saved = await append(event)
        if (event.action === 'customization.applied') {
          entered()
          await held
        }
        return saved
      })
    } else {
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
      vi.mocked(open).mockImplementation(async (...args) => {
        const handle = await actual.open(...args)
        const [path, flags] = args
        if (typeof path === 'string' && dirname(path) === t.dataDir && basename(path).startsWith('customization.') && flags === 'wx') {
          const close = handle.close.bind(handle)
          handle.close = async () => {
            await close()
            entered()
            await held
          }
        }
        return handle
      })
    }
    const write = editor.request('customization', {
      method: 'POST',
      body: { requestId: randomUUID(), baseRevision: 0, doc: doc({ radius: 'round' }) },
    })
    try {
      await preparing
      expect((await owner.request(`devices/${editor.id}`, { method: 'DELETE' })).status).toBe(200)
    } finally {
      release()
    }
    expect(await errorOf(await write)).toEqual({ status: 401, error: 'device-revoked' })
    expect((await owner.json<CustomizationView>('customization')).revision).toBe(0)
    await expect(stat(join(t.dataDir, 'customization.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects an unversioned reset and protects a newer revision when the reset receipt expires', async () => {
    const t = await startTestHost()
    hosts.push(t)
    const owner = await t.enroll({ listener: 'unix' })
    const apply = (baseRevision: number, appearance: CustomizationDocument['appearance']) =>
      owner.json<CustomizationReceipt>('customization', {
        method: 'POST',
        body: { requestId: randomUUID(), baseRevision, doc: doc(appearance) },
      })
    await apply(0, { radius: 'round' })
    const body = { requestId: randomUUID(), baseRevision: 1 }
    const reset = () => owner.request('customization/reset', { method: 'POST', body })
    expect((await reset()).status).toBe(200)
    await apply(2, { textSize: 'large' })
    expect(await (await reset()).json()).toMatchObject({ applied: 2, revision: 3, replayed: true })
    for (let index = 0; index < 64; index++) await apply(3, { textSize: 'large' })
    expect(await errorOf(await reset())).toEqual({ status: 409, error: 'customization-conflict' })
    expect((await owner.request('customization/reset', { method: 'POST', body: { requestId: body.requestId } })).status).toBe(400)
    expect(await owner.json<CustomizationView>('customization')).toMatchObject({ revision: 3, doc: doc({ textSize: 'large' }) })
  })

  it('does not echo an arbitrary appearance key in a validation failure', async () => {
    const t = await startTestHost()
    hosts.push(t)
    const owner = await t.enroll({ listener: 'unix' })
    const key = ['s', 'k-', 'fixtureonly', 'a'.repeat(32)].join('')
    const response = await owner.request('customization', {
      method: 'POST',
      body: { requestId: randomUUID(), baseRevision: 0, doc: { schema: 1, appearance: { [key]: 'test' } } },
    })
    expect(response.status).toBe(400)
    const result = await response.text()
    expect(result).not.toContain(key)
    expect(JSON.parse(result)).toMatchObject({ error: 'customization-invalid', field: 'appearance' })
  })

  it('gives every device the document in its snapshot, lets only 管理此 Host change it, and records each change', async () => {
    const t = await startTestHost()
    hosts.push(t)
    const owner = await t.enroll({ listener: 'unix' })
    const phone = await t.enroll({ listener: 'loopback-tcp', scopes: ['view', 'run'] })
    const first = await owner.json<AppSnapshot>('snapshot')
    expect(first.catalog?.features?.customization).toBe(true)
    expect(first.customization).toEqual({ revision: 0, doc: DEFAULT_CUSTOMIZATION })
    const applied = doc({ accentHue: 300, radius: 'round', textSize: 'large' })
    const body = { requestId: randomUUID(), baseRevision: 0, doc: applied }
    // A device without 管理此 Host reads and cannot write; no credential reads nothing.
    expect(await errorOf(await phone.request('customization', { method: 'POST', body }))).toEqual({ status: 403, error: 'scope-required' })
    expect(
      await errorOf(await phone.request('customization/reset', { method: 'POST', body: { requestId: randomUUID(), baseRevision: 0 } })),
    ).toEqual({
      status: 403,
      error: 'scope-required',
    })
    expect((await t.raw('loopback-tcp', 'api/customization')).status).toBe(401)
    expect((await t.raw('loopback-tcp', 'api/customization', { method: 'POST', body })).status).toBe(401)
    expect(
      (await t.raw('loopback-tcp', 'api/customization/reset', { method: 'POST', body: { requestId: randomUUID(), baseRevision: 0 } }))
        .status,
    ).toBe(401)
    const before = (await owner.json<AppSnapshot>('snapshot')).revision ?? 0
    // Applying asks for no local confirmation: the answer is the receipt, not a step-up.
    const response = await owner.request('customization', { method: 'POST', body })
    expect(response.status).toBe(200)
    expect((await response.json()) as CustomizationReceipt).toEqual({
      requestId: body.requestId,
      applied: 1,
      replayed: false,
      revision: 1,
      doc: applied,
    })
    expect(t.presence.requests.filter(request => !request.preview.action.startsWith('device.'))).toEqual([])
    // The phone gets the same document, and the snapshot's revision moved so every device reads it again.
    const seen = await phone.json<AppSnapshot>('snapshot')
    expect(seen.customization).toEqual({ revision: 1, doc: applied })
    expect(seen.revision ?? 0).toBeGreaterThan(before)
    expect((await phone.json<CustomizationView>('customization')).revisions).toMatchObject([{ revision: 1, source: 'apply', by: 'device' }])
    // The same request again: the same receipt, no second record.
    const retry = await owner.json<CustomizationReceipt>('customization', { method: 'POST', body })
    expect(retry).toMatchObject({ applied: 1, replayed: true })
    expect(await auditOf(t)).toMatchObject([
      {
        actor: { deviceId: owner.id, listener: 'unix' },
        target: '1',
        detail: { revision: 1, previous: 0, source: 'apply', fields: ['accentHue', 'radius', 'textSize'] },
      },
    ])
    expect(Object.keys((await auditOf(t))[0]!.detail).toSorted()).toEqual(['fields', 'hash', 'previous', 'revision', 'source'])
  })

  it('refuses an invalid document with its field, an unknown body field and a stale base; restores and resets', async () => {
    const t = await startTestHost()
    hosts.push(t)
    const owner = await t.enroll({ listener: 'unix' })
    const post = (path: string, body: unknown) => owner.request(path, { method: 'POST', body })
    const near = await post('customization', { requestId: randomUUID(), baseRevision: 0, doc: doc({ accentHue: 60 }) })
    expect(near.status).toBe(400)
    expect(await near.json()).toMatchObject({
      error: 'customization-invalid',
      field: 'appearance.accentHue',
      issues: [{ required: 30 }, { required: 30 }],
    })
    for (const bad of [
      { requestId: randomUUID(), baseRevision: 0, doc: { schema: 1, appearance: { css: ':root{}' } } },
      { requestId: randomUUID(), baseRevision: 0, doc: { schema: 1, appearance: { radius: 'url(x)' } } },
      { requestId: randomUUID(), baseRevision: 0, doc: doc({}), style: 'x' },
      { requestId: randomUUID(), doc: doc({}) },
      { requestId: 'x', baseRevision: 0, doc: doc({}) },
    ])
      expect((await post('customization', bad)).status, JSON.stringify(bad)).toBe(400)
    expect((await owner.json<AppSnapshot>('snapshot')).customization?.revision).toBe(0)
    expect((await post('customization', { requestId: randomUUID(), baseRevision: 0, doc: doc({ radius: 'sharp' }) })).status).toBe(200)
    expect((await post('customization', { requestId: randomUUID(), baseRevision: 1, doc: doc({ radius: 'round' }) })).status).toBe(200)
    expect(await errorOf(await post('customization', { requestId: randomUUID(), baseRevision: 1, doc: doc({}) }))).toEqual({
      status: 409,
      error: 'customization-conflict',
    })
    const restored = await owner.json<CustomizationReceipt>('customization/restore', {
      method: 'POST',
      body: { requestId: randomUUID(), baseRevision: 2, revision: 1 },
    })
    expect(restored).toMatchObject({ revision: 3, doc: doc({ radius: 'sharp' }) })
    const reset = await owner.json<CustomizationReceipt>('customization/reset', {
      method: 'POST',
      body: { requestId: randomUUID(), baseRevision: 3 },
    })
    expect(reset).toMatchObject({ revision: 4, doc: DEFAULT_CUSTOMIZATION })
    expect((await auditOf(t)).map(record => record.detail.source)).toEqual(['apply', 'apply', 'restore', 'reset'])
    // The command line resets over host.sock without a device; the same route refuses that on every other listener.
    await post('customization', { requestId: randomUUID(), baseRevision: 4, doc: doc({ textSize: 'small' }) })
    const cli = await t.raw('unix', 'api/customization/reset', { method: 'POST', body: { requestId: randomUUID(), baseRevision: 5 } })
    expect(cli.status).toBe(200)
    expect((await cli.json()) as CustomizationReceipt).toMatchObject({ revision: 6, doc: DEFAULT_CUSTOMIZATION })
    expect((await auditOf(t)).at(-1)).toMatchObject({ actor: { listener: 'unix', via: 'cli' }, detail: { source: 'reset', fields: [] } })
    expect(
      (await t.raw('unix', 'api/customization', { method: 'POST', body: { requestId: randomUUID(), baseRevision: 6, doc: doc({}) } }))
        .status,
    ).toBe(401)
  })
})

describe('the rate of customisation changes', { timeout: 30_000 }, () => {
  it('counts apply and restore per device like other settings, and never turns a reset away', async () => {
    const clock = Date.parse('2026-11-15T00:00:00Z')
    const t = await startTestHost({ rateLimits: 'default', now: () => clock })
    hosts.push(t)
    const owner = await t.enroll({ listener: 'unix' })
    const body = { requestId: randomUUID(), baseRevision: 0, doc: doc({ radius: 'round' }) }
    const statuses: number[] = []
    // The same request again and again: answered from its receipt, and still counted.
    for (let index = 0; index < 70; index++) statuses.push((await owner.request('customization', { method: 'POST', body })).status)
    expect(statuses[0]).toBe(200)
    const refused = statuses.indexOf(429)
    expect(refused).toBeGreaterThan(0)
    expect(statuses.slice(refused).every(status => status === 429)).toBe(true)
    const restore = await owner.request('customization/restore', {
      method: 'POST',
      body: { requestId: randomUUID(), baseRevision: 1, revision: 1 },
    })
    expect(restore.status).toBe(429)
    expect(((await restore.json()) as { error: string }).error).toBe('rate-limited')
    const reset = await owner.request('customization/reset', { method: 'POST', body: { requestId: randomUUID(), baseRevision: 1 } })
    expect(reset.status).toBe(200)
    expect((await owner.json<AppSnapshot>('snapshot')).customization).toEqual({ revision: 2, doc: DEFAULT_CUSTOMIZATION })
  })
})

describe('pnpm latch customization reset', { timeout: 30_000 }, () => {
  function cli() {
    const output = { stdout: '', stderr: '' }
    const io: CliIO = {
      stdout: { write: (text: string) => (output.stdout += text), isTTY: false },
      stderr: { write: (text: string) => (output.stderr += text) },
      stdin: { isTTY: false },
      readSecret: async () => '',
      readLine: async () => '',
      env: {},
      cwd: tmpdir(),
    }
    return { output, latch: (...argv: string[]) => runLatch(argv, io) }
  }

  it('resets a stopped Host on the given data directory only, keeps the history and records it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-customization-cli-'))
    directories.push(root)
    const dataDir = join(root, 'data')
    const other = join(root, 'other')
    for (const dir of [dataDir, other]) {
      await mkdir(dir, { recursive: true, mode: 0o700 })
      // Local confirmation off, so nothing here can reach the real component.
      await writeFile(
        join(dir, 'policy.json'),
        JSON.stringify({ ...defaultPolicy(process.platform), presence: { backend: 'none', helperCdhash: null } }),
        {
          mode: 0o600,
        },
      )
      const store = await CustomizationStore.open(dir)
      await store.write(
        { actor: 'dev_a', by: 'device', requestId: randomUUID(), baseRevision: 0, change: { kind: 'apply', doc: doc({ accentHue: 300 }) } },
        async () => {},
      )
    }
    const { output, latch } = cli()
    expect(await latch('customization', 'reset', '--data-dir', dataDir)).toBe(0)
    expect(output.stdout).toContain('外观已恢复默认（版本 2）')
    expect(output.stderr).toBe('')
    const reset = await CustomizationStore.open(dataDir)
    expect(reset.state()).toEqual({ revision: 2, doc: DEFAULT_CUSTOMIZATION })
    expect(reset.view().revisions.map(item => [item.revision, item.source, item.by])).toEqual([
      [2, 'reset', 'cli'],
      [1, 'apply', 'device'],
    ])
    expect((await CustomizationStore.open(other)).state().revision).toBe(1)
    expect((await verifyAuditFile(join(dataDir, 'audit', 'audit.jsonl'))).ok).toBe(true)
    const records = (await readFile(join(dataDir, 'audit', 'audit.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { action: string; actor: unknown; detail: unknown })
      .filter(record => record.action === 'customization.applied')
    expect(records).toMatchObject([
      { actor: { listener: 'cli', via: 'cli' }, detail: { revision: 2, previous: 1, source: 'reset', fields: [] } },
    ])
  })

  it('says so when the saved file could not be used and was kept aside', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-customization-cli-'))
    directories.push(root)
    const dataDir = join(root, 'data')
    await mkdir(dataDir, { recursive: true, mode: 0o700 })
    await writeFile(
      join(dataDir, 'policy.json'),
      JSON.stringify({ ...defaultPolicy(process.platform), presence: { backend: 'none', helperCdhash: null } }),
      {
        mode: 0o600,
      },
    )
    await writeFile(join(dataDir, 'customization.json'), '{', { mode: 0o600 })
    const { output, latch } = cli()
    expect(await latch('customization', 'reset', '--data-dir', dataDir)).toBe(0)
    expect(output.stdout).toMatch(/自定义文件无法使用，已按默认外观启动；原文件保留为 customization\.json\.unreadable-\d{8}T\d{9}Z。/u)
    expect((await readdir(dataDir)).filter(name => name.startsWith('customization.json.unreadable-'))).toHaveLength(1)
    expect((await CustomizationStore.open(dataDir)).state()).toEqual({ revision: 0, doc: DEFAULT_CUSTOMIZATION })
  })

  it('asks a running Host over host.sock and retries the same reset after an uncertain sync', async () => {
    const t = await startTestHost()
    hosts.push(t)
    await writeHostState(t.dataDir, {
      version: 2,
      pid: process.pid,
      hostId: t.host.hostId,
      instanceId: t.host.instanceId,
      socketPath: t.host.socketPath,
      loopbackOrigin: t.host.loopbackOrigin,
      tlsOrigin: t.host.tlsOrigin ?? null,
      startedAt: t.host.startedAt,
      dataDir: t.dataDir,
    })
    const owner = await t.enroll({ listener: 'unix' })
    await owner.json('customization', {
      method: 'POST',
      body: { requestId: randomUUID(), baseRevision: 0, doc: doc({ textSize: 'large' }) },
    })
    const { output, latch } = cli()
    const interrupted = await failFirstDirectorySync(t.dataDir)
    expect(await latch('customization', 'reset', '--data-dir', t.dataDir)).toBe(0)
    expect(interrupted).toHaveBeenCalledOnce()
    expect(output.stdout).toContain('外观已恢复默认（版本 2）')
    expect((await owner.json<AppSnapshot>('snapshot')).customization).toEqual({ revision: 2, doc: DEFAULT_CUSTOMIZATION })
  })
})
