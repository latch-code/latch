import {
  isDefaultCustomization,
  parseCustomization,
  resolveAppearance,
  type CustomizationDocument,
  type CustomizationState,
  type ResolvedAppearance,
} from '@latch/protocol'

/*
 * The Host's customisation on this page, and the way out of it. This module does not need React to be alive: it is
 * started before the first render (main.tsx), applies the last document this device saw so the page does not change
 * its look once the Host answers, and listens for the keys and the address that put the page back to the default.
 *
 * A document reaches the page as values of the design system's CUSTOM_TOKENS in one generated stylesheet, in the
 * `custom` layer, on the root. The stylesheet's selectors are the constant below; values are set one property at a
 * time through the CSSOM, and a name that is not in CUSTOM_TOKENS is not written. No text from a document is ever
 * parsed as CSS.
 *
 * Safe mode is this device showing the default whatever the Host's document says. It starts when the cached document
 * fails the rules, when the last load put a document on and never got as far as a drawn page, on ⌘⌥⇧0 (Ctrl+Alt+Shift+0
 * elsewhere), and on `/link/#safe`. It ends when the Host's document changes or is the default again, or on the same
 * keys. Nothing is deleted, and nothing on the page waits for it.
 */

/** Why this device shows the default. `guard`: the last load did not finish. `invalid`: the document fails the rules. */
export type SafeReason = 'guard' | 'invalid' | 'keys' | 'link'

export interface CustomizationStatus {
  /** Set while this device shows the default instead of the Host's document. */
  safe: SafeReason | null
  /** The Host's state as the last snapshot gave it; null before one, or from a Host without customisation. */
  host: CustomizationState | null
  /** A document shown only on this page, not saved: 设置 › 自定义 before 应用. */
  preview: CustomizationDocument | null
}

/**
 * The cache: which Host this page showed last, and that Host's document under its own key. One address can serve
 * different Hosts over time (another data directory on the same port, the desktop app's one origin), and a document
 * cached for one of them says nothing about another.
 */
const CACHE_HOST_KEY = 'latch.customization.host'
const cacheKey = (hostId: string) => `latch.customization.doc.${hostId}`
const HOST_ID = /^[A-Za-z0-9_-]{1,128}$/u
/** Set before a document is put on the page and cleared once the page has drawn and stayed up. */
const APPLYING_KEY = 'latch.customization.applying'
const SAFE_KEY = 'latch.customization.safe'
/** How long a drawn page must stay up before the load counts as finished. */
export const READY_MS = 2_000

/**
 * The stylesheet every document is written into, in the design system's `custom` layer (CUSTOM_LAYER; this folder does
 * not import the design system, and a test keeps the two names equal). The four rules are, in order: light, phone,
 * dark by system, dark chosen.
 */
export const SHEET_SKELETON = `@layer custom { :root {} @media (max-width: 767.98px) { :root {} } @media (prefers-color-scheme: dark) { :root:not([data-theme='light']) {} } :root[data-theme='dark'] {} }`

type SheetPlan = [
  light: Array<[string, string]>,
  phone: Array<[string, string]>,
  darkSystem: Array<[string, string]>,
  darkChosen: Array<[string, string]>,
]

/** What goes into each of the skeleton's four rules: only the tokens a customisation may set (`allowed`, CUSTOM_TOKENS). */
export function sheetPlan(resolved: ResolvedAppearance, allowed: ReadonlySet<string>): SheetPlan {
  const entries = (table: Record<string, string>) => Object.entries(table).filter(([name]) => allowed.has(name))
  const dark = entries(resolved.dark)
  return [entries({ ...resolved.base, ...resolved.light }), entries(resolved.phone), dark, dark]
}

interface StyleRuleLike {
  style: { setProperty(name: string, value: string): void }
}
interface SheetLike {
  replaceSync(text: string): void
  cssRules: ArrayLike<unknown>
}

/** What the module touches of the page; tests pass their own. */
export interface BootEnvironment {
  /** The design system's CUSTOM_TOKENS: the only names ever written. Empty, nothing is. */
  tokens: ReadonlySet<string>
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null
  location: { hash: string; pathname: string; search: string }
  replaceUrl(url: string): void
  root: { dataset: Record<string, string | undefined> }
  /** A new constructed stylesheet, or null where the browser has none. */
  createSheet(): SheetLike | null
  adopted(): unknown[]
  adopt(sheets: unknown[]): void
  listen(type: 'keydown' | 'hashchange' | 'pagehide', handler: (event: unknown) => void): void
  setTimer(run: () => void, ms: number): unknown
  clearTimer(timer: unknown): void
}

function browserEnvironment(tokens: ReadonlySet<string>): BootEnvironment {
  let storage: Storage | null = null
  try {
    storage = localStorage
  } catch {
    /* Blocked storage: nothing is cached and safe mode lasts for this page only. */
  }
  return {
    tokens,
    storage,
    location,
    replaceUrl(url) {
      try {
        history.replaceState(history.state, '', url)
      } catch {
        /* The fragment is never sent to the server either way. */
      }
    },
    root: document.documentElement,
    createSheet() {
      try {
        return 'adoptedStyleSheets' in document ? new CSSStyleSheet() : null
      } catch {
        return null
      }
    },
    adopted: () => [...document.adoptedStyleSheets],
    adopt(sheets) {
      document.adoptedStyleSheets = sheets as CSSStyleSheet[]
    },
    // Capture, on the window: the keys work whatever has focus and whatever the page's own handlers do.
    listen: (type, handler) => window.addEventListener(type, handler as EventListener, { capture: true }),
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
  }
}

interface SafeRecord {
  reason: SafeReason
  /** What this device is ignoring (`identityOf`); null until a snapshot names it. */
  identity: string | null
}

/** JSON with every object's keys in order, so two spellings of one document compare equal. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .toSorted()
      .map(key => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * What exactly is on the page or being ignored: the Host, its revision and the document itself. A revision number
 * alone is not an identity: another Host counts from 1 too, and a cache can hold a document its number never had.
 */
export const identityOf = (hostId: string, state: CustomizationState): string => canonical([hostId, state.revision, state.doc])

/** ⌘⌥⇧0 on a Mac, Ctrl+Alt+Shift+0 elsewhere; either set of modifiers is accepted on every platform. */
export function isSafeModeKeys(event: {
  code?: string
  altKey?: boolean
  shiftKey?: boolean
  metaKey?: boolean
  ctrlKey?: boolean
}): boolean {
  return event.code === 'Digit0' && event.altKey === true && event.shiftKey === true && (event.metaKey === true || event.ctrlKey === true)
}

export class CustomizationBoot {
  private env: BootEnvironment
  private sheet: unknown = null
  private safe: SafeRecord | null = null
  private host: CustomizationState | null = null
  private preview: CustomizationDocument | null = null
  private hostId = ''
  /** What the sheet on the page shows (`identityOf`); null with none or with a preview. */
  private shown: string | null = null
  private rendered = false
  private readyTimer: unknown = null
  private listeners = new Set<() => void>()
  private snapshot: CustomizationStatus = { safe: null, host: null, preview: null }

  constructor(env: BootEnvironment) {
    this.env = env
  }

  /** Before the first render: the address, the guard, the keys, then the cached document. Never throws. */
  start(): void {
    try {
      this.safe = this.readSafe()
      if (this.takeFragment()) this.safe = { reason: 'link', identity: null }
      const unfinished = this.read(APPLYING_KEY)
      if (unfinished !== null) {
        // The last load put a document on and never said it had drawn: this device shows the default until it changes.
        this.safe = { reason: 'guard', identity: unfinished }
        this.write(APPLYING_KEY, null)
      }
      this.env.listen('keydown', event => {
        if (!isSafeModeKeys(event as KeyboardEvent)) return
        ;(event as KeyboardEvent).preventDefault?.()
        if (this.safe) this.leaveSafeMode()
        else this.enterSafeMode('keys')
      })
      this.env.listen('hashchange', () => {
        if (this.takeFragment()) this.enterSafeMode('link')
      })
      // A page that drew and is then closed or reloaded finished its load; one that hung never gets here.
      this.env.listen('pagehide', () => {
        if (this.rendered) this.write(APPLYING_KEY, null)
      })
      if (this.safe) this.write(SAFE_KEY, JSON.stringify(this.safe))
      else this.applyCached()
    } catch {
      this.remove()
    }
    this.publish()
  }

  /** The page has drawn something (any screen). The load counts as finished once it has stayed up for two seconds. */
  markRendered(): void {
    if (this.rendered) return
    this.rendered = true
    this.armReady()
  }

  private armReady(): void {
    if (!this.rendered) return
    this.env.clearTimer(this.readyTimer)
    this.readyTimer = this.env.setTimer(() => {
      this.write(APPLYING_KEY, null)
    }, READY_MS)
  }

  /**
   * Every snapshot: the Host it came from and that Host's document, or undefined from a Host without customisation.
   * The Host is the authority: whatever the cache put on the page is replaced unless it is this Host, this revision
   * and this very document.
   */
  hostState(state: CustomizationState | undefined, hostId: string): void {
    // The same state again keeps the object the page already holds, so nothing that reads it renders again.
    const same = state && this.host && hostId === this.hostId && identityOf(hostId, state) === identityOf(hostId, this.host)
    this.host = same ? this.host : (state ?? null)
    this.hostId = hostId
    const known = HOST_ID.test(hostId)
    if (!state) {
      this.safe = null
      this.write(SAFE_KEY, null)
      if (known) this.write(cacheKey(hostId), null)
      this.write(CACHE_HOST_KEY, null)
      this.remove()
      this.publish()
      return
    }
    const doc = parseCustomization(state.doc)
    const identity = identityOf(hostId, state)
    if (this.safe) {
      if (this.safe.reason !== 'invalid' && this.safe.identity === null) this.safe = { ...this.safe, identity }
      const stays =
        this.safe.reason === 'invalid' ? doc === null : this.safe.identity === identity && doc !== null && !isDefaultCustomization(doc)
      if (stays) {
        this.write(SAFE_KEY, JSON.stringify(this.safe))
        this.remove()
        this.publish()
        return
      }
      this.safe = null
      this.write(SAFE_KEY, null)
    }
    if (doc === null) {
      // A document this page's rules refuse (a newer schema, a rule the Host does not have) is not shown.
      this.safe = { reason: 'invalid', identity }
      this.write(SAFE_KEY, JSON.stringify(this.safe))
      if (known) this.write(cacheKey(hostId), null)
      this.remove()
      this.publish()
      return
    }
    if (known) {
      this.write(cacheKey(hostId), JSON.stringify({ revision: state.revision, doc }))
      this.write(CACHE_HOST_KEY, hostId)
    }
    if (this.preview === null && this.shown !== identity) this.show(doc, identity, true)
    this.publish()
  }

  /** Shows a document on this page only, or goes back to the Host's with null. Nothing is saved or cached. */
  setPreview(doc: CustomizationDocument | null): void {
    if (this.safe) return
    const checked = doc === null ? null : parseCustomization(doc)
    this.preview = checked
    if (checked) this.show(checked, null, false)
    else {
      const host = this.host && parseCustomization(this.host.doc)
      if (host && this.host) this.show(host, identityOf(this.hostId, this.host), false)
      else this.remove()
    }
    this.publish()
  }

  enterSafeMode(reason: SafeReason): void {
    const hostDoc = this.host && parseCustomization(this.host.doc)
    if (hostDoc && isDefaultCustomization(hostDoc)) {
      // The Host's document is the default already: there is nothing to step back from but a preview on this page.
      if (this.preview) this.setPreview(null)
      return
    }
    this.safe = { reason, identity: this.host ? identityOf(this.hostId, this.host) : null }
    this.preview = null
    this.write(SAFE_KEY, JSON.stringify(this.safe))
    this.write(APPLYING_KEY, null)
    this.remove()
    this.publish()
  }

  /** The same keys again: back to the Host's document. */
  leaveSafeMode(): void {
    this.safe = null
    this.write(SAFE_KEY, null)
    this.hostState(this.host ?? undefined, this.hostId)
  }

  status = (): CustomizationStatus => this.snapshot
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private publish(): void {
    const next: CustomizationStatus = { safe: this.safe?.reason ?? null, host: this.host, preview: this.preview }
    const same = next.safe === this.snapshot.safe && next.host === this.snapshot.host && next.preview === this.snapshot.preview
    if (same) return
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }

  /**
   * The last Host's document, shown before the Host has answered so the page does not change its look on connecting.
   * It is a guess until the first snapshot, which replaces it unless it is that Host's document exactly.
   */
  private applyCached(): void {
    const hostId = this.read(CACHE_HOST_KEY)
    if (hostId === null) return
    const raw = HOST_ID.test(hostId) ? this.read(cacheKey(hostId)) : null
    let cached: { revision?: unknown; doc?: unknown } | null = null
    try {
      cached = JSON.parse(raw ?? 'null') as { revision?: unknown; doc?: unknown } | null
    } catch {
      /* Handled as a document that fails the rules. */
    }
    const revision = typeof cached?.revision === 'number' && Number.isInteger(cached.revision) ? cached.revision : null
    const doc = revision === null ? null : parseCustomization(cached?.doc)
    if (doc === null || revision === null) {
      this.safe = { reason: 'invalid', identity: null }
      this.write(SAFE_KEY, JSON.stringify(this.safe))
      if (HOST_ID.test(hostId)) this.write(cacheKey(hostId), null)
      this.write(CACHE_HOST_KEY, null)
      return
    }
    this.hostId = hostId
    this.show(doc, identityOf(hostId, { revision, doc }), true)
  }

  /** Puts a document on the page. `guarded`: the load is watched, so a page that dies under it shows the default next time. */
  private show(doc: CustomizationDocument, identity: string | null, guarded: boolean): void {
    const resolved = resolveAppearance(doc.appearance)
    if (isDefaultCustomization(doc)) {
      this.remove()
      this.shown = identity
      return
    }
    const sheet = this.env.createSheet()
    if (!sheet) {
      // No constructed stylesheets here: the default look.
      this.remove()
      this.shown = identity
      return
    }
    if (guarded && identity !== null) {
      this.write(APPLYING_KEY, identity)
      this.armReady()
    }
    sheet.replaceSync(SHEET_SKELETON)
    const layer = sheet.cssRules[0] as { cssRules: ArrayLike<unknown> }
    const [light, phone, darkSystem, darkChosen] = sheetPlan(resolved, this.env.tokens)
    const fill = (rule: unknown, entries: Array<[string, string]>) => {
      for (const [name, value] of entries) (rule as StyleRuleLike).style.setProperty(name, value)
    }
    fill(layer.cssRules[0], light)
    fill((layer.cssRules[1] as { cssRules: ArrayLike<unknown> }).cssRules[0], phone)
    fill((layer.cssRules[2] as { cssRules: ArrayLike<unknown> }).cssRules[0], darkSystem)
    fill(layer.cssRules[3], darkChosen)
    this.env.adopt([...this.env.adopted().filter(item => item !== this.sheet), sheet])
    if (light.some(([name]) => name === '--accent')) this.env.root.dataset.hostAccent = ''
    else delete this.env.root.dataset.hostAccent
    this.sheet = sheet
    this.shown = identity
  }

  private remove(): void {
    if (this.sheet !== null) this.env.adopt(this.env.adopted().filter(item => item !== this.sheet))
    delete this.env.root.dataset.hostAccent
    this.sheet = null
    this.shown = null
  }

  /** Reads and removes `safe` from the address's fragment, leaving anything else there for whoever reads it next. */
  private takeFragment(): boolean {
    const { hash, pathname, search } = this.env.location
    if (!hash) return false
    const fragment = new URLSearchParams(hash.slice(1))
    if (!fragment.has('safe')) return false
    fragment.delete('safe')
    const rest = fragment.toString()
    this.env.replaceUrl(`${pathname}${search}${rest ? `#${rest}` : ''}`)
    return true
  }

  private readSafe(): SafeRecord | null {
    try {
      const value = JSON.parse(this.read(SAFE_KEY) ?? 'null') as Partial<SafeRecord> | null
      if (!value || !['guard', 'invalid', 'keys', 'link'].includes(value.reason ?? '')) return null
      return {
        reason: value.reason!,
        identity: typeof value.identity === 'string' ? value.identity : null,
      }
    } catch {
      return null
    }
  }

  private read(key: string): string | null {
    try {
      return this.env.storage?.getItem(key) ?? null
    } catch {
      return null
    }
  }

  private write(key: string, value: string | null): void {
    try {
      if (value === null) this.env.storage?.removeItem(key)
      else this.env.storage?.setItem(key, value)
    } catch {
      /* Without storage the page still works; safe mode then lasts for this page only. */
    }
  }
}

let boot: CustomizationBoot | null = null

/** The page's one instance. Before `bootCustomization` it knows no token it may write, so it writes none. */
export function customization(): CustomizationBoot {
  boot ??= new CustomizationBoot(browserEnvironment(new Set()))
  return boot
}

/** main.tsx, before React renders anything, with the design system's CUSTOM_TOKENS. */
export function bootCustomization(tokens: readonly string[]): void {
  try {
    boot = new CustomizationBoot(browserEnvironment(new Set(tokens)))
    boot.start()
  } catch {
    /* The page starts with the default look. */
  }
}
