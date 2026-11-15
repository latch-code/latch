/**
 * The only tokens a customisation may set. A client writes these, on the root, and nothing else: no selector, no
 * property that is not in this list. Every one of them is pinned by the lock of `[data-secure]` and `[data-lock]`
 * (tokens.css), so a customised value never reaches a security surface; `test/tokens.test.ts` keeps the list inside the
 * lock, in both themes and at the phone sizes.
 *
 * Amber, red and green are not here and never will be, and neither is anything that could hide or shrink a part of the
 * page (an opacity, a size of zero, a display).
 */
export const CUSTOM_TOKENS = [
  // The accent family: fills under white words, focus rings, checked controls, links and running work.
  '--accent',
  '--accent-hover',
  '--accent-ink',
  '--accent-soft',
  '--sh-accent',
  '--work-running',
  // Radii, moved along the scale's own steps.
  '--r-4',
  '--r-6',
  '--r-8',
  '--r-9',
  '--r-12',
  '--r-14',
  '--r-16',
  // 字号: the reading roles and their line heights.
  '--fs-meta',
  '--lh-meta',
  '--fs-caption',
  '--lh-caption',
  '--lh-caption-para',
  '--fs-ui',
  '--lh-ui',
  '--lh-ui-para',
  '--fs-input',
  '--lh-input',
  '--fs-prose',
  '--lh-prose',
  '--fs-heading',
  '--lh-heading',
  '--fs-title',
  '--lh-title',
  '--fs-mono',
  '--lh-mono',
  '--fs-code',
  '--lh-code',
  '--fs-term',
  '--lh-term',
  '--fs-work-ui',
  '--lh-work-ui',
  '--fs-work-caption',
  '--lh-work-caption',
  '--fs-work-card',
  '--lh-work-card',
] as const
export type CustomToken = (typeof CUSTOM_TOKENS)[number]

const NAMES: ReadonlySet<string> = new Set(CUSTOM_TOKENS)
export const isCustomToken = (name: string): name is CustomToken => NAMES.has(name)

/** The cascade layer the customisation's one generated sheet goes into: over the tokens, under everything else. */
export const CUSTOM_LAYER = 'custom'
