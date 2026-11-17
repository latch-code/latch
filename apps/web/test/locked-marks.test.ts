import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Hint, InlineNotice, StatusWord } from '@latch/ui'
import { PermissionNote } from '../src/agents/parts.tsx'

/*
 * The words that speak of safety, or that wait for the person, keep the product's own tokens whatever customisation the
 * Host carries: they render with `data-lock`, which the token lock covers (packages/ui/src/tokens.css). What the lock
 * holds against is tested in the design system (packages/ui/test/custom.test.tsx).
 */
describe('the marks that stay the same under every customisation', () => {
  const html = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element)
  const pinned = (markup: string) => /^<[a-z]+[^>]* data-lock=""/u.test(markup)

  it('pins 不先问你 and 权限没确认 beside a name, and leaves a neutral note free', () => {
    for (const words of ['不先问你', '权限没确认']) {
      const markup = html(createElement(PermissionNote, { words, detail: '它动手前不问你。', tone: 'warn' }))
      expect(markup, words).toContain(words)
      expect(/<button[^>]* data-lock=""/u.test(markup), words).toBe(true)
    }
    expect(html(createElement(PermissionNote, { words: '先问你', detail: '', tone: 'neutral' }))).not.toContain('data-lock')
    expect(pinned(html(createElement(Hint, { label: '不先问你', locked: true })))).toBe(true)
    expect(html(createElement(Hint, { label: '先问你' }))).not.toContain('data-lock')
  })

  it('pins the provenance marks, a result that is unknown, what waits for the person and a failure; nothing else', () => {
    for (const [tone, words] of [
      ['warn', '来自外部内容'],
      ['warn', '结果未知'],
      ['waiting', '等你处理'],
      ['failed', '失败'],
    ] as const)
      expect(pinned(html(createElement(StatusWord, { tone, children: words }))), words).toBe(true)
    for (const tone of ['neutral', 'running', 'done'] as const)
      expect(html(createElement(StatusWord, { tone, children: '运行中' }))).not.toContain('data-lock')
    expect(pinned(html(createElement(InlineNotice, { tone: 'warn', title: '结果未知' })))).toBe(true)
    expect(pinned(html(createElement(InlineNotice, { tone: 'error', title: '没有保存' })))).toBe(true)
    expect(html(createElement(InlineNotice, { tone: 'neutral', title: '已保存' }))).not.toContain('data-lock')
    // A security banner is a security surface already; it is not marked twice.
    const secure = html(createElement(InlineNotice, { tone: 'warn', secure: true, title: '等待验证' }))
    expect([secure.includes('data-secure=""'), secure.includes('data-lock')]).toEqual([true, false])
  })
})

/**
 * Every place that says something of safety in words of its own, without one of the primitives above: the file, and
 * the piece of its source that carries the lock. A mark that loses its lock, or a file that moves, fails here.
 */
const LOCKED_SOURCES: ReadonlyArray<[file: string, what: string, needle: RegExp]> = [
  ['composer/PermissionList.tsx', '权限菜单（含不再询问的档位）', /className="permission-panel" data-lock=""/u],
  ['composer/PermissionChip.tsx', '琥珀色的权限 chip', /chip-permission[\s\S]{0,80}data-lock=\{view\.amber \? '' : undefined\}/u],
  ['composer/Composer.tsx', '运行条的「结果未知」', /className="run-bar-status" data-lock=""/u],
  [
    'composer/Composer.tsx',
    '只读输入框的原因（权限没确认）',
    /className="composer-readonly" role="note" data-lock=""[\s\S]+className="composer-readonly" role="note" data-lock=""/u,
  ],
  ['composer/QuestionDrawer.tsx', '提问卡', /<Drawer\s+ref=\{card\}\s+className="question-card"[\s\S]{0,160}data-lock=""/u],
  [
    'components/ToolCard.tsx',
    '工具卡的状态（结果未知）',
    /tool-card-state state-\$\{shown\}`\}[\s\S]{0,140}data-lock=\{shown === 'unknown' \|\| shown === 'interrupted' \? '' : undefined\}/u,
  ],
  ['shell/WorkbenchDecision.tsx', '决定与回答结果未知', /<StatusWord tone=\{unknown \? 'warn' : status\.tone\}>/u],
  ['shell/WorkbenchDecision.tsx', '执行结果尚未确认', /<p data-lock=\{task\.runEnd\?\.unknownResultCount \? '' : undefined\}>/u],
  // The warn tone is a locked tone: StatusWord carries the lock for it.
  ['shell/SessionOverview.tsx', '命令结果未知', /const tone: StatusTone = message\.interrupted\s+\? 'warn'/u],
  ['conversation/TurnCards.tsx', '恢复结果未知 · 重试', /className="undo-record-action"\s+data-lock=\{unknown \? '' : undefined\}/u],
  ['conversation/TurnCards.tsx', '恢复结果未知', /<span data-lock=""> · 恢复结果未知<\/span>/u],
  ['conversation/TurnCards.tsx', '撤销结果未知', /className="changed-files-why" data-lock="">\s*撤销结果未知/u],
  ['conversation/TurnCards.tsx', '结果未知 · 重试', /icon=\{UndoGlyph\}\s+data-lock=\{unknown \? '' : undefined\}/u],
  ['panel/delivery/parts.tsx', '交付的一行', /className="delivery-line" data-tone=\{tone\} data-lock=\{locked \? '' : undefined\}/u],
  ['panel/delivery/DeliveryPanel.tsx', '提交或推送结果未知', /<Line\s+locked\s[\s\S]+?\{what\}结果未知/u],
  ['panel/delivery/PullRequestSection.tsx', 'PR 结果未知', /<Line\s+locked\s[\s\S]+?PR 结果未知/u],
  ['phone-review/PhoneReview.tsx', '发送结果未知', /className="phone-review-foot-text" data-lock="">[\s\S]{0,160}发送结果未知/u],
  ['shell/ConversationView.tsx', '权限漂移与权限没确认的停止行', /className="composer-stop"\s+data-secure=""/u],
  ['composer/ApprovalDrawer.tsx', '审批卡（Drawer 的 secure 渲染 data-secure）', /<Drawer\s+className="approval-panel"\s+secure\s/u],
  ['agents/parts.tsx', '不先问你、权限没确认', /data-lock=\{tone === 'warn' \? '' : undefined\}[\s\S]+locked=\{amber\}/u],
  [
    'settings/SettingsPage.tsx',
    '设置 › 设备',
    /data-lock=\{panel === 'devices' \? '' : undefined\}[\s\S]+data-lock=\{panel === 'devices' \? '' : undefined\}/u,
  ],
]

describe('the places that say it in their own words', () => {
  it('each carry the lock, or are a security surface', () => {
    const missing = LOCKED_SOURCES.filter(([file, , needle]) => !needle.test(readFileSync(`apps/web/src/${file}`, 'utf8'))).map(
      ([file, what]) => `${file}：${what}`,
    )
    expect(missing).toEqual([])
  })

  it('leaves the turn footer’s own data-pinned alone: it is a different thing, and no token lock reads it', () => {
    expect(readFileSync('apps/web/src/components/TurnFooter.tsx', 'utf8')).toContain("data-pinned={pinned ? '' : undefined}")
    expect(readFileSync('packages/ui/src/tokens.css', 'utf8')).not.toContain('data-pinned')
  })
})
