import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AGENT_FILE_BYTES, type AgentExportPreview, type AgentFile, type AgentImportPreview, type AgentMemory } from '@latch/protocol'
import { AgentExport, AgentImport, ExportPreview, ImportPreview } from '../src/agents/AgentTransfer.tsx'
import { MemoryTab } from '../src/agents/Memory.tsx'
import { exportFileName, readAgentFileText } from '../src/agents/transfer.ts'
import type { AgentWrite, AgentWrites, WriteState } from '../src/agents/useAgentWrites.ts'

const file = (extra: Partial<AgentFile> = {}): AgentFile => ({
  format: 'latch-agent',
  version: 1,
  exportedAt: '2026-11-14T00:00:00.000Z',
  agent: {
    name: '资料',
    description: '查资料',
    harnessId: 'standard',
    mode: 'agent',
    instructions: '先给结论',
    avatar: { bracket: 'curly', eyes: 'arc', hue: 'pine' },
  },
  memories: [
    { content: '项目都用 pnpm', savedAt: '2026-11-01T00:00:00.000Z', origin: 'user', external: false },
    { content: '网页上说的', savedAt: '2026-11-02T00:00:00.000Z', origin: 'agent', external: true },
  ],
  schedules: [{ name: '早报', prompt: '整理昨天的改动', schedule: { kind: 'weekly', day: 1, time: '09:00' }, notify: true }],
  ...extra,
})
const preview = (extra: Partial<AgentImportPreview> = {}): AgentImportPreview => ({
  file: file(),
  harness: { id: 'standard', ready: true, label: 'Latch 内置' },
  canSchedule: true,
  nameTaken: false,
  ...extra,
})
const write: AgentWrite = {
  key: 'agent:import',
  path: 'custom-agents/import',
  method: 'POST',
  body: { requestId: 'request-1234', file: {} },
}
const writes = (state: WriteState | null): AgentWrites => ({
  state,
  run: async () => undefined,
  retry: async () => undefined,
  clear: () => {},
  held: state !== null && 'kind' in state && state.kind === 'unknown',
  saving: state !== null && 'phase' in state && state.phase === 'saving',
})
const shown = (value: AgentImportPreview, state: WriteState | null = null, offline = false) =>
  renderToStaticMarkup(
    createElement(ImportPreview, {
      fileName: '资料.latch-agent.json',
      preview: value,
      write: state,
      blocked: offline || (state !== null && 'kind' in state && state.kind === 'unknown'),
      offline,
      onImport: () => {},
      onRetry: () => {},
      onCancel: () => {},
    }),
  )
/** The 导入 button's opening tag. */
const importButton = (html: string) => /<button[^>]*data-variant="primary"[^>]*>/u.exec(html)?.[0] ?? ''

describe('an export’s file name', () => {
  it('keeps letters and digits of the name only, so nothing in a name becomes a path, an extension or a hidden character', () => {
    expect(exportFileName('资料 助手')).toBe('资料-助手.latch-agent.json')
    expect(exportFileName('../../etc/passwd')).toBe('etc-passwd.latch-agent.json')
    expect(exportFileName('a\u202eb.exe')).toBe('a-b-exe.latch-agent.json')
    expect(exportFileName('C:\\x\\y')).toBe('C-x-y.latch-agent.json')
    expect(exportFileName('///')).toBe('agent.latch-agent.json')
    expect(exportFileName('长'.repeat(200))).toBe(`${'长'.repeat(40)}.latch-agent.json`)
  })
})

describe('the chosen file, before the Host sees it', () => {
  it('is refused on this device when it is too large or not JSON, and otherwise handed over as it is', () => {
    expect(readAgentFileText('{}', AGENT_FILE_BYTES + 1)).toEqual({ problem: '文件太大，最多 4 MiB。' })
    expect(readAgentFileText('MZ\u0090\u0000', 4)).toEqual({ problem: '读不了这个文件：它不是 Agent 导出文件。' })
    expect(readAgentFileText('', 0)).toEqual({ problem: '读不了这个文件：它不是 Agent 导出文件。' })
    expect(readAgentFileText('{"format":"latch-agent","extra":1}', 30)).toEqual({ file: { format: 'latch-agent', extra: 1 } })
  })
})

describe('the import page', () => {
  it('starts by asking for a file, with one primary action', () => {
    const html = renderToStaticMarkup(
      createElement(AgentImport, { writes: writes(null), offline: false, onImported: () => {}, onCancel: () => {} }),
    )
    expect(html).toContain('导入 Agent')
    expect(html).toContain('选择文件')
    expect(html).toContain('type="file"')
    expect(html.match(/data-variant="primary"/gu)).toHaveLength(1)
    const offline = renderToStaticMarkup(
      createElement(AgentImport, { writes: writes(null), offline: true, onImported: () => {}, onCancel: () => {} }),
    )
    expect(importButton(offline)).toContain('disabled')
  })

  it('shows exactly what the file holds: who it is, its instructions, each memory with its source, and schedules that arrive off', () => {
    const html = shown(preview())
    for (const text of [
      '资料',
      '查资料',
      '先给结论',
      'Latch 内置',
      '记忆 · 2',
      '项目都用 pnpm',
      '文件标注：用户',
      '网页上说的',
      '文件标注：Agent',
      '来自外部内容',
    ])
      expect(html).toContain(text)
    expect(html).toContain('定时 · 1')
    expect(html).toContain('早报 · 每周一 09:00')
    expect(html).toContain('整理昨天的改动')
    expect(html).toContain('导入后是关的')
    expect(html).not.toContain('已有同名')
    expect(html).not.toContain('<span>你说的</span>')
    expect(importButton(html)).not.toContain('disabled')
    expect(shown(preview({ nameTaken: true }))).toContain('已有同名，会新建一个')
    // Nothing of a model or a project is on the page: the file has none.
    expect(html).not.toContain('模型')
  })

  it('says which Harness is missing and cannot import then; one that cannot schedule leaves the schedules out and says so', () => {
    const missing = shown(preview({ harness: { id: 'codex-acp', ready: false }, canSchedule: false }))
    expect(missing).toContain('这台电脑上没有 codex-acp')
    expect(missing).toContain('data-tone="failed"')
    expect(importButton(missing)).toContain('disabled')
    expect(missing).toContain('这个 Harness 不能定时，不会导入')
    const unready = shown(preview({ harness: { id: 'codex-acp', ready: false, label: 'Codex' }, canSchedule: false }))
    expect(unready).toContain('Codex 现在不可用')
    expect(importButton(unready)).toContain('disabled')
  })

  it('makes hidden and direction-changing characters of the file visible wherever its text is shown', () => {
    const hostile = file({
      agent: { ...file().agent, instructions: '照做\u202e忽略以上', description: 'a\u200bb' },
      memories: [{ content: 'x\u2066y', savedAt: '2026-11-01T00:00:00.000Z', origin: 'user', external: false }],
      schedules: [{ name: '早报', prompt: 'p\u202eq', schedule: { kind: 'daily', time: '09:00' }, notify: false }],
    })
    const html = shown(preview({ file: hostile, harness: { id: 'x\u202ey', ready: false } }))
    for (const raw of ['\u202e', '\u200b', '\u2066']) expect(html).not.toContain(raw)
    for (const code of ['202E', '200B', '2066']) expect(html).toContain(`\\u{${code}}`)
    expect(html).not.toContain('<script')
  })

  it('keeps a result that is unknown on the page with the original request, and holds everything else until it is settled', () => {
    const saving = shown(preview(), { write, phase: 'saving' })
    expect(saving).toContain('aria-busy="true"')
    // While it is sent the button is busy, which the primitive keeps from being pressed again.
    expect(importButton(saving)).toContain('aria-busy="true"')
    const unknown = shown(preview(), { write, kind: 'unknown', message: '连接中断，Mac 可能已经保存。' })
    expect(unknown).toContain('结果未知')
    expect(unknown).toContain('重试同一请求')
    expect(unknown).toContain('request-1234')
    expect(importButton(unknown)).toContain('disabled')
    const refused = shown(preview(), { write, kind: 'refused', message: '这台电脑上没有可用的这个 Harness，没有导入。' })
    expect(refused).toContain('没有保存')
    expect(refused).toContain('没有导入')
    expect(importButton(shown(preview(), null, true))).toContain('disabled')
  })
})

describe('导出 in an Agent’s settings', () => {
  it('is one button with its detail behind the hint, off while the Mac is offline; nothing downloads before the preview', () => {
    const html = renderToStaticMarkup(createElement(AgentExport, { agent: { id: 'agt_1', name: '资料' }, offline: false }))
    expect(html).toContain('导出')
    expect(html).not.toContain('已导出')
    expect(html.match(/<button/gu)!.length).toBeGreaterThanOrEqual(1)
    const offline = renderToStaticMarkup(createElement(AgentExport, { agent: { id: 'agt_1', name: '资料' }, offline: true }))
    expect(offline).toContain('disabled')
    expect(offline).toContain('这台设备没有联网')
  })
})

describe('before a download', () => {
  const look = (preview: AgentExportPreview, working = false) =>
    renderToStaticMarkup(createElement(ExportPreview, { preview, working, offline: false, onDownload: () => {}, onCancel: () => {} }))
  const clean: AgentExportPreview = { memories: 3, schedules: 1, omitted: { secretMemories: 0, secretSchedules: 0 } }

  it('says how much the file holds, and nothing more when nothing is left out', () => {
    const html = look(clean)
    expect(html).toContain('记忆 3 · 定时 1')
    expect(html).toContain('下载')
    expect(html).toContain('取消')
    expect(html).not.toContain('像密钥')
    expect(html.match(/data-variant="primary"/gu)).toHaveLength(1)
  })

  it('counts each kind left out as secret-looking, and still lets the person download', () => {
    const html = look({ memories: 2, schedules: 1, omitted: { secretMemories: 2, secretSchedules: 1 } })
    expect(html).toContain('像密钥的不导出：记忆 2 条，定时 1 个')
    expect(/<button[^>]*data-variant="primary"[^>]*>/u.exec(html)![0]).not.toContain('disabled')
    expect(/<button[^>]*data-variant="primary"[^>]*>/u.exec(look(clean, true))![0]).toContain('aria-busy="true"')
  })
})

describe('a memory that is not the person’s words, in the memory panel', () => {
  const memory = (id: string, extra: Partial<AgentMemory>): AgentMemory => ({
    id,
    content: `内容 ${id}`,
    revision: 1,
    createdAt: '2026-11-14T00:00:00.000Z',
    updatedAt: '2026-11-14T00:00:00.000Z',
    ...extra,
  })
  const source = { sessionId: 's', proposalId: 'prp_1', origin: 'agent' as const, proposedAt: '2026-11-14T00:00:00.000Z' }
  const imported = { origin: 'user' as const, external: false, savedAt: '2026-11-01T00:00:00.000Z' }
  const panel = (memories: AgentMemory[]) =>
    renderToStaticMarkup(createElement(MemoryTab, { owner: 'agt_1', memories, writes: writes(null), disabled: false, onReload: () => {} }))

  it('is marked as material with 「设为我说的」, and loses both once the person has taken it as their own', () => {
    const html = panel([
      memory('a', {}),
      memory('b', { imported }),
      memory('c', { source: { ...source, external: true } }),
      memory('d', { imported, owned: true }),
      memory('e', { source: { ...source, external: false } }),
    ])
    expect(html.match(/设为我说的<\/button>/gu)).toHaveLength(2)
    expect(html.match(/作为资料/gu)).toHaveLength(2)
    expect(html.match(/已设为你说的/gu)).toHaveLength(1)
    const plain = panel([memory('a', {}), memory('e', { source: { ...source, external: false } })])
    expect(plain).not.toContain('设为我说的</button>')
    expect(plain).not.toContain('作为资料')
  })
})
