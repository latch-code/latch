import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createPluginPackageTemplate, type PluginPackageSummary } from '@latch/protocol'
import { creatorDrafts } from '../src/plugin-pages/AppDraftEntry.tsx'
import { CreatorPluginReview } from '../src/settings/CreatorPluginReview.tsx'

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
  it('presents the tool entry as inert text before the human can apply it', () => {
    const page = review('tool')
    expect(page).toContain('&lt;script&gt;inspectOnly()&lt;/script&gt;')
    expect(page).not.toContain('<script>inspectOnly()')
    expect(page).toContain('应用此草稿')
    expect(page).toContain('返回创作会话')
  })
  it('shows the local source for an external draft and offers to apply its reviewed files', () => {
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
    expect(page).toContain('文件夹中的插件内容')
    expect(page).toContain('&lt;script&gt;inspectOnly()&lt;/script&gt;')
    expect(page).toContain('应用此草稿')
    expect(page).not.toContain('返回创作会话')
  })
  it('marks hidden characters in reviewed source and filenames while preserving source layout', () => {
    const bundle = createPluginPackageTemplate('tool', 'made')
    const path = 'host-\u200B\t.mjs'
    const plain = '// Inspect the code\r\n\t// Keep indentation'
    const marked = plain + '\n\t// Inspect \u202Ethis comment'
    bundle.manifest.host = [path]
    bundle.files[0] = { path, content: plain }
    const render = () => renderToStaticMarkup(createElement(CreatorPluginReview, { bundle, record: summary, locked: false, error: '' }))
    expect(render()).toContain('>' + plain + '</pre>')
    bundle.files[0].content = marked
    const page = render()
    expect(page).toContain('aria-label="host-\\u{200B}\\u{0009}.mjs"')
    expect(page).toContain('>host-\\u{200B}\\u{0009}.mjs<')
    expect(page).toContain(plain + '\n\t// Inspect <span class="hidden-char"')
    expect(page).toContain('>\\u{202E}</span>this comment')
    expect(page).not.toMatch(/[\u200B\u202E]/u)
    expect(bundle.files[0]).toEqual({ path, content: marked })
  })
  it('describes how to use the applied skill, without offering to apply the same draft', () => {
    const page = review('skill', { ...summary, state: 'applied', enabled: true, appliedRevision: summary.revision })
    expect(page).toContain('为支持 Latch 技能的 Agent 选用')
    expect(page).not.toContain('应用此草稿')
  })
})
