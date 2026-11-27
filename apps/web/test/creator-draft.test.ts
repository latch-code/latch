import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createPluginPackageTemplate, type PluginPackageSummary } from '@latch/protocol'
import { creatorDrafts } from '../src/plugin-pages/AppDraftEntry.tsx'
import { CreatorPluginReview, PluginFileViewer } from '../src/settings/CreatorPluginReview.tsx'

const noop = () => {}

describe('drafts delivered by a creator chat', () => {
  it('keeps the old single-app probe and associates each imported ID with only its own kind', () => {
    expect(creatorDrafts({ present: false })).toEqual([])
    expect(creatorDrafts({ present: true, pluginId: 'app-a' })).toEqual([{ kind: 'app', imported: true }])
    expect(creatorDrafts({ present: true, kind: 'plugin' })).toEqual([{ kind: 'plugin', imported: false }])
    expect(creatorDrafts({ present: true, kind: 'app', kinds: ['app', 'plugin'], pluginId: 'app-a', pluginIds: { app: 'app-a' } })).toEqual(
      [
        { kind: 'app', imported: true },
        { kind: 'plugin', imported: false },
      ],
    )
    expect(creatorDrafts({ present: true, kind: 'app', kinds: ['app', 'plugin'], pluginIds: { plugin: 'plugin-b' } })).toEqual([
      { kind: 'app', imported: false },
      { kind: 'plugin', imported: true },
    ])
  })
  const summary: PluginPackageSummary = {
    id: 'made',
    name: 'Made',
    version: '1',
    description: '',
    revision: 'one',
    state: 'draft',
    enabled: false,
    trusted: false,
    capabilities: [],
    source: { kind: 'plugin', sessionId: 'creator', dev: false },
  }
  const review = (kind: 'tool' | 'skill', record = summary) => {
    const bundle = createPluginPackageTemplate(kind, 'made')
    bundle.files[0]!.content = '<script>inspectOnly()</script>'
    return renderToStaticMarkup(
      createElement(CreatorPluginReview, { bundle, record, locked: false, error: '', onApply: noop, onUpdate: noop, onOpenSession: noop }),
    )
  }
  it('keeps source out of the initial installation view', () => {
    const page = review('tool')
    expect(page).not.toContain('inspectOnly')
    expect(page).not.toContain('creator-plugin-source')
    expect(page).toContain('审阅安装')
    expect(page.indexOf('审阅安装')).toBeLessThan(page.indexOf('<details'))
    expect(page).toMatch(/<details[^>]*><summary>文件与源码/u)
    expect(page).toContain('返回创作会话')
  })
  it('offers to install a saved external package even when it has no creator chat', () => {
    const { source: _creator, ...draft } = summary
    const page = review('tool', {
      ...draft,
      external: {
        source: { kind: 'local-folder', directory: '/plugins' },
        pluginId: draft.id,
        path: 'sample',
        revision: draft.revision,
        version: draft.version,
      },
    })
    expect(page).toContain('审阅安装')
    expect(page).not.toContain('返回创作会话')
  })
  it('marks hidden characters in reviewed source and filenames while preserving source layout', () => {
    const bundle = createPluginPackageTemplate('tool', 'made')
    const path = 'host-\u200B\t.mjs'
    const plain = '// Inspect the code\r\n\t// Keep indentation'
    const marked = plain + '\n\t// Inspect \u202Ethis comment'
    bundle.manifest.host = [path]
    bundle.files[0] = { path, content: plain }
    const render = () => renderToStaticMarkup(createElement(PluginFileViewer, { bundle }))
    // The highlighter reads line endings as \n; every other character is shown as written.
    const shown = plain.replace('\r\n', '\n')
    expect(render()).toContain('>' + shown + '</pre>')
    bundle.files[0].content = marked
    const page = render()
    expect(page).toContain('aria-label="host-\\u{200B}\\u{0009}.mjs"')
    expect(page).toContain('>host-\\u{200B}\\u{0009}.mjs<')
    expect(page).toContain(shown + '\n\t// Inspect <span class="hidden-char"')
    expect(page).toContain('>\\u{202E}</span>this comment')
    expect(page).not.toMatch(/[\u200B\u202E]/u)
    expect(bundle.files[0]).toEqual({ path, content: marked })
    bundle.files[0].content = '<script>inspectOnly()</script>'
    expect(render()).toContain('&lt;script&gt;inspectOnly()&lt;/script&gt;')
  })
  it('describes how to use the applied skill, without offering to apply the same draft', () => {
    const page = review('skill', { ...summary, state: 'applied', enabled: true, appliedRevision: summary.revision })
    expect(page).toContain('为支持 Latch 技能的 Agent 选用')
    expect(page).not.toContain('审阅安装')
  })
  it('distinguishes a saved release from edits to that release even if the version number is unchanged', () => {
    const installed: PluginPackageSummary = {
      ...summary,
      state: 'update-available',
      appliedRevision: 'old',
      appliedVersion: '0.9',
      catalog: { revision: summary.revision, version: summary.version },
    }
    const update = review('tool', installed)
    expect(update).toContain('审阅更新')
    expect(update).toContain('并启用插件')
    const edited = review('tool', { ...installed, revision: 'edited' })
    expect(edited).toContain('审阅修改')
    expect(edited).not.toContain('审阅更新')
  })
})
