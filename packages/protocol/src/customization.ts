/*
 * Customisation is data. One document per Host says how the interface looks: a few enumerations and one bounded
 * number. This file holds its shape, the rules a document must pass, and the pure expansion into design-token values.
 * Nothing in a document is ever text that reaches CSS, HTML or a selector: every value a client writes into a token
 * is built here from numbers and from the fixed tables below.
 *
 * Amber, red and green are not in the document, and neither is anything that could hide, move or resize a part of the
 * page: no opacity, no display, no size below the product's smallest text.
 */

export const CUSTOMIZATION_SCHEMA = 1
/** A Host keeps this many revisions; the oldest goes first. */
export const CUSTOMIZATION_REVISION_LIMIT = 20

export const APPEARANCE_RADII = ['sharp', 'default', 'round'] as const
export const APPEARANCE_TEXT_SIZES = ['small', 'default', 'large'] as const
export type AppearanceRadius = (typeof APPEARANCE_RADII)[number]
export type AppearanceTextSize = (typeof APPEARANCE_TEXT_SIZES)[number]

/** 外观. Every field is optional; an absent field is the product's default. */
export interface Appearance {
  /** The accent's hue in OKLCH degrees, 0–359. Lightness and chroma stay the product's. */
  accentHue?: number
  radius?: AppearanceRadius
  textSize?: AppearanceTextSize
}
export const APPEARANCE_FIELDS = ['accentHue', 'radius', 'textSize'] as const
export type AppearanceField = (typeof APPEARANCE_FIELDS)[number]

export interface CustomizationDocument {
  schema: typeof CUSTOMIZATION_SCHEMA
  appearance: Appearance
}
export const DEFAULT_CUSTOMIZATION: CustomizationDocument = { schema: CUSTOMIZATION_SCHEMA, appearance: {} }

export type CustomizationSource = 'apply' | 'restore' | 'reset'
/** One saved revision. `revision` counts up from 1 for the life of the Host's data; 0 is the default before any. */
export interface CustomizationRevision {
  revision: number
  /** SHA-256 of the document's canonical JSON. */
  hash: string
  at: string
  source: CustomizationSource
  /** `cli` for `pnpm latch customization reset`. */
  by: 'device' | 'cli'
  doc: CustomizationDocument
}
/** What the snapshot carries: the document in force and its revision. */
export interface CustomizationState {
  revision: number
  doc: CustomizationDocument
}
/** `GET /link/api/customization`: the state and the saved revisions, newest first. */
export interface CustomizationView extends CustomizationState {
  revisions: CustomizationRevision[]
}
/**
 * The receipt of a write: the revision this request left in force (`applied`), the state now, and whether this answer
 * repeats an earlier one of the same request.
 */
export interface CustomizationReceipt extends CustomizationState {
  requestId: string
  applied: number
  replayed: boolean
}

// ---- Colour ---------------------------------------------------------------------------------------------------------

type Rgb = readonly [number, number, number]

function parseHex(value: string): Rgb {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/u.exec(value)
  if (!match) throw new Error('Not a colour')
  return [parseInt(match[1]!, 16), parseInt(match[2]!, 16), parseInt(match[3]!, 16)]
}
const toHex = ([r, g, b]: Rgb): string => `#${[r, g, b].map(channel => channel.toString(16).padStart(2, '0')).join('')}`

const toLinear = (channel: number) => (channel / 255 <= 0.04045 ? channel / 255 / 12.92 : ((channel / 255 + 0.055) / 1.055) ** 2.4)
const fromLinear = (value: number) => (value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055)

/** OKLCH of an sRGB colour: lightness 0–1, chroma, hue in degrees. */
export function oklch(rgb: Rgb): { l: number; c: number; h: number } {
  const [r, g, b] = [toLinear(rgb[0]), toLinear(rgb[1]), toLinear(rgb[2])]
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  return { l: lightness, c: Math.hypot(a, bb), h: ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360 }
}

function linearOf(l: number, c: number, h: number): [number, number, number] {
  const a = c * Math.cos((h * Math.PI) / 180)
  const b = c * Math.sin((h * Math.PI) / 180)
  const l3 = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m3 = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s3 = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
    -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
    -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3,
  ]
}

/** The sRGB colour of an OKLCH one; chroma is lowered until the colour exists in sRGB, lightness and hue are kept. */
function fromOklch(l: number, c: number, h: number): Rgb {
  const inGamut = (chroma: number) => linearOf(l, chroma, h).every(value => value >= -0.0005 && value <= 1.0005)
  let chroma = c
  if (!inGamut(chroma)) {
    let low = 0
    let high = c
    for (let step = 0; step < 24; step++) {
      const middle = (low + high) / 2
      if (inGamut(middle)) low = middle
      else high = middle
    }
    chroma = low
  }
  const [r, g, b] = linearOf(l, chroma, h).map(value => Math.round(255 * fromLinear(Math.min(1, Math.max(0, value)))))
  return [r!, g!, b!]
}

/** WCAG 2 contrast ratio of two opaque colours. */
function contrastRatio(a: Rgb, b: Rgb): number {
  const [first, second] = [luminance(a), luminance(b)]
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

const hueDistance = (a: number, b: number) => {
  const distance = Math.abs(a - b) % 360
  return distance > 180 ? 360 - distance : distance
}

// ---- The product's own values, which a test keeps equal to packages/ui/src/tokens.css -----------------------------------

type Theme = 'light' | 'dark'
const CUSTOMIZATION_THEMES: readonly Theme[] = ['light', 'dark']

/** The accent family at the product's default, per theme. `soft` and `shadow` carry their alpha. */
export const ACCENT_DEFAULTS = {
  light: {
    accent: '#2461e0',
    hover: '#1d55cc',
    ink: '#1d52c4',
    running: '#2c5ad6',
    soft: { base: '#2461e0', alpha: 0.1 },
    shadow: { base: '#2461e0', alpha: 0.24 },
    plainShadow: null,
  },
  dark: {
    accent: '#2f6be6',
    hover: '#2a62d6',
    ink: '#6b9bfa',
    running: '#86a8ff',
    soft: { base: '#3b76f6', alpha: 0.18 },
    shadow: null,
    /** The dark theme's shadow under the primary button is black whatever the accent. */
    plainShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.16), 0 1px 2px rgba(0, 0, 0, 0.4)',
  },
} as const

/** The state colours an accent must stay away from, per theme: amber (words and glyphs), red and green. */
export const STATE_COLOURS = {
  light: { amber: '#884a06', amberIcon: '#c46f06', red: '#b4231f', green: '#166f3b' },
  dark: { amber: '#f0aa45', amberIcon: '#e89a2c', red: '#f47c75', green: '#5ccc8e' },
} as const
const STATE_NAMES: Record<keyof (typeof STATE_COLOURS)['light'], string> = { amber: '琥珀', amberIcon: '琥珀', red: '红', green: '绿' }

/** The ink of ordinary words, per theme: what must stay readable on a surface tinted with the accent. */
export const CUSTOMIZATION_INK = { light: '#17171a', dark: '#ececef' } as const
/** The workbench's own surfaces, where running work is said in the accent. */
export const CUSTOMIZATION_WORK_SURFACES = {
  light: { 'work-canvas': '#eceef1', 'work-raised': '#fbfcfd', 'work-sunken': '#e3e6ea' },
  dark: { 'work-canvas': '#0e1013', 'work-raised': '#15181c', 'work-sunken': '#0b0d10' },
} as const
/** The opaque surfaces words and focus rings rest on, per theme. */
export const CUSTOMIZATION_SURFACES = {
  light: {
    canvas: '#ffffff',
    sidebar: '#ebebef',
    raised: '#ffffff',
    sunken: '#f3f3f6',
    card: '#ffffff',
    pop: '#ffffff',
    bubble: '#f1f1f4',
  },
  dark: { canvas: '#131316', sidebar: '#09090b', raised: '#1b1b1f', sunken: '#0b0b0d', card: '#212126', pop: '#27272c', bubble: '#1e1e22' },
} as const
const ON_ACCENT: Rgb = [255, 255, 255]

/** How far an accent's hue stays from every state colour's, in degrees. */
export const ACCENT_HUE_DISTANCE = 30
/**
 * The hues an accent may take: teal through blue and violet to magenta. Narrower than the distance rule alone: the
 * yellow-greens between amber and green read as amber at an accent's lightness, and the pinks past 330 sit beside red.
 */
export const ACCENT_HUE_RANGE = { from: 187, to: 330 } as const
/** The product's contrast floors: white words on the accent and accent words on a surface 4.5:1, a focus ring 3:1. */
export const CONTRAST_FLOORS = { onAccent: 4.5, accentInk: 4.5, focusRing: 3, running: 4.5, tinted: 4.5, shadow: 3 } as const
/** No role's text is ever smaller than this, and a phone's input never smaller than 16px (iOS zooms below it). */
export const MIN_TEXT_PX = 11
export const MIN_PHONE_INPUT_PX = 16

/** Radii move one step along the product's own steps (2, 4, 6, 8, 12, 16): no value off the scale. */
const RADII: Record<Exclude<AppearanceRadius, 'default'>, Record<string, number>> = {
  sharp: { '--r-4': 2, '--r-6': 4, '--r-8': 6, '--r-12': 8, '--r-16': 12 },
  round: { '--r-4': 6, '--r-6': 8, '--r-8': 12, '--r-12': 16, '--r-16': 16 },
}

/** The type roles a text size moves: [size token, line-height tokens, size, line heights], wide windows then phones. */
export const CUSTOMIZATION_TYPE_ROLES: ReadonlyArray<{
  size: string
  lines: readonly string[]
  wide: readonly [number, ...number[]]
  phone?: readonly [number, ...number[]]
}> = [
  { size: '--fs-meta', lines: ['--lh-meta'], wide: [11, 14] },
  { size: '--fs-caption', lines: ['--lh-caption', '--lh-caption-para'], wide: [12, 16, 18], phone: [13, 18, 20] },
  { size: '--fs-ui', lines: ['--lh-ui', '--lh-ui-para'], wide: [14, 20, 22], phone: [15, 20, 22] },
  { size: '--fs-input', lines: ['--lh-input'], wide: [14, 20], phone: [16, 24] },
  { size: '--fs-prose', lines: ['--lh-prose'], wide: [15, 24], phone: [16, 26] },
  { size: '--fs-heading', lines: ['--lh-heading'], wide: [15, 22], phone: [16, 22] },
  { size: '--fs-title', lines: ['--lh-title'], wide: [20, 28], phone: [17, 24] },
  { size: '--fs-mono', lines: ['--lh-mono'], wide: [13, 18] },
  { size: '--fs-code', lines: ['--lh-code'], wide: [12, 20] },
  { size: '--fs-term', lines: ['--lh-term'], wide: [12.5, 18] },
  { size: '--fs-work-ui', lines: ['--lh-work-ui'], wide: [13.5, 20] },
  { size: '--fs-work-caption', lines: ['--lh-work-caption'], wide: [12, 18] },
  { size: '--fs-work-card', lines: ['--lh-work-card'], wide: [16, 23] },
]

// ---- Expansion ------------------------------------------------------------------------------------------------------

const luminance = ([r, g, b]: Rgb) => 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)

/**
 * A role's colour at another hue: the same chroma (lowered where sRGB has no such colour) and the same luminance, so
 * it keeps the contrast the product's own colour has against white words and against every surface.
 */
const rehue = (hex: string, hue: number): Rgb => {
  const source = parseHex(hex)
  const { c } = oklch(source)
  const target = luminance(source)
  let low = 0
  let high = 1
  for (let step = 0; step < 24; step++) {
    const middle = (low + high) / 2
    if (luminance(fromOklch(middle, c, hue)) < target) low = middle
    else high = middle
  }
  return fromOklch((low + high) / 2, c, hue)
}
const rgba = ([r, g, b]: Rgb, alpha: number) => `rgba(${r}, ${g}, ${b}, ${alpha})`

interface AccentFamily {
  accent: Rgb
  hover: Rgb
  ink: Rgb
  running: Rgb
  /** The tint's colour, laid at `ACCENT_DEFAULTS[theme].soft.alpha`. */
  soft: Rgb
  /** The colour of the drop under the primary button where the theme tints it; null where it is black. */
  shadow: Rgb | null
}

/** The accent family of one theme at `hue`: each role keeps its own luminance and chroma. */
export function accentAt(theme: Theme, hue: number): AccentFamily {
  const base = ACCENT_DEFAULTS[theme]
  return {
    accent: rehue(base.accent, hue),
    hover: rehue(base.hover, hue),
    ink: rehue(base.ink, hue),
    running: rehue(base.running, hue),
    soft: rehue(base.soft.base, hue),
    shadow: base.shadow ? rehue(base.shadow.base, hue) : null,
  }
}

/**
 * The token values of a document. `base` holds what is the same in both themes, `light` and `dark` the accent family,
 * `phone` the type roles below 768px. A default field contributes nothing, so the default document expands to four
 * empty tables.
 */
export interface ResolvedAppearance {
  base: Record<string, string>
  light: Record<string, string>
  dark: Record<string, string>
  phone: Record<string, string>
}

function typeTokens(size: Exclude<AppearanceTextSize, 'default'>, phone: boolean): Record<string, string> {
  const tokens: Record<string, string> = {}
  for (const role of CUSTOMIZATION_TYPE_ROLES) {
    const values = phone ? role.phone : role.wide
    if (!values) continue
    const [font, ...lines] = values
    const floor = phone && role.size === '--fs-input' ? MIN_PHONE_INPUT_PX : MIN_TEXT_PX
    tokens[role.size] = `${size === 'large' ? font + 1 : Math.max(floor, font - 1)}px`
    // A larger size takes two more pixels of line; a smaller one keeps the line it had.
    if (size === 'large') role.lines.forEach((name, index) => (tokens[name] = `${lines[index]! + 2}px`))
  }
  return tokens
}

export function resolveAppearance(appearance: Appearance): ResolvedAppearance {
  const resolved: ResolvedAppearance = { base: {}, light: {}, dark: {}, phone: {} }
  if (appearance.accentHue !== undefined)
    for (const theme of CUSTOMIZATION_THEMES) {
      const family = accentAt(theme, appearance.accentHue)
      const base = ACCENT_DEFAULTS[theme]
      Object.assign(resolved[theme], {
        '--accent': toHex(family.accent),
        '--accent-hover': toHex(family.hover),
        '--accent-ink': toHex(family.ink),
        '--accent-soft': rgba(family.soft, base.soft.alpha),
        '--work-running': toHex(family.running),
        // Both themes say theirs: the light one's is tinted with the accent, and without the dark one's own value the
        // tinted one would stay on the root under the dark theme.
        '--sh-accent':
          family.shadow && base.shadow
            ? `inset 0 1px 0 rgba(255, 255, 255, 0.16), 0 1px 2px ${rgba(family.shadow, base.shadow.alpha)}`
            : base.plainShadow,
      })
    }
  if (appearance.radius === 'sharp' || appearance.radius === 'round')
    for (const [name, px] of Object.entries(RADII[appearance.radius])) resolved.base[name] = `${px}px`
  if (appearance.textSize === 'small' || appearance.textSize === 'large') {
    Object.assign(resolved.base, typeTokens(appearance.textSize, false))
    Object.assign(resolved.phone, typeTokens(appearance.textSize, true))
  }
  return resolved
}

/** Every token name an expansion can produce; a client writes no other. */
export function resolvableTokens(): string[] {
  const names = new Set<string>()
  for (const radius of ['sharp', 'round'] as const)
    for (const textSize of ['small', 'large'] as const) {
      const resolved = resolveAppearance({ accentHue: 264, radius, textSize })
      for (const table of [resolved.base, resolved.light, resolved.dark, resolved.phone])
        for (const name of Object.keys(table)) names.add(name)
    }
  return [...names].toSorted()
}

// ---- Validation -----------------------------------------------------------------------------------------------------

/** Why a document is refused: the field, a sentence for a person, and the numbers behind it where there are any. */
export interface CustomizationIssue {
  field: string
  message: string
  measured?: number
  required?: number
}

const round2 = (value: number) => Math.round(value * 100) / 100

/**
 * The contrast floors of one theme's accent family: white words on the fill and on its hover, accent words on every
 * surface, and the fill as a focus ring on every surface. An expansion keeps each role's luminance, so it passes by
 * construction; this is the check that would refuse it if it ever did not, with the ratio it measured.
 */
export function accentFamilyIssues(theme: Theme, family: AccentFamily): CustomizationIssue[] {
  const field = 'appearance.accentHue'
  const name = theme === 'light' ? '浅色' : '深色'
  const issues: CustomizationIssue[] = []
  const floor = (label: string, measured: number, required: number) => {
    if (measured < required)
      issues.push({
        field,
        message: `${label}对比度不足（${name}，${round2(measured)}:1，至少 ${required}:1）`,
        measured: round2(measured),
        required,
      })
  }
  const least = (ink: Rgb, grounds: Rgb[]) => Math.min(...grounds.map(ground => contrastRatio(ink, ground)))
  floor('主色上的白字', least(ON_ACCENT, [family.accent, family.hover]), CONTRAST_FLOORS.onAccent)
  const surfaces = Object.values(CUSTOMIZATION_SURFACES[theme]).map(parseHex)
  floor('主色文字', least(family.ink, surfaces), CONTRAST_FLOORS.accentInk)
  floor('焦点环', least(family.accent, surfaces), CONTRAST_FLOORS.focusRing)
  // Running work, on the surfaces above and on the workbench's own.
  floor(
    '运行中的主色',
    least(family.running, [...surfaces, ...Object.values(CUSTOMIZATION_WORK_SURFACES[theme]).map(parseHex)]),
    CONTRAST_FLOORS.running,
  )
  // Ordinary words on a surface tinted with the accent (a selection, a field's halo).
  const alpha = ACCENT_DEFAULTS[theme].soft.alpha
  const tinted = surfaces.map(
    surface => surface.map((channel, index) => Math.round(family.soft[index]! * alpha + channel * (1 - alpha))) as unknown as Rgb,
  )
  floor('主色底上的文字', least(parseHex(CUSTOMIZATION_INK[theme]), tinted), CONTRAST_FLOORS.tinted)
  // The tinted drop under the primary button stays a shadow: no lighter against the canvas than a focus ring may be.
  if (family.shadow) floor('主色投影', contrastRatio(family.shadow, parseHex(CUSTOMIZATION_SURFACES[theme].canvas)), CONTRAST_FLOORS.shadow)
  return issues
}

/**
 * The accent rules: a hue 30° or more from every state colour, inside `ACCENT_HUE_RANGE`, and the product's contrast
 * floors in both themes.
 */
export function accentIssues(hue: number): CustomizationIssue[] {
  const field = 'appearance.accentHue'
  if (!Number.isInteger(hue) || hue < 0 || hue > 359) return [{ field, message: '主色色相需为 0–359 的整数' }]
  const issues: CustomizationIssue[] = []
  for (const theme of CUSTOMIZATION_THEMES) {
    const name = theme === 'light' ? '浅色' : '深色'
    for (const [state, hex] of Object.entries(STATE_COLOURS[theme]) as Array<[keyof typeof STATE_NAMES, string]>) {
      const distance = hueDistance(hue, oklch(parseHex(hex)).h)
      if (distance < ACCENT_HUE_DISTANCE) {
        issues.push({
          field,
          message: `主色离${STATE_NAMES[state]}色太近（${name}，相差 ${round2(distance)}°，至少 ${ACCENT_HUE_DISTANCE}°）`,
          measured: round2(distance),
          required: ACCENT_HUE_DISTANCE,
        })
        break
      }
    }
    issues.push(...accentFamilyIssues(theme, accentAt(theme, hue)))
  }
  if (issues.length === 0 && (hue < ACCENT_HUE_RANGE.from || hue > ACCENT_HUE_RANGE.to))
    issues.push({ field, message: `主色色相需在 ${ACCENT_HUE_RANGE.from}–${ACCENT_HUE_RANGE.to} 之间（现在是 ${hue}）`, measured: hue })
  return issues
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Checks a document strictly: an unknown field, a value outside its enumeration or range, an accent too close to a
 * state colour or under a contrast floor each refuse the whole document. Nothing is corrected.
 */
export function customizationIssues(value: unknown): CustomizationIssue[] {
  if (!isRecord(value)) return [{ field: '', message: '自定义文档需为对象' }]
  const issues: CustomizationIssue[] = []
  if (Object.keys(value).some(key => key !== 'schema' && key !== 'appearance')) issues.push({ field: '', message: '自定义文档含未知字段' })
  if (value.schema !== CUSTOMIZATION_SCHEMA) issues.push({ field: 'schema', message: '不认识的自定义文档版本' })
  const appearance = value.appearance
  if (!isRecord(appearance)) return [...issues, { field: 'appearance', message: '缺少外观' }]
  if (Object.keys(appearance).some(key => !(APPEARANCE_FIELDS as readonly string[]).includes(key)))
    issues.push({ field: 'appearance', message: '外观含未知字段' })
  const choice = (field: Exclude<AppearanceField, 'accentHue'>, allowed: readonly string[]) => {
    const chosen = appearance[field]
    if (chosen !== undefined && (typeof chosen !== 'string' || !allowed.includes(chosen)))
      issues.push({ field: `appearance.${field}`, message: `${field} 只能是 ${allowed.join('、')}` })
  }
  choice('radius', APPEARANCE_RADII)
  choice('textSize', APPEARANCE_TEXT_SIZES)
  if (appearance.accentHue !== undefined)
    issues.push(
      ...(typeof appearance.accentHue === 'number'
        ? accentIssues(appearance.accentHue)
        : [{ field: 'appearance.accentHue', message: '主色色相需为 0–359 的整数' }]),
    )
  return issues
}

/** The document if it passes every rule, else null. */
export function parseCustomization(value: unknown): CustomizationDocument | null {
  return customizationIssues(value).length === 0 ? (value as CustomizationDocument) : null
}

/** The fields of 外观 a document sets away from the default, for the record of a change. */
export function customizedFields(doc: CustomizationDocument): AppearanceField[] {
  const defaults: Record<AppearanceField, unknown> = {
    accentHue: undefined,
    radius: 'default',
    textSize: 'default',
  }
  return APPEARANCE_FIELDS.filter(field => doc.appearance[field] !== undefined && doc.appearance[field] !== defaults[field])
}

/** Whether a document changes nothing: the default, however it is spelled. */
export const isDefaultCustomization = (doc: CustomizationDocument): boolean => customizedFields(doc).length === 0

/** The hues an accent may take, for a picker: every integer hue that passes `accentIssues`. */
export function allowedAccentHues(): number[] {
  const hues: number[] = []
  for (let hue = 0; hue < 360; hue++) if (accentIssues(hue).length === 0) hues.push(hue)
  return hues
}
