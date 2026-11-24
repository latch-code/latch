// The contracts for media written outside this repository: src/hero.json (the hero film, its marks, steps and
// segments) and src/films.json (short films for feature slots). astro.config.ts reads both at build time, checks them
// here and hands the result to the pages; a file that breaks the contract fails the build with the path that is wrong.

export type MediaLang = 'en' | 'zh'

// Slots on the pages that can carry a film. An id with no entry for the page's language shows the slot's still.
const FILM_IDS = [
  'plugin-market',
  'plugin-create',
  'context-panel',
  'lock-screen-approval',
  'pr-follow',
  'terminal-error',
  'conversation-reference',
  'work-computer',
] as const
export type FilmId = (typeof FILM_IDS)[number]

export interface FilmEntry {
  mp4: string
  mp4Small?: string
  poster: string
  posterAvif?: string
  width: number
  height: number
  duration: number
  alt: string
}
export type Films = Partial<Record<FilmId, Partial<Record<MediaLang, FilmEntry>>>>

interface HeroMedia {
  mp4: string
  mp4Small?: string
}
interface HeroStep {
  id: string
  from: number
  to: number
  hold: boolean
  label?: Record<MediaLang, string>
}
interface HeroSegment {
  from: number
  to: number
  mac: HeroMedia
  phone: HeroMedia
}
export interface HeroTimeline {
  steps: HeroStep[]
  segments: HeroSegment[]
  // Where the film waits for Allow on the phone, and where it goes on once allowed; null without a hold step.
  hold: number | null
  allowed: number | null
}

const LANGS: MediaLang[] = ['en', 'zh']
// Generated media carry a content hash in the name (`name.<hex>.ext`, optionally `-<width>` before the extension).
const HASHED = (exts: string) => new RegExp(`^[A-Za-z0-9][A-Za-z0-9_-]*\\.[0-9a-f]{8,64}(?:-\\d+)?\\.(?:${exts})$`, 'u')
const VIDEO_FILE = HASHED('mp4')
const POSTER_FILE = HASHED('avif|webp|jpg|png')
const STEP_ID = /^[a-z][a-z0-9_-]{0,31}$/u
const MAX_STEPS = 8

const fail = (path: string, message: string): never => {
  throw new Error(`Invalid site media: ${path} ${message}`)
}
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const only = (value: Record<string, unknown>, keys: string[], path: string) => {
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${path}.${key}`, 'is not part of the contract')
}
const positive = (value: unknown, path: string) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) fail(path, 'must be a positive number')
  return value as number
}
const file = (value: unknown, pattern: RegExp, path: string) => {
  if (typeof value !== 'string' || !pattern.test(value)) fail(path, 'must be a file name with a content hash')
  return value as string
}
const text = (value: unknown, path: string) => {
  if (typeof value !== 'string' || !value.trim()) fail(path, 'must be non-empty text')
  return value as string
}

export function parseFilms(raw: unknown): Films {
  if (!isObject(raw)) return fail('films', 'must be an object')
  const films: Films = {}
  for (const [id, byLang] of Object.entries(raw)) {
    if (!(FILM_IDS as readonly string[]).includes(id)) fail(`films.${id}`, `is not a film slot (${FILM_IDS.join(', ')})`)
    if (!isObject(byLang)) return fail(`films.${id}`, 'must be an object')
    only(byLang, LANGS, `films.${id}`)
    const entries: Partial<Record<MediaLang, FilmEntry>> = {}
    for (const lang of LANGS) {
      const entry = byLang[lang]
      if (entry === undefined) continue
      const at = `films.${id}.${lang}`
      if (!isObject(entry)) return fail(at, 'must be an object')
      only(entry, ['mp4', 'mp4Small', 'poster', 'posterAvif', 'width', 'height', 'duration', 'alt'], at)
      entries[lang] = {
        mp4: file(entry.mp4, VIDEO_FILE, `${at}.mp4`),
        ...(entry.mp4Small === undefined ? {} : { mp4Small: file(entry.mp4Small, VIDEO_FILE, `${at}.mp4Small`) }),
        poster: file(entry.poster, POSTER_FILE, `${at}.poster`),
        ...(entry.posterAvif === undefined ? {} : { posterAvif: file(entry.posterAvif, POSTER_FILE, `${at}.posterAvif`) }),
        width: positive(entry.width, `${at}.width`),
        height: positive(entry.height, `${at}.height`),
        duration: positive(entry.duration, `${at}.duration`),
        alt: text(entry.alt, `${at}.alt`),
      }
    }
    films[id as FilmId] = entries
  }
  return films
}

const heroMedia = (value: unknown, path: string): HeroMedia => {
  if (!isObject(value)) return fail(path, 'must be an object')
  return {
    mp4: file(value.mp4, VIDEO_FILE, `${path}.mp4`),
    ...(value.mp4Small === undefined ? {} : { mp4Small: file(value.mp4Small, VIDEO_FILE, `${path}.mp4Small`) }),
  }
}

// The five steps of the first film, from its marks. A hero.json with its own `steps` replaces them.
const DEFAULT_STEPS = [
  { id: 'ask', at: 0 },
  { id: 'team', at: 'team' },
  { id: 'needs', at: 'needs', hold: true },
  { id: 'allow', at: 'tap' },
  { id: 'done', at: 'handed_back' },
]

/** Steps and segments of the hero film on one clock, checked against its duration and marks. */
export function heroTimeline(raw: unknown): HeroTimeline {
  if (!isObject(raw)) return fail('hero', 'must be an object')
  const duration = positive(raw.duration, 'hero.duration')
  const marks = isObject(raw.marks) ? raw.marks : fail('hero.marks', 'must be an object')
  const mark = (name: string, path: string) => {
    const value = marks[name]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > duration)
      fail(path, `names mark "${name}", which is missing`)
    return value as number
  }

  const rawSteps = raw.steps === undefined ? DEFAULT_STEPS : raw.steps
  if (!Array.isArray(rawSteps) || rawSteps.length < 2 || rawSteps.length > MAX_STEPS)
    fail('hero.steps', `must list 2 to ${MAX_STEPS} steps`)
  const seen = new Set<string>()
  const starts = (rawSteps as unknown[]).map((step, i) => {
    const at = `hero.steps[${i}]`
    if (!isObject(step)) return fail(at, 'must be an object')
    only(step, ['id', 'at', 'hold', 'label'], at)
    const id = typeof step.id === 'string' && STEP_ID.test(step.id) ? step.id : fail(`${at}.id`, 'must be a short lowercase id')
    if (seen.has(id)) fail(`${at}.id`, 'repeats another step')
    seen.add(id)
    const from =
      typeof step.at === 'number'
        ? step.at
        : typeof step.at === 'string'
          ? mark(step.at, `${at}.at`)
          : fail(`${at}.at`, 'must be seconds or a mark name')
    if (!(from >= 0 && from < duration)) fail(`${at}.at`, 'must fall inside the film')
    if (step.hold !== undefined && typeof step.hold !== 'boolean') fail(`${at}.hold`, 'must be true or false')
    let label: Record<MediaLang, string> | undefined
    if (step.label !== undefined) {
      if (!isObject(step.label)) return fail(`${at}.label`, 'must be an object')
      only(step.label, LANGS, `${at}.label`)
      label = { en: text(step.label.en, `${at}.label.en`), zh: text(step.label.zh, `${at}.label.zh`) }
    }
    return { id, from, hold: step.hold === true, label }
  })
  if (starts[0]!.from !== 0) fail('hero.steps[0].at', 'must be 0')
  starts.forEach((s, i) => {
    if (i > 0 && s.from <= starts[i - 1]!.from) fail(`hero.steps[${i}].at`, 'must come after the step before it')
  })
  const steps: HeroStep[] = starts.map((s, i) => ({ ...s, to: starts[i + 1]?.from ?? duration }))
  const holds = steps.filter(s => s.hold)
  if (holds.length > 1) fail('hero.steps', 'may hold at one step only')

  let segments: HeroSegment[]
  if (raw.segments === undefined) {
    segments = [{ from: 0, to: duration, mac: heroMedia(raw.mac, 'hero.mac'), phone: heroMedia(raw.phone, 'hero.phone') }]
  } else {
    if (!Array.isArray(raw.segments) || raw.segments.length < 1 || raw.segments.length > MAX_STEPS)
      fail('hero.segments', `must list 1 to ${MAX_STEPS} segments`)
    segments = (raw.segments as unknown[]).map((seg, i) => {
      const at = `hero.segments[${i}]`
      if (!isObject(seg)) return fail(at, 'must be an object')
      only(seg, ['from', 'to', 'mac', 'phone'], at)
      const from = typeof seg.from === 'number' ? seg.from : fail(`${at}.from`, 'must be seconds')
      const to = positive(seg.to, `${at}.to`)
      if (!(to > from)) fail(`${at}.to`, 'must come after from')
      return { from, to, mac: heroMedia(seg.mac, `${at}.mac`), phone: heroMedia(seg.phone, `${at}.phone`) }
    })
    if (segments[0]!.from !== 0) fail('hero.segments[0].from', 'must be 0')
    segments.forEach((s, i) => {
      if (i > 0 && Math.abs(s.from - segments[i - 1]!.to) > 0.001)
        fail(`hero.segments[${i}].from`, 'must start where the segment before it ends')
    })
    if (Math.abs(segments.at(-1)!.to - duration) > 0.05) fail(`hero.segments[${segments.length - 1}].to`, 'must end at the film’s duration')
  }

  const holdStep = holds[0]
  const hold = holdStep ? Math.min(((marks.hold_start as number | undefined) ?? holdStep.from) + 0.6, holdStep.to - 0.05) : null
  const allowed = holdStep ? ((marks.allowed as number | undefined) ?? holdStep.to) : null
  return { steps, segments, hold, allowed }
}
