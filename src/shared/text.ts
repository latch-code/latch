/**
 * Text that names something in security UI (device names, confirmation previews). Browser-safe: no Node imports.
 *
 * Every "other" code point (controls, format and bidi characters, surrogates, private use, unassigned), the line and
 * paragraph separators a dialog would break lines on, and default-ignorable code points (zero-width characters,
 * variation selectors, Hangul fillers, tag characters).
 */
const INVISIBLE = /[\p{C}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u
const PICTOGRAPHIC = /^\p{Extended_Pictographic}$/u
const KEYCAP_BASE = /^[0-9#*]$/u
const ZWJ = '‍'
const KEYCAP = '⃣'
/** Long runs of combining marks can draw over neighbouring lines; marks beyond this many in a row are escaped. */
const MAX_COMBINING_RUN = 4
const MARK_RUN = new RegExp(`\\p{M}{${MAX_COMBINING_RUN + 1},}`, 'gu')
const DEVICE_NAME_MAX = 80

function visibleCodePoint(character: string): string {
  return `\\u{${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}}`
}

/** A pictograph that is itself shown as it is (unassigned pictographic code points are escaped). */
function shownPictograph(point: string | undefined): boolean {
  return point !== undefined && PICTOGRAPHIC.test(point) && !INVISIBLE.test(point)
}

/**
 * The two emoji joiners left as they are: a zero-width joiner between two pictographs (👨‍💻), and a text or emoji
 * presentation selector right after a pictograph (❤️) or inside a keycap sequence (1️⃣). Neither can break a line,
 * change direction or hide text.
 */
function joinsEmoji(points: readonly string[], index: number): boolean {
  const point = points[index]
  const before = points[index - 1]
  if (point === ZWJ) return shownPictograph(before) && shownPictograph(points[index + 1])
  if (point === '︎' || point === '️') {
    return shownPictograph(before) || (before !== undefined && KEYCAP_BASE.test(before) && points[index + 1] === KEYCAP)
  }
  return false
}

/**
 * Replaces invisible, line-breaking and direction-changing characters, and overlong runs of combining marks, with a
 * visible `\u{XXXX}`, except the emoji joiners above. Already-escaped text is unchanged. The macOS confirmation
 * helper applies the same rule.
 */
export function escapeSecurityText(text: string): string {
  const points = [...text]
  let escaped = ''
  for (let index = 0; index < points.length; index++) {
    const point = points[index]!
    escaped += INVISIBLE.test(point) && !joinsEmoji(points, index) ? visibleCodePoint(point) : point
  }
  return escaped.replace(MARK_RUN, run => {
    const marks = [...run]
    return marks.slice(0, MAX_COMBINING_RUN).join('') + marks.slice(MAX_COMBINING_RUN).map(visibleCodePoint).join('')
  })
}

/** 1–80 characters after trimming, and nothing a confirmation dialog would have to escape. */
export function isAcceptableDeviceName(name: string): boolean {
  if (typeof name !== 'string') return false
  const length = name.trim().length
  return length >= 1 && length <= DEVICE_NAME_MAX && escapeSecurityText(name) === name
}
