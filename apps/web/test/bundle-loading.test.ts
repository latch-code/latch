import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { build } from 'vite'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => vi.unstubAllEnvs())

interface Chunk {
  file: string
  entry: boolean
  imports: string[]
  dynamicImports: string[]
  bytes: number
  gzipBytes: number
  modules: Array<{ id: string; renderedLength: number }>
}

describe('production entry loading graph', () => {
  it('keeps optional settings, QR encoders and document engines out of the initial static JavaScript graph', async () => {
    const chunks: Chunk[] = []
    vi.stubEnv('NODE_ENV', 'production')
    await build({
      configFile: false,
      root: resolve('apps/web'),
      base: '/link/',
      publicDir: false,
      logLevel: 'silent',
      worker: { format: 'es' },
      build: {
        write: false,
        rolldownOptions: {
          onwarn(warning, warn) {
            if (warning.code !== 'MODULE_LEVEL_DIRECTIVE') warn(warning)
          },
        },
      },
      plugins: [
        {
          name: 'latch-test-loading-graph',
          generateBundle(_options, bundle) {
            for (const item of Object.values(bundle))
              if (item.type === 'chunk')
                chunks.push({
                  file: item.fileName,
                  entry: item.isEntry,
                  imports: item.imports,
                  dynamicImports: item.dynamicImports,
                  bytes: Buffer.byteLength(item.code),
                  gzipBytes: gzipSync(item.code).length,
                  modules: Object.entries(item.modules)
                    .map(([id, detail]) => ({
                      id: id.replace(`${resolve('.')}/`, ''),
                      renderedLength: detail.renderedLength,
                    }))
                    .sort((a, b) => b.renderedLength - a.renderedLength),
                })
          },
        },
      ],
    })
    const initial = new Set<string>()
    const visit = (file: string) => {
      if (initial.has(file)) return
      const chunk = chunks.find(item => item.file === file)
      if (!chunk) return
      initial.add(file)
      chunk.imports.forEach(visit)
    }
    chunks.filter(chunk => chunk.entry).forEach(chunk => visit(chunk.file))
    const loaded = chunks.filter(chunk => initial.has(chunk.file))
    const modules = loaded.flatMap(chunk => chunk.modules)
    const report = {
      scope:
        'Production JS static-import graph. Dynamic import edges are reported separately; this does not measure network latency, parse time or first paint.',
      moduleMetric: 'renderedLength is the bundler-reported pre-minification transformed length, not an attribution of compressed bytes.',
      initial: [...initial],
      initialBytes: loaded.reduce((sum, item) => sum + item.bytes, 0),
      initialGzipBytes: loaded.reduce((sum, item) => sum + item.gzipBytes, 0),
      initialModules: modules,
      chunks,
    }
    await mkdir(resolve('test-results/bundle-loading'), { recursive: true })
    await writeFile(resolve('test-results/bundle-loading/report.json'), `${JSON.stringify(report, null, 2)}\n`)
    const ids = modules.map(module => module.id)
    expect(ids.some(id => id.includes('src/MessageContent.tsx'))).toBe(true)
    for (const optional of [
      'settings/PluginsSettings.tsx',
      'settings/DevicesSettings.tsx',
      'settings/AgentsSettings.tsx',
      'settings/ProvidersSettings.tsx',
      '/qrcode/',
      '/pdfjs-dist/',
      '/katex/',
      '/mermaid/',
    ])
      expect(
        ids.filter(id => id.includes(optional)),
        `${optional} must load only on demand`,
      ).toEqual([])
  }, 15_000)
})
