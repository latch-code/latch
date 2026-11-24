const patterns = ['orbits', 'lattice', 'diagonals', 'dots'] as const
const tones = ['slate', 'iris', 'rose', 'teal', 'moss', 'sand'] as const
const glyphs = ['blocks', 'compass', 'asterisk', 'layers', 'network', 'orbit', 'shapes', 'command'] as const

/** Match the same artwork across views, releases and languages using the full plugin id or npm name. */
export function pluginArtwork(id: string) {
  let hash = 2166136261
  for (let index = 0; index < id.length; index += 1) {
    hash = Math.imul(hash ^ id.charCodeAt(index), 16777619)
  }
  return {
    pattern: patterns[(hash >>> 0) % patterns.length],
    tone: tones[(hash >>> 8) % tones.length],
    glyph: glyphs[(hash >>> 16) % glyphs.length],
  }
}
