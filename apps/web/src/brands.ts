import { Bot, FlaskConical, Plug, Puzzle } from 'lucide-react'
import type { ProviderSummary } from '@latch/protocol'
import type { LucideIcon, TileMark } from '@latch/ui'
import anthropic from './assets/brands/anthropic.svg?no-inline'
import bailian from './assets/brands/bailian.svg?no-inline'
import codex from './assets/brands/codex.svg?no-inline'
import deepseekHarness from './assets/brands/deepseek-harness.svg?no-inline'
import deepseek from './assets/brands/deepseek.svg?no-inline'
import geminiCli from './assets/brands/gemini-cli.png?no-inline'
import gemini from './assets/brands/gemini.svg?no-inline'
import goose from './assets/brands/goose.png?no-inline'
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
 * unmodified; sources and licences in NOTICE), the app's own icon for the built-in harness, or a neutral glyph for
 * something that has no icon of its own. Never a letter.
 */
export type BrandArt = { kind: 'mark'; mark: TileMark } | { kind: 'app' } | { kind: 'glyph'; icon: LucideIcon }

/** Every harness preset (agent-presets.ts); a preset without an entry here fails the brand test. */
export const HARNESS_MARKS: Record<string, TileMark> = {
  codex: { src: codex, mono: true },
  pi: { src: pi, margin: true },
  opencode: { src: opencodeLight, dark: opencodeDark },
  dsh: { src: deepseekHarness, mono: true },
  gemini: { src: geminiCli, tile: true },
  qwen: { src: qwenCode },
  goose: { src: goose, mono: true },
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
  gemini: { src: gemini },
  moonshot: { src: moonshot, mono: true },
  zhipu: { src: zhipu },
  dashscope: { src: bailian },
  volcengine: { src: volcengine },
  siliconflow: { src: siliconcloud },
  ollama: { src: ollama, mono: true },
  lmstudio: { src: lmstudio, mono: true },
}

/** Glyphs for what has no brand: a custom agent command, a plugin, a custom OpenAI-compatible service, the demo model. */
export const GLYPHS = { agent: Bot, plugin: Puzzle, custom: Plug, demo: FlaskConical } as const satisfies Record<string, LucideIcon>

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
