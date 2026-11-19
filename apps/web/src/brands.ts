import { Plug, Presentation } from 'lucide-react'
import { PluginsGlyph, HarnessGlyph } from '@latch/ui'
import type { ProviderSummary } from '@latch/protocol'
import type { IconComponent, TileMark } from '@latch/ui'
import anthropic from './assets/brands/anthropic.svg?no-inline'
import bailian from './assets/brands/bailian.svg?no-inline'
import antigravity from './assets/brands/antigravity.svg?no-inline'
import claude from './assets/brands/claude.svg?no-inline'
import codex from './assets/brands/codex.png?no-inline'
import cursorDark from './assets/brands/cursor-dark.svg?no-inline'
import cursorLight from './assets/brands/cursor-light.svg?no-inline'
import deepseekHarness from './assets/brands/deepseek-harness.svg?no-inline'
import deepseek from './assets/brands/deepseek.svg?no-inline'
import grokDark from './assets/brands/grok-dark.svg?no-inline'
import grokLight from './assets/brands/grok-light.svg?no-inline'
import goose from './assets/brands/goose.svg?no-inline'
import lmstudio from './assets/brands/lmstudio.svg?no-inline'
import moonshot from './assets/brands/moonshot.svg?no-inline'
import ollama from './assets/brands/ollama.svg?no-inline'
import openai from './assets/brands/openai.svg?no-inline'
import opencodeDark from './assets/brands/opencode-dark.svg?no-inline'
import opencodeLight from './assets/brands/opencode-light.svg?no-inline'
import openrouter from './assets/brands/openrouter.svg?no-inline'
import pi from './assets/brands/pi.svg?no-inline'
import qwenCode from './assets/brands/qwen-code.svg?no-inline'
import siliconcloud from './assets/brands/siliconcloud.svg?no-inline'
import volcengine from './assets/brands/volcengine.svg?no-inline'
import zhipu from './assets/brands/zhipu.svg?no-inline'

/**
 * How a harness or a model service is drawn on its tile: its brand's own icon (the files under assets/brands, copied
 * unmodified; sources and licences in public/licenses/brands), the app's own icon for the built-in harness, or a neutral glyph for
 * something that has no icon of its own. Never a letter.
 */
export type BrandArt = { kind: 'mark'; mark: TileMark } | { kind: 'app' } | { kind: 'glyph'; icon: IconComponent }

/** Every harness preset (agent-presets.ts) but those marked `brandMark: false`, which draw the neutral agent glyph; the brand test checks both. */
export const HARNESS_MARKS: Record<string, TileMark> = {
  codex: { src: codex, margin: true },
  'claude-agent': { src: claude },
  cursor: { src: cursorLight, dark: cursorDark, tile: true },
  antigravity: { src: antigravity, margin: true },
  pi: { src: pi, margin: true },
  opencode: { src: opencodeLight, dark: opencodeDark },
  dsh: { src: deepseekHarness, mono: true },
  qwen: { src: qwenCode },
  goose: { src: goose, mono: true },
  grok: { src: grokDark, dark: grokLight, margin: true },
}

/**
 * Every model-service preset (presets.ts) but `custom`, which has no brand. Each mark is the one the brand presents
 * that API with: Moonshot's platform serves Kimi, 百炼 is Alibaba Cloud's Bailian, 火山方舟 is Volcengine's and 硅基流动
 * is SiliconFlow (SiliconCloud).
 */
export const PROVIDER_MARKS: Record<string, TileMark> = {
  openai: { src: openai, mono: true },
  anthropic: { src: anthropic, mono: true },
  deepseek: { src: deepseek },
  openrouter: { src: openrouter, mono: true },
  moonshot: { src: moonshot, mono: true },
  zhipu: { src: zhipu },
  dashscope: { src: bailian },
  volcengine: { src: volcengine },
  siliconflow: { src: siliconcloud },
  ollama: { src: ollama, mono: true },
  lmstudio: { src: lmstudio, mono: true },
}

/** Glyphs for what has no brand: a custom agent command, a plugin, a custom OpenAI-compatible service, the demo model. */
export const GLYPHS = { agent: HarnessGlyph, plugin: PluginsGlyph, custom: Plug, demo: Presentation } as const satisfies Record<
  string,
  IconComponent
>

/**
 * The preset an ID was made from. The Host names an agent or a service after its preset (`codex`, then `codex-2`, …),
 * which is how a catalog entry, which does not carry its preset, finds its icon.
 */
export function presetOf(id: string, presets: Record<string, unknown>): string | undefined {
  if (Object.hasOwn(presets, id)) return id
  const base = /^(.+)-\d+$/u.exec(id)?.[1]
  return base !== undefined && Object.hasOwn(presets, base) ? base : undefined
}

/** A key the Host sent (`HarnessCapabilities.display.mark`), drawn from this fixed set; anything else is the neutral agent. */
export function harnessArt(mark: string | undefined): BrandArt {
  if (mark === 'latch') return { kind: 'app' }
  if (mark === 'plugin') return { kind: 'glyph', icon: GLYPHS.plugin }
  return mark !== undefined && Object.hasOwn(HARNESS_MARKS, mark)
    ? { kind: 'mark', mark: HARNESS_MARKS[mark]! }
    : { kind: 'glyph', icon: GLYPHS.agent }
}

export function providerArt(provider: { id: string; kind?: ProviderSummary['kind']; presetId?: string } | undefined): BrandArt {
  if (provider === undefined) return { kind: 'glyph', icon: GLYPHS.custom }
  if (provider.kind === 'demo') return { kind: 'glyph', icon: GLYPHS.demo }
  if (provider.kind === 'plugin') return { kind: 'glyph', icon: GLYPHS.plugin }
  const preset =
    provider.presetId !== undefined
      ? Object.hasOwn(PROVIDER_MARKS, provider.presetId)
        ? provider.presetId
        : undefined
      : (presetOf(provider.id, PROVIDER_MARKS) ?? (provider.kind === 'anthropic' ? 'anthropic' : undefined))
  const mark = preset === undefined ? undefined : PROVIDER_MARKS[preset]
  return mark ? { kind: 'mark', mark } : { kind: 'glyph', icon: GLYPHS.custom }
}

/**
 * A model's maker, read from the ID a service lists it under, for the mark beside its row: only families whose mark is
 * already in this set, matched as a whole word of the ID (`openrouter/anthropic/claude-…`, `deepseek-v4-flash`).
 * Anything else has no mark, which a row shows as the neutral model glyph.
 */
const MODEL_FAMILIES: ReadonlyArray<readonly [RegExp, TileMark]> = [
  [/(^|[^a-z])claude([^a-z]|$)/u, HARNESS_MARKS['claude-agent']!],
  [/(^|[^a-z])(gpt|chatgpt|codex|o[134])([^a-z]|$)/u, PROVIDER_MARKS.openai!],
  [/(^|[^a-z])deepseek([^a-z]|$)/u, PROVIDER_MARKS.deepseek!],
  [/(^|[^a-z])(qwen|qwq)([^a-z]|$)/u, PROVIDER_MARKS.dashscope!],
  [/(^|[^a-z])(glm|zhipu)([^a-z]|$)/u, PROVIDER_MARKS.zhipu!],
  [/(^|[^a-z])(kimi|moonshot)([^a-z]|$)/u, PROVIDER_MARKS.moonshot!],
  [/(^|[^a-z])doubao([^a-z]|$)/u, PROVIDER_MARKS.volcengine!],
  [/(^|[^a-z])grok([^a-z]|$)/u, HARNESS_MARKS.grok!],
]

export function modelArt(id: string): BrandArt | undefined {
  const name = id.toLowerCase()
  const mark = MODEL_FAMILIES.find(([family]) => family.test(name))?.[1]
  return mark ? { kind: 'mark', mark } : undefined
}
