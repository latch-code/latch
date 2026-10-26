import { describe, expect, it } from 'vitest'
import { createPluginPackageTemplate } from '@latch/protocol'
import { addPluginSource, editPluginSource, readPluginBundle } from '../src/settings/pluginAssets.ts'

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
