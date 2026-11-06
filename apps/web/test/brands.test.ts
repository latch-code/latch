import { readdirSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AGENT_PRESETS, PROVIDER_PRESETS } from '@latch/protocol'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { GLYPHS, HARNESS_MARKS, PROVIDER_MARKS, harnessArt, presetOf, providerArt } from '../src/brands.ts'
import { GlyphTile, ProviderTile } from '../src/components/BrandTile.tsx'

const assets = new URL('../src/assets/brands/', import.meta.url)
const files = readdirSync(assets).filter(name => !name.startsWith('.'))
const marks = [...Object.values(HARNESS_MARKS), ...Object.values(PROVIDER_MARKS)]
/** The files the mapping names. They are imported `?no-inline`, so the page loads each file as it is, never re-encoded. */
const named = new Set(
  marks.flatMap(mark =>
    [mark.src, mark.dark].filter((src): src is string => src !== undefined).map(src => basename(src.replace(/\?.*$/su, ''))),
  ),
)

describe('brand icons', () => {
  it('draws a glyph without the plate wherever the plate would make it unreadable', () => {
    const plate = (element: Parameters<typeof renderToStaticMarkup>[0]) => !renderToStaticMarkup(element).includes('data-plain')
    for (const [size, shown] of [
      [14, false],
      [16, false],
      [20, true],
    ] as const) {
      expect(plate(createElement(GlyphTile, { icon: GLYPHS.agent, size }))).toBe(shown)
      expect(plate(createElement(ProviderTile, { provider: { id: 'someone-else' }, size }))).toBe(shown)
    }
  })

  it('gives every harness preset its brand icon, and those whose terms allow text only the neutral glyph', () => {
    const branded = AGENT_PRESETS.filter(preset => preset.brandMark !== false)
    expect(Object.keys(HARNESS_MARKS).toSorted()).toEqual(branded.map(preset => preset.id).toSorted())
    for (const preset of AGENT_PRESETS) {
      expect({ preset: preset.id, kind: harnessArt(preset.id).kind }).toEqual({
        preset: preset.id,
        kind: preset.brandMark === false ? 'glyph' : 'mark',
      })
    }
    expect(AGENT_PRESETS.filter(preset => preset.brandMark === false).map(preset => preset.id)).toEqual(['claude-agent', 'cursor'])
    // The built-in harness is Latch itself; an agent command or a plugin without a brand gets a glyph, never a letter.
    expect(harnessArt('latch')).toEqual({ kind: 'app' })
    expect(harnessArt(undefined)).toEqual({ kind: 'glyph', icon: GLYPHS.agent })
    expect(harnessArt('plugin')).toEqual({ kind: 'glyph', icon: GLYPHS.plugin })
    // Only keys of the fixed set draw anything of their own.
    expect(harnessArt('https://example.test/mark.svg')).toEqual({ kind: 'glyph', icon: GLYPHS.agent })
    expect(harnessArt('constructor')).toEqual({ kind: 'glyph', icon: GLYPHS.agent })
  })

  it('gives every model-service preset its brand icon, and demo, plugin and custom services a glyph', () => {
    const branded = PROVIDER_PRESETS.filter(preset => preset.id !== 'custom').map(preset => preset.id)
    expect(Object.keys(PROVIDER_MARKS).toSorted()).toEqual(branded.toSorted())
    for (const id of branded)
      expect({ id, kind: providerArt({ id, kind: 'openai-compatible', presetId: id }).kind }).toEqual({ id, kind: 'mark' })
    expect(providerArt({ id: 'custom', presetId: 'custom', kind: 'openai-compatible' })).toEqual({ kind: 'glyph', icon: GLYPHS.custom })
    expect(providerArt({ id: 'my-proxy', kind: 'openai-compatible' })).toEqual({ kind: 'glyph', icon: GLYPHS.custom })
    expect(providerArt({ id: 'demo', kind: 'demo' })).toEqual({ kind: 'glyph', icon: GLYPHS.demo })
    expect(providerArt({ id: 'openai', kind: 'plugin' })).toEqual({ kind: 'glyph', icon: GLYPHS.plugin })
  })

  it('finds the preset of an entry from the ID the Host derived from it', () => {
    expect(presetOf('codex', HARNESS_MARKS)).toBe('codex')
    expect(presetOf('codex-2', HARNESS_MARKS)).toBe('codex')
    expect(presetOf('codex-acp', HARNESS_MARKS)).toBeUndefined()
    expect(presetOf('hasOwnProperty', HARNESS_MARKS)).toBeUndefined()
    expect(providerArt({ id: 'deepseek-3', kind: 'openai-compatible' })).toEqual({ kind: 'mark', mark: PROVIDER_MARKS.deepseek })
    // An explicit preset wins over the ID; a service on the Anthropic protocol shows Anthropic's mark.
    expect(providerArt({ id: 'openai', kind: 'openai-compatible', presetId: 'custom' })).toEqual({ kind: 'glyph', icon: GLYPHS.custom })
    expect(providerArt({ id: 'claude-proxy', kind: 'anthropic' })).toEqual({ kind: 'mark', mark: PROVIDER_MARKS.anthropic })
  })

  it('ships exactly the files it names, each a plain image', () => {
    expect([...named].toSorted()).toEqual(files.toSorted())
    for (const file of files) {
      const bytes = readFileSync(new URL(file, assets))
      if (file.endsWith('.png')) {
        expect({ file, signature: bytes.subarray(0, 8).toString('hex') }).toEqual({ file, signature: '89504e470d0a1a0a' })
        continue
      }
      expect(file.endsWith('.svg')).toBe(true)
      const text = bytes.toString('utf8')
      // Nothing that runs, loads or styles beyond the image itself: no script, foreign content, event handlers,
      // embedded images, style sheets or references outside the file.
      const unsafe = [
        /<script/iu,
        /foreignObject/iu,
        /\son[a-z]+\s*=/iu,
        /<image/iu,
        /<style/iu,
        /@import/iu,
        /<!ENTITY/iu,
        /(?:xlink:)?href\s*=\s*["'](?!#)/iu,
        /url\(\s*["']?(?!#)/iu,
      ].filter(pattern => pattern.test(text))
      expect({ file, unsafe: unsafe.map(String) }).toEqual({ file, unsafe: [] })
      expect(text).toMatch(/<svg[\s>]/u)
    }
  })
})
