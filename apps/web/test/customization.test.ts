import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  ACCENT_DEFAULTS,
  CUSTOMIZATION_INK,
  CUSTOMIZATION_SURFACES,
  CUSTOMIZATION_WORK_SURFACES,
  CUSTOMIZATION_TYPE_ROLES,
  STATE_COLOURS,
  resolvableTokens,
  resolveAppearance,
  type CustomizationDocument,
} from '@latch/protocol'
import { CUSTOM_LAYER, CUSTOM_TOKENS } from '@latch/ui'
import { ApiError, NoAnswerError } from '../src/core/api.ts'
import { CustomizationWrites, type CustomizationActions } from '../src/core/customization.ts'
import { SafeModeBanner } from '../src/components/SafeModeBanner.tsx'
import {
  CustomizationBoot,
  READY_MS,
  SHEET_SKELETON,
  identityOf,
  isSafeModeKeys,
  sheetPlan,
  type BootEnvironment,
} from '../src/core/customBoot.ts'
import { CustomizationSettings, documentOf } from '../src/settings/CustomizationSettings.tsx'

const tokens = readFileSync('packages/ui/src/tokens.css', 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '')
/** The declarations of the first `<selector> {` block after `from`. */
function block(selector: string, from = 0): Map<string, string> {
  const start = tokens.indexOf(`${selector} {`, from)
  const body = tokens.slice(tokens.indexOf('{', start) + 1, tokens.indexOf('}', start))
  return new Map([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/gu)].map(match => [match[1]!, match[2]!.replace(/\s+/gu, ' ').trim()]))
}
const light = block(':root')
const dark = new Map([...light, ...block(":root[data-theme='dark']")])
const phone = block(':root', tokens.indexOf('@media (max-width: 767.98px)'))

describe('the values a customisation is expanded from', () => {
  it('are the design tokens: the accent family, the state colours and the surfaces, in both themes', () => {
    for (const [theme, values] of [
      ['light', light],
      ['dark', dark],
    ] as const) {
      const accent = ACCENT_DEFAULTS[theme]
      expect([accent.accent, accent.hover, accent.ink, accent.running]).toEqual(
        ['--accent', '--accent-hover', '--accent-ink', '--work-running'].map(name => values.get(name)),
      )
      const rgba = (hex: string, alpha: number) => `rgba(${[1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16)).join(', ')}, ${alpha})`
      expect(rgba(accent.soft.base, accent.soft.alpha)).toBe(values.get('--accent-soft'))
      // Only the light theme tints the primary button's shadow with the accent; the dark one's is black.
      if (accent.shadow) expect(values.get('--sh-accent')).toContain(rgba(accent.shadow.base, accent.shadow.alpha))
      // The dark theme's is black whatever the accent, and a document says it in full.
      else expect(accent.plainShadow).toBe(values.get('--sh-accent'))
      expect(CUSTOMIZATION_INK[theme]).toBe(values.get('--ink'))
      expect(Object.entries(CUSTOMIZATION_WORK_SURFACES[theme])).toEqual(
        Object.keys(CUSTOMIZATION_WORK_SURFACES[theme]).map(name => [name, values.get(`--${name}`)]),
      )
      const state = STATE_COLOURS[theme]
      expect([state.amber, state.amberIcon, state.red, state.green]).toEqual(
        ['--amber', '--amber-icon', '--red', '--green'].map(name => values.get(name)),
      )
      expect(Object.entries(CUSTOMIZATION_SURFACES[theme]).map(([name, value]) => [name, value])).toEqual(
        Object.keys(CUSTOMIZATION_SURFACES[theme]).map(name => [name, values.get(`--${name}`)]),
      )
    }
  })

  it('are the type roles at their sizes, on wide windows and on phones', () => {
    for (const role of CUSTOMIZATION_TYPE_ROLES) {
      expect(
        [role.size, ...role.lines].map(name => light.get(name)),
        role.size,
      ).toEqual(role.wide.map(px => `${px}px`))
      const onPhone = [role.size, ...role.lines].filter(name => phone.has(name))
      if (role.phone)
        expect(
          [role.size, ...role.lines].map(name => phone.get(name) ?? light.get(name)),
          role.size,
        ).toEqual(role.phone.map(px => `${px}px`))
      else expect(onPhone, role.size).toEqual([])
    }
  })

  it('reach the page only as tokens a customisation may set, every one of which some document sets', () => {
    expect(resolvableTokens()).toEqual([...CUSTOM_TOKENS].toSorted())
    const plan = sheetPlan(
      {
        base: { '--r-8': '12px', '--amber': '#00ff00', display: 'none', '--sp-8': '0px' },
        light: { '--accent': '#123456', '--red': '#00ff00' },
        dark: { '--accent': '#654321', '--scrim': 'transparent' },
        phone: { '--fs-input': '17px', opacity: '0' },
      },
      new Set(CUSTOM_TOKENS),
    )
    expect(plan).toEqual([
      [
        ['--r-8', '12px'],
        ['--accent', '#123456'],
      ],
      [['--fs-input', '17px']],
      [['--accent', '#654321']],
      [['--accent', '#654321']],
    ])
    // The stylesheet's selectors are a constant: the root, and nothing a document supplies.
    expect(CUSTOM_LAYER).toBe('custom')
    expect(SHEET_SKELETON).toBe(
      "@layer custom { :root {} @media (max-width: 767.98px) { :root {} } @media (prefers-color-scheme: dark) { :root:not([data-theme='light']) {} } :root[data-theme='dark'] {} }",
    )
  })
})

type Declarations = Array<[string, string]>
function fakeSheet() {
  const rule = () => {
    const set: Declarations = []
    return { set, style: { setProperty: (name: string, value: string) => set.push([name, value]) } }
  }
  const rules = [rule(), rule(), rule(), rule()]
  return {
    text: '',
    rules,
    replaceSync(text: string) {
      this.text = text
    },
    cssRules: [{ cssRules: [rules[0], { cssRules: [rules[1]] }, { cssRules: [rules[2]] }, rules[3]] }],
  }
}

function page(
  options: { storage?: Record<string, string>; hash?: string; sheets?: boolean; brokenStorage?: boolean; tokens?: readonly string[] } = {},
) {
  const values = new Map(Object.entries(options.storage ?? {}))
  const handlers = new Map<string, (event: unknown) => void>()
  const timers: Array<{ run: () => void; ms: number; cleared: boolean }> = []
  let adopted: unknown[] = ['other']
  const location = { hash: options.hash ?? '', pathname: '/link/', search: '' }
  const urls: string[] = []
  const made: Array<ReturnType<typeof fakeSheet>> = []
  const env: BootEnvironment = {
    tokens: new Set(options.tokens ?? CUSTOM_TOKENS),
    storage: options.brokenStorage
      ? {
          getItem: () => {
            throw new Error('blocked')
          },
          setItem: () => {
            throw new Error('blocked')
          },
          removeItem: () => {
            throw new Error('blocked')
          },
        }
      : {
          getItem: key => values.get(key) ?? null,
          setItem: (key, value) => void values.set(key, value),
          removeItem: key => void values.delete(key),
        },
    location,
    replaceUrl(url) {
      urls.push(url)
      location.hash = url.includes('#') ? url.slice(url.indexOf('#')) : ''
    },
    root: { dataset: {} },
    createSheet() {
      if (options.sheets === false) return null
      const sheet = fakeSheet()
      made.push(sheet)
      return sheet
    },
    adopted: () => [...adopted],
    adopt(sheets) {
      adopted = sheets
    },
    listen: (type, handler) => void handlers.set(type, handler),
    setTimer(run, ms) {
      const timer = { run, ms, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimer(timer) {
      if (timer) (timer as { cleared: boolean }).cleared = true
    },
  }
  const boot = new CustomizationBoot(env)
  return {
    boot,
    /** A snapshot from the Host, `host-a` unless another is named. */
    host: (state: Parameters<CustomizationBoot['hostState']>[0], hostId = 'host-a') => boot.hostState(state, hostId),
    values,
    urls,
    made,
    location,
    fire: (type: string, event: unknown = {}) => handlers.get(type)?.(event),
    /** Runs the timers still armed. */
    elapse: () => {
      for (const timer of timers.splice(0)) if (!timer.cleared) timer.run()
    },
    timers,
    /** The customisation's sheet on the page, if one is adopted. */
    sheet: () => adopted.find(item => item !== 'other') as ReturnType<typeof fakeSheet> | undefined,
    others: () => adopted.filter(item => item === 'other').length,
  }
}

const doc = (appearance: CustomizationDocument['appearance']): CustomizationDocument => ({ schema: 1, appearance })
const DOC_KEY = 'latch.customization.doc.host-a'
/** What a page that showed `host-a` at this revision left behind. */
const cached = (revision: number, value: unknown) => ({
  'latch.customization.host': 'host-a',
  [DOC_KEY]: JSON.stringify({ revision, doc: value }),
})
const at = (revision: number, value: CustomizationDocument, hostId = 'host-a') => identityOf(hostId, { revision, doc: value })
const KEYS = { code: 'Digit0', altKey: true, shiftKey: true, metaKey: true }

describe('the boot guard and safe mode', () => {
  it('shows the cached document before the first render and counts the load as finished two seconds after the page drew', () => {
    const p = page({ storage: cached(4, doc({ accentHue: 300, radius: 'round', textSize: 'large' })) })
    p.boot.start()
    expect(p.boot.status().safe).toBeNull()
    const sheet = p.sheet()!
    expect(sheet.text).toBe(SHEET_SKELETON)
    const [lightRule, phoneRule, darkSystem, darkChosen] = sheet.rules
    expect(lightRule!.set.map(([name]) => name)).toEqual(expect.arrayContaining(['--accent', '--r-8', '--fs-ui']))
    expect(phoneRule!.set.find(([name]) => name === '--fs-input')).toEqual(['--fs-input', '17px'])
    expect(darkSystem!.set).toEqual(darkChosen!.set)
    expect(darkSystem!.set.map(([name]) => name)).toContain('--accent')
    for (const rule of sheet.rules) expect(rule.set.every(([name]) => (CUSTOM_TOKENS as readonly string[]).includes(name))).toBe(true)
    // The page's other stylesheets stay.
    expect(p.others()).toBe(1)
    // Until the page has drawn and stayed up, the load is not finished.
    const shown = at(4, doc({ accentHue: 300, radius: 'round', textSize: 'large' }))
    expect(p.values.get('latch.customization.applying')).toBe(shown)
    p.elapse()
    expect(p.values.get('latch.customization.applying')).toBe(shown)
    p.boot.markRendered()
    expect(p.timers.at(-1)!.ms).toBe(READY_MS)
    p.elapse()
    expect(p.values.has('latch.customization.applying')).toBe(false)
  })

  it('shows the default when the last load never finished, until the Host has another document', () => {
    const p = page({ storage: { ...cached(4, doc({ accentHue: 300 })), 'latch.customization.applying': at(4, doc({ accentHue: 300 })) } })
    p.boot.start()
    expect(p.boot.status().safe).toBe('guard')
    expect(p.sheet()).toBeUndefined()
    expect(p.values.has('latch.customization.applying')).toBe(false)
    // The same revision again: still the default, on every later load too.
    p.host({ revision: 4, doc: doc({ accentHue: 300 }) })
    expect([p.boot.status().safe, p.sheet()]).toEqual(['guard', undefined])
    const again = page({ storage: Object.fromEntries(p.values) })
    again.boot.start()
    expect([again.boot.status().safe, again.sheet()]).toEqual(['guard', undefined])
    // Another revision is tried.
    p.host({ revision: 5, doc: doc({ accentHue: 240 }) })
    expect(p.boot.status().safe).toBeNull()
    expect(p.sheet()!.rules[0]!.set.map(([name]) => name)).toContain('--accent')
    expect(p.values.has('latch.customization.safe')).toBe(false)
  })

  it('leaves safe mode when the Host is back at the default, which is what 恢复默认 writes', () => {
    const p = page({ storage: { 'latch.customization.applying': at(4, doc({ accentHue: 300 })) } })
    p.boot.start()
    p.host({ revision: 4, doc: doc({ accentHue: 300 }) })
    expect(p.boot.status().safe).toBe('guard')
    p.host({ revision: 5, doc: doc({}) })
    expect([p.boot.status().safe, p.sheet()]).toEqual([null, undefined])
  })

  it('shows the default when the stored document fails the rules, and the Host document when that one passes', () => {
    for (const bad of [
      { schema: 1, appearance: { css: 'body{display:none}' } },
      { schema: 9, appearance: {} },
      doc({ accentHue: 60 }),
      'x',
    ])
      for (const raw of [JSON.stringify({ revision: 2, doc: bad }), '{', '[]']) {
        const p = page({ storage: { 'latch.customization.host': 'host-a', [DOC_KEY]: raw } })
        p.boot.start()
        expect([p.boot.status().safe, p.sheet(), p.values.has(DOC_KEY)], raw).toEqual(['invalid', undefined, false])
        p.host({ revision: 2, doc: doc({ radius: 'sharp' }) })
        expect(p.boot.status().safe).toBeNull()
        expect(p.sheet()!.rules[0]!.set).toEqual(expect.arrayContaining([['--r-8', '6px']]))
      }
    // A Host document this page's rules refuse is not shown either, whatever its revision.
    const p = page()
    p.boot.start()
    p.host({ revision: 3, doc: { schema: 1, appearance: { accentHue: 60 } } })
    expect([p.boot.status().safe, p.sheet(), p.values.has(DOC_KEY)]).toEqual(['invalid', undefined, false])
    p.host({ revision: 4, doc: { schema: 2, appearance: {} } as never })
    expect(p.boot.status().safe).toBe('invalid')
  })

  it('enters safe mode from /link/#safe and takes the fragment out of the address, at load and later', () => {
    const p = page({ storage: cached(4, doc({ accentHue: 300 })), hash: '#safe' })
    p.boot.start()
    expect([p.boot.status().safe, p.sheet(), p.urls, p.location.hash]).toEqual(['link', undefined, ['/link/'], ''])
    // Whatever else the fragment holds is left for its reader.
    const mixed = page({ hash: '#safe&pair=abc' })
    mixed.boot.start()
    expect(mixed.urls).toEqual(['/link/#pair=abc'])
    // A fragment that is not `safe` is not touched.
    const other = page({ storage: cached(4, doc({ accentHue: 300 })), hash: '#pair=abc' })
    other.boot.start()
    expect([other.boot.status().safe, other.urls]).toEqual([null, []])
    // The desktop menu sets the fragment on a page that is already open.
    other.location.hash = '#safe'
    other.fire('hashchange')
    expect([other.boot.status().safe, other.sheet(), other.location.hash]).toEqual(['link', undefined, ''])
    expect(JSON.parse(other.values.get('latch.customization.safe')!)).toEqual({ reason: 'link', identity: null })
  })

  it('enters and leaves safe mode on ⌘⌥⇧0 or Ctrl+Alt+Shift+0, and on nothing less', () => {
    expect(isSafeModeKeys(KEYS)).toBe(true)
    expect(isSafeModeKeys({ code: 'Digit0', altKey: true, shiftKey: true, ctrlKey: true })).toBe(true)
    for (const less of [
      { ...KEYS, altKey: false },
      { ...KEYS, shiftKey: false },
      { ...KEYS, metaKey: false },
      { ...KEYS, code: 'Digit1' },
      { ...KEYS, code: 'Numpad0' },
    ])
      expect(isSafeModeKeys(less)).toBe(false)
    const p = page()
    p.boot.start()
    p.host({ revision: 7, doc: doc({ accentHue: 300 }) })
    expect(p.sheet()).toBeDefined()
    let prevented = 0
    const press = (event: object) => p.fire('keydown', { ...event, preventDefault: () => prevented++ })
    press({ ...KEYS, shiftKey: false })
    expect(p.boot.status().safe).toBeNull()
    press(KEYS)
    expect([p.boot.status().safe, p.sheet(), prevented]).toEqual(['keys', undefined, 1])
    expect(JSON.parse(p.values.get('latch.customization.safe')!)).toEqual({ reason: 'keys', identity: at(7, doc({ accentHue: 300 })) })
    // The next snapshot of the same revision does not put it back.
    p.host({ revision: 7, doc: doc({ accentHue: 300 }) })
    expect(p.sheet()).toBeUndefined()
    // The same keys again return to the Host's document.
    press(KEYS)
    expect(p.boot.status().safe).toBeNull()
    expect(p.sheet()).toBeDefined()
  })

  it('has nothing to step back from while the Host is at the default: the keys only take a preview off the page', () => {
    const p = page()
    p.boot.start()
    p.host({ revision: 3, doc: doc({}) })
    p.boot.setPreview(doc({ radius: 'round' }))
    expect(p.sheet()).toBeDefined()
    p.fire('keydown', KEYS)
    expect([p.boot.status().safe, p.boot.status().preview, p.sheet(), p.values.has('latch.customization.safe')]).toEqual([
      null,
      null,
      undefined,
      false,
    ])
    p.location.hash = '#safe'
    p.fire('hashchange')
    expect([p.boot.status().safe, p.location.hash]).toEqual([null, ''])
  })

  it('counts a page that drew and was then closed as finished, and one that never drew as not', () => {
    const closed = page({ storage: cached(4, doc({ accentHue: 300 })) })
    closed.boot.start()
    closed.fire('pagehide')
    expect(closed.values.get('latch.customization.applying')).toBe(at(4, doc({ accentHue: 300 })))
    closed.boot.markRendered()
    closed.fire('pagehide')
    expect(closed.values.has('latch.customization.applying')).toBe(false)
  })

  it('previews a document on this page only, and never one the rules refuse or while in safe mode', () => {
    const p = page()
    p.boot.start()
    p.boot.markRendered()
    p.host({ revision: 2, doc: doc({ radius: 'sharp' }) })
    p.elapse()
    const before = Object.fromEntries(p.values)
    p.boot.setPreview(doc({ radius: 'round' }))
    expect(p.sheet()!.rules[0]!.set).toEqual(expect.arrayContaining([['--r-8', '12px']]))
    expect(p.boot.status().preview).toEqual(doc({ radius: 'round' }))
    // Nothing of a preview is stored: a reload shows the Host's document.
    expect(Object.fromEntries(p.values)).toEqual(before)
    // A snapshot that arrives meanwhile does not take the preview off the page.
    p.host({ revision: 3, doc: doc({ radius: 'default' }) })
    expect(p.sheet()!.rules[0]!.set).toEqual(expect.arrayContaining([['--r-8', '12px']]))
    p.boot.setPreview(null)
    expect([p.sheet(), p.boot.status().preview]).toEqual([undefined, null])
    p.boot.setPreview(doc({ accentHue: 60 }))
    expect([p.sheet(), p.boot.status().preview]).toEqual([undefined, null])
    p.host({ revision: 4, doc: doc({ radius: 'sharp' }) })
    p.boot.enterSafeMode('keys')
    p.boot.setPreview(doc({ radius: 'round' }))
    expect([p.boot.status().safe, p.sheet()]).toEqual(['keys', undefined])
  })

  it('takes the Host as the authority over the cache: the same revision number with another document is replaced', () => {
    // The cache says revision 4 is purple; the Host's revision 4 is round corners and nothing else.
    const p = page({ storage: cached(4, doc({ accentHue: 300 })) })
    p.boot.start()
    expect(p.sheet()!.rules[0]!.set.map(([name]) => name)).toContain('--accent')
    p.host({ revision: 4, doc: doc({ radius: 'round' }) })
    const names = p.sheet()!.rules[0]!.set.map(([name]) => name)
    expect([names.includes('--accent'), names.includes('--r-8')]).toEqual([false, true])
    expect(JSON.parse(p.values.get(DOC_KEY)!)).toEqual({ revision: 4, doc: doc({ radius: 'round' }) })
    // The same document under another spelling is the same document: nothing is rewritten.
    const made = p.made.length
    p.host({ revision: 4, doc: { appearance: { radius: 'round' }, schema: 1 } })
    expect(p.made).toHaveLength(made)
  })

  it('does not keep a planted document: revision 0 with a look, against a Host that has never had one', () => {
    const p = page({ storage: cached(0, doc({ accentHue: 300, textSize: 'large' })) })
    p.boot.start()
    expect(p.sheet()).toBeDefined()
    p.host({ revision: 0, doc: doc({}) })
    p.boot.markRendered()
    p.elapse()
    expect([p.sheet(), p.boot.status().safe]).toEqual([undefined, null])
    expect(JSON.parse(p.values.get(DOC_KEY)!)).toEqual({ revision: 0, doc: doc({}) })
    // And the next load starts from what the Host said.
    const next = page({ storage: Object.fromEntries(p.values) })
    next.boot.start()
    expect(next.sheet()).toBeUndefined()
  })

  it('keeps two Hosts on one address apart: each has its own cache, and one Host’s revision says nothing about the other’s', () => {
    const p = page()
    p.boot.start()
    p.host({ revision: 2, doc: doc({ radius: 'round' }) }, 'host-a')
    expect(p.sheet()!.rules[0]!.set).toEqual(expect.arrayContaining([['--r-8', '12px']]))
    // The other Host is at the same revision number with another document: its document is shown, not the first one's.
    p.host({ revision: 2, doc: doc({ radius: 'sharp' }) }, 'host-b')
    expect(p.sheet()!.rules[0]!.set).toEqual(expect.arrayContaining([['--r-8', '6px']]))
    expect(JSON.parse(p.values.get(DOC_KEY)!)).toEqual({ revision: 2, doc: doc({ radius: 'round' }) })
    expect(JSON.parse(p.values.get('latch.customization.doc.host-b')!)).toEqual({ revision: 2, doc: doc({ radius: 'sharp' }) })
    expect(p.values.get('latch.customization.host')).toBe('host-b')
    p.boot.markRendered()
    p.elapse()
    // A load opens with the last Host's document, and the first Host replaces it when it is the one that answers.
    const next = page({ storage: Object.fromEntries(p.values) })
    next.boot.start()
    expect(next.sheet()!.rules[0]!.set).toEqual(expect.arrayContaining([['--r-8', '6px']]))
    next.host({ revision: 2, doc: doc({ radius: 'round' }) }, 'host-a')
    expect(next.sheet()!.rules[0]!.set).toEqual(expect.arrayContaining([['--r-8', '12px']]))
    // Safe mode is one Host's too: ignoring host-a's revision 2 does not hide host-b's.
    next.fire('keydown', KEYS)
    expect(next.boot.status().safe).toBe('keys')
    next.host({ revision: 2, doc: doc({ radius: 'sharp' }) }, 'host-b')
    expect(next.boot.status().safe).toBeNull()
    expect(next.sheet()!.rules[0]!.set).toEqual(expect.arrayContaining([['--r-8', '6px']]))
    // A name that could not be a Host's is never used as a storage key.
    const odd = page()
    odd.boot.start()
    odd.host({ revision: 1, doc: doc({ radius: 'round' }) }, '../x y')
    expect([...odd.values.keys()].filter(key => key.startsWith('latch.customization.doc'))).toEqual([])
    expect(odd.sheet()).toBeDefined()
  })

  it('follows the Host: a new revision replaces the sheet, the default removes it, an older Host clears everything', () => {
    const p = page()
    p.boot.start()
    p.host({ revision: 1, doc: doc({ radius: 'sharp' }) })
    const first = p.sheet()
    expect(first!.rules[0]!.set).toEqual(expect.arrayContaining([['--r-8', '6px']]))
    p.host({ revision: 1, doc: doc({ radius: 'sharp' }) })
    expect(p.sheet()).toBe(first)
    expect(p.made).toHaveLength(1)
    p.host({ revision: 2, doc: doc({ radius: 'round' }) })
    expect(p.sheet()!.rules[0]!.set).toEqual(expect.arrayContaining([['--r-8', '12px']]))
    p.host({ revision: 3, doc: doc({}) })
    expect(p.sheet()).toBeUndefined()
    expect(JSON.parse(p.values.get(DOC_KEY)!)).toEqual({ revision: 3, doc: doc({}) })
    p.host(undefined)
    expect([p.values.has(DOC_KEY), p.values.has('latch.customization.host'), p.boot.status().host]).toEqual([false, false, null])
    expect(p.others()).toBe(1)
  })

  it('writes nothing it was not told it may: a page that knows no customisable token keeps every one at its default', () => {
    const p = page({ tokens: ['--accent'] })
    p.boot.start()
    p.host({ revision: 1, doc: doc({ accentHue: 300, radius: 'round', textSize: 'large' }) })
    expect(p.sheet()!.rules.map(rule => rule.set.map(([name]) => name))).toEqual([['--accent'], [], ['--accent'], ['--accent']])
    const none = page({ tokens: [] })
    none.boot.start()
    none.host({ revision: 1, doc: doc({ accentHue: 300, radius: 'round' }) })
    expect(none.sheet()!.rules.every(rule => rule.set.length === 0)).toBe(true)
  })

  it('starts with the default look where the browser has no constructed stylesheets or no storage, without failing', () => {
    const plain = page({ storage: cached(4, doc({ accentHue: 300 })), sheets: false })
    plain.boot.start()
    expect([plain.boot.status().safe, plain.sheet()]).toEqual([null, undefined])
    const blocked = page({ brokenStorage: true, hash: '#safe' })
    expect(() => blocked.boot.start()).not.toThrow()
    expect(blocked.boot.status().safe).toBe('link')
    blocked.host({ revision: 1, doc: doc({ accentHue: 300 }) })
    expect(blocked.sheet()).toBeUndefined()
  })
})

const idleWriter: CustomizationActions = {
  pending: undefined,
  submit: async () => ({ kind: 'busy' }),
  retry: async () => ({ kind: 'busy' }),
  abandon: () => {},
}

describe('appearance writes', () => {
  const owner = { hostId: 'host-a', deviceId: 'device-a' }

  it('retries the original immutable operation for the same Host and device after a later denial', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new NoAnswerError())
      .mockRejectedValueOnce(new ApiError(403, 'scope-required', '权限已收紧'))
      .mockResolvedValueOnce(undefined)
    const manager = new CustomizationWrites(send)
    const doc: CustomizationDocument = { schema: 1, appearance: { radius: 'round' } }
    await expect(manager.submit(owner, { kind: 'apply', doc }, 6)).resolves.toEqual({ kind: 'unknown' })
    const request = manager.read(owner)?.request
    expect(request).toEqual({
      kind: 'apply',
      doc: { schema: 1, appearance: { radius: 'round' } },
      baseRevision: 6,
      requestId: expect.any(String),
    })

    doc.appearance.radius = 'sharp'
    const otherHost = { ...owner, hostId: 'host-b' }
    const otherDevice = { ...owner, deviceId: 'device-b' }
    for (const other of [otherHost, otherDevice]) {
      expect(manager.read(other)).toBeUndefined()
      await expect(manager.retry(other)).resolves.toEqual({ kind: 'busy' })
      manager.abandon(other)
    }
    await expect(manager.submit(owner, { kind: 'reset' }, 11)).resolves.toEqual({ kind: 'busy' })
    await expect(manager.retry({ ...owner })).resolves.toEqual({ kind: 'unknown' })
    expect(manager.read(owner)).toMatchObject({ request, unknown: { retryable: true, text: '权限已收紧' } })
    await expect(manager.retry({ ...owner })).resolves.toEqual({ kind: 'done' })
    expect(send.mock.calls).toEqual([[request], [request], [request]])
    expect(request).toMatchObject({ doc: { appearance: { radius: 'round' } } })
    expect(manager.read(owner)).toBeUndefined()
  })

  it('keeps a reset with an expired receipt unknown until the person abandons it', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(503, 'customization-write-pending', '这次没有提交'))
      .mockRejectedValueOnce(new ApiError(503, 'customization-write-unknown', '没有收到结果'))
      .mockRejectedValueOnce(new ApiError(409, 'customization-conflict', '已变化'))
    const manager = new CustomizationWrites(send)
    await expect(manager.submit(owner, { kind: 'reset' }, 6)).resolves.toEqual({ kind: 'refused', text: '这次没有提交' })
    await expect(manager.submit(owner, { kind: 'reset' }, 8)).resolves.toEqual({ kind: 'unknown' })
    const original = manager.read(owner)?.request
    expect(original).toMatchObject({ kind: 'reset', baseRevision: 8 })
    await expect(manager.retry(owner)).resolves.toEqual({ kind: 'unknown' })
    expect(manager.read(owner)?.unknown?.retryable).toBe(false)
    await expect(manager.retry(owner)).resolves.toEqual({ kind: 'busy' })
    expect(send.mock.calls.slice(1)).toEqual([[original], [original]])
    manager.abandon(owner)
    expect(manager.read(owner)).toBeUndefined()
  })
})

describe('the safe mode banner and the settings', () => {
  it('says 默认外观 with one action, pinned and not a security surface', () => {
    const admin = renderToStaticMarkup(
      createElement(SafeModeBanner, { admin: true, computer: '这台 Mac', onChanged: () => {}, writer: idleWriter, baseRevision: 0 }),
    )
    expect(admin).toContain('class="safe-banner" data-lock=""')
    expect(admin).not.toContain('data-secure')
    expect(
      admin
        .replace(/<[^>]+>/gu, '|')
        .split('|')
        .filter(Boolean),
    ).toEqual(['默认外观', '恢复默认'])
    expect(admin.match(/<button/gu)).toHaveLength(1)
    // A device that cannot change the Host says where to do it.
    const phone = renderToStaticMarkup(
      createElement(SafeModeBanner, { admin: false, computer: '工作电脑', onChanged: () => {}, writer: idleWriter }),
    )
    expect(
      phone
        .replace(/<[^>]+>/gu, '|')
        .split('|')
        .filter(Boolean),
    ).toEqual(['默认外观', '在 工作电脑 上恢复'])
    expect(phone).not.toContain('<button')
  })

  it('keeps the shared unknown request recoverable in either entry after scope is lost', () => {
    const notify = () => {}
    const writer: CustomizationActions = {
      pending: {
        request: { kind: 'reset' as const, baseRevision: 6, requestId: 'original-request' },
        sending: false,
        unknown: { retryable: true, text: '权限已收紧' },
      },
      submit: idleWriter.submit,
      retry: idleWriter.retry,
      abandon: notify,
    }
    const bannerProps = { admin: false, computer: '工作电脑', onChanged: notify, writer, baseRevision: 10 }
    const settingsProps = { admin: false, onChanged: notify, writer }
    const entries = [
      renderToStaticMarkup(createElement(SafeModeBanner, bannerProps)),
      renderToStaticMarkup(createElement(CustomizationSettings, settingsProps)),
    ]
    for (const html of entries) {
      expect(html).toContain('结果未知')
      expect(html).toContain('放弃等待')
      expect(html).not.toContain('重试同一请求')
      expect(html).not.toContain('恢复默认</button>')
    }
  })

  it('offers three appearance rows under 自定义, with 应用 and 恢复默认', () => {
    const html = renderToStaticMarkup(createElement(CustomizationSettings, { admin: true, writer: idleWriter, onChanged: () => {} }))
    // 恢复默认 and 应用 sit on a security surface: no customisation changes how the way back looks.
    expect(html).toMatch(/<div class="custom-foot" data-secure="">.*恢复默认.*应用/u)
    const words = html
      .replace(/<[^>]+>/gu, '|')
      .split('|')
      .filter(Boolean)
    expect(words).toEqual(['自定义', '所有设备', '主色', '圆角', '方', '默认', '圆', '字号', '小', '默认', '大', '恢复默认', '应用'])
    // Seven swatches: the default and six hues from teal to magenta, none of them near amber, red or green.
    expect(html.match(/class="custom-hue"/gu)).toHaveLength(7)
    expect(html).toContain('aria-label="青"')
    expect(html).not.toContain('苔绿')
  })

  it('leaves a default choice out of the document, so every default spelling is the empty appearance', () => {
    expect(documentOf({ radius: 'default', textSize: 'default' })).toEqual({
      schema: 1,
      appearance: {},
    })
    expect(documentOf({ accentHue: 300, radius: 'round', textSize: 'default' })).toEqual({
      schema: 1,
      appearance: { accentHue: 300, radius: 'round' },
    })
  })
})
