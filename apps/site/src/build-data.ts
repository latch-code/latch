// Media tables checked by astro.config.ts (see src/media.ts) and pinned into the build.
import type { FilmEntry, FilmId, Films, HeroTimeline, MediaLang } from './media'
import type RAW_HERO from './hero.json'

declare const __LATCH_HERO__: { media: typeof RAW_HERO; timeline: HeroTimeline }
declare const __LATCH_FILMS__: Films

export const HERO = __LATCH_HERO__.media
export const TIMELINE = __LATCH_HERO__.timeline
export const film = (id: FilmId, lang: MediaLang): FilmEntry | undefined => __LATCH_FILMS__[id]?.[lang]
