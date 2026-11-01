import { describe, expect, it } from 'vitest'
import { createPluginPackageTemplate } from '@latch/protocol'
import {
  addPluginSource,
  editPluginSource,
  readPluginBundle,
  manifestReach,
  packageReach,
  pluginReach,
  typedManifest,
} from '../src/settings/pluginAssets.ts'
import { pluginItems, shelfOf } from '../src/settings/PluginsSettings.tsx'

describe('editable plugin imports', () => {
  it.each(['skill', 'tool', 'react-ui'] as const)('round-trips the %s template without executing its source', kind => {
    const bundle = createPluginPackageTemplate(kind)
    expect(readPluginBundle(JSON.stringify(bundle))).toEqual(bundle)
  })
  it('preserves all unrelated contributions while editing and adding sources', () => {
    const bundle = createPluginPackageTemplate('skill')
    const next = addPluginSource(editPluginSource(bundle, 'SKILL.md', '按项目事实完成工作。'), 'tools/format.mjs')
    expect(next.manifest).toEqual(bundle.manifest)
    expect(next.files).toEqual([
      { path: 'SKILL.md', content: '按项目事实完成工作。' },
      { path: 'tools/format.mjs', content: '' },
    ])
    expect(bundle.files[0]!.content).not.toBe(next.files[0]!.content)
  })
  it.each(['../outside', '/root.mjs', 'a//b', 'a/./b', 'C:/x', 'a\\x', 'SKILL.md', 'skill.MD', 'SKILL.md/child', 'latch-plugin.json'])(
    'refuses an ambiguous file path %s',
    path => {
      expect(() => addPluginSource(createPluginPackageTemplate('skill'), path)).toThrow()
    },
  )
  it.each([null, [], {}, { manifest: {} }, { manifest: { ...createPluginPackageTemplate('skill').manifest, skills: [null] }, files: [] }])(
    'refuses an import the editor cannot render safely',
    input => {
      expect(() => readPluginBundle(JSON.stringify(input))).toThrow()
    },
  )
  it('counts UTF-8 bytes and bounds file contents before putting them in the editor', () => {
    const bundle = createPluginPackageTemplate('skill')
    bundle.files[0]!.content = '文'.repeat(340000)
    expect(() => readPluginBundle(JSON.stringify(bundle))).toThrow()
  })
})

describe('where a plugin runs', () => {
  const manifest = { formatVersion: 1 as const, id: 'p', name: 'p', version: '1', description: '' }
  const ids = (reach: Array<{ id: string }>) => reach.map(item => item.id)

  it('names each part the manifest holds, as it is edited', () => {
    expect(ids(manifestReach(manifest))).toEqual([])
    expect(ids(manifestReach({ ...manifest, panels: [{ id: 'a', title: 'a', entry: 'a.mjs' }] }))).toEqual(['page'])
    expect(ids(manifestReach({ ...manifest, host: ['a.mjs'] }))).toEqual(['host'])
    expect(ids(manifestReach({ ...manifest, skills: [{ id: 's', name: 's', description: '', file: 's.md' }] }))).toEqual(['text'])
  })

  it('follows the manifest as typed in the advanced tab, since applying there applies that text', () => {
    const typed = JSON.stringify({ ...manifest, panels: [{ id: 'a', title: 'a', entry: 'a.mjs' }] })
    expect(ids(manifestReach(typedManifest(typed, manifest)))).toEqual(['page'])
    expect(typedManifest('{ not json', manifest)).toBe(manifest)
    expect(typedManifest('[]', manifest)).toBe(manifest)
  })

  it('counts a connection plugin as code on the Mac', () => {
    expect(ids(pluginReach({ capabilities: ['transport:relay'] }))).toEqual(['host'])
  })

  it('names a panel a Host module registered, which its manifest never declares', () => {
    expect(ids(packageReach({ ...manifest, host: ['a.mjs'] }, { capabilities: ['ui:a'] }))).toEqual(['page', 'host'])
  })

  it('keeps naming a panel the applied revision delivers after a draft removed it', () => {
    expect(ids(packageReach(manifest, { capabilities: ['ui:a'] }))).toEqual(['page'])
  })

  it('says what the Host runs before the manifest is read, or when it cannot be', () => {
    expect(ids(packageReach(undefined, { capabilities: ['tool:a'] }))).toEqual(['host'])
    expect(ids(packageReach(undefined, { capabilities: [] }))).toEqual([])
  })

  it('reads the same from what a loaded plugin provides', () => {
    expect(ids(pluginReach({ capabilities: ['ui:panel', 'tool:read'] }))).toEqual(['page', 'host'])
    expect(ids(pluginReach({ capabilities: ['skill:x'] }))).toEqual(['text'])
    expect(ids(pluginReach({ capabilities: [] }))).toEqual([])
  })
})

describe('plugin shelves', () => {
  it('stands a plugin on the shelf named for what it does', () => {
    expect(shelfOf(['tool:read'])).toBe('tool')
    expect(shelfOf(['ui:panel', 'skill:x'])).toBe('tool')
    expect(shelfOf(['skill:x'])).toBe('skill')
    expect(shelfOf(['provider:openai'])).toBe('provider')
    expect(shelfOf(['harness:acp'])).toBe('engine')
    expect(shelfOf(['transport:relay'])).toBe('connection')
  })

  it('lists a package once, with its own state, and a loaded plugin it owns not again', () => {
    const plugin = { id: 'mine', name: 'mine', version: '1', description: '', enabled: true, activeRuns: 0, capabilities: ['skill:x'] }
    const other = { ...plugin, id: 'core', name: 'core', capabilities: ['tool:read'], managed: 'core' as const }
    const record = {
      id: 'mine',
      name: '我的技能',
      version: '1',
      description: '',
      revision: 'r',
      enabled: true,
      trusted: false,
      capabilities: ['skill:x'],
      state: 'applied' as const,
    }
    expect(pluginItems([plugin, other], [record]).map(item => [item.key, item.name, item.state])).toEqual([
      ['package:mine', '我的技能', '已开启'],
      ['plugin:core', 'core', '始终开启'],
    ])
  })
})
