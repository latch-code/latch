import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { comparePending, pendingText, scanPending } from '../scripts/i18n-coverage.ts'

describe('interface translation coverage', () => {
  it('locates Chinese string, template and JSX text, including attributes', () => {
    const source = ["const one = '新会话' as const", 'const count = `${n} 个文件`', 'const node = <p title="关闭">设置</p>'].join('\n')
    expect(pendingText('view.tsx', source)).toEqual([
      { line: 1, text: '新会话' },
      { line: 2, text: ' 个文件' },
      { line: 3, text: '关闭' },
      { line: 3, text: '设置' },
    ])
  })

  it('ignores bilingual tables, comments, types, imports, regular expressions and logs', () => {
    const source = [
      '// 新会话',
      "import copy from './词表'",
      "export { default } from './词表'",
      "type Name = '新会话'",
      "const COPY = defineCopy({ a: '新会话' }, { a: 'New session' })",
      'const pattern = /分钟|小时/u',
      "console.warn('出错')",
      "console['warn']('仍然出错')",
      "const translated = 'New session'",
    ].join('\n')
    expect(pendingText('view.tsx', source)).toEqual([])
  })

  it('checks native dialog text but leaves transport errors and logs for their existing consumers', () => {
    const source = [
      "log('后台退出')",
      "const refusal = { ok: false, error: 'forbidden', message: '请求被拒绝' }",
      "const dialog = { title: '选文件夹', message: '请选择文件夹' }",
    ].join('\n')
    expect(pendingText('apps/desktop/src/example.cjs', source).map(item => item.text)).toEqual(['选文件夹', '请选择文件夹'])
    expect(pendingText('apps/web/src/example.ts', source).map(item => item.text)).toContain('请求被拒绝')
  })

  it('limits an allowance to the source file and phrase it names', () => {
    const source = "const label = '新内容哈希'; const hint = '核对新内容哈希'"
    expect(pendingText('apps/web/src/core/contentHash.ts', source).map(item => item.text)).toEqual(['核对新内容哈希'])
    expect(pendingText('apps/web/src/panel/copy.ts', source).map(item => item.text)).toEqual(['新内容哈希', '核对新内容哈希'])
  })

  it('counts product sources across Web, UI and desktop without traversing Host or declaration files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-i18n-coverage-'))
    try {
      const files = {
        'apps/web/src/view.tsx': 'const view = <p>设置</p>',
        'packages/ui/src/close.ts': "export const close = '关闭'",
        'packages/ui/src/skip.d.ts': "export declare const close = '关闭'",
        'apps/desktop/src/menu/items.cjs': "module.exports = [{ label: '关闭' }]",
        'apps/host/src/data.ts': "export const label = '主机数据'",
      }
      for (const [path, source] of Object.entries(files)) {
        const file = join(root, path)
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, source)
      }
      expect(await scanPending(root)).toEqual({
        'apps/web/src/view.tsx': 1,
        'packages/ui/src/close.ts': 1,
        'apps/desktop/src/menu/items.cjs': 1,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports growth per file even when the total pending count is lower', () => {
    expect(comparePending({ 'a.ts': 2, 'b.ts': 5, 'same.ts': 1 }, { 'a.ts': 3, 'new.ts': 1, 'same.ts': 1 })).toEqual({
      increased: [
        { path: 'a.ts', previous: 2, current: 3 },
        { path: 'new.ts', previous: 0, current: 1 },
      ],
      reduced: [{ path: 'b.ts', previous: 5, current: 0 }],
    })
  })
})
