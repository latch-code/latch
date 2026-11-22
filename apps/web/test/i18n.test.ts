import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_PRESETS, BUILTIN_HARNESS_LABEL } from '@latch/protocol'
import { testHarness } from '@latch/testkit'
import { api, ApiError, errorMessage, MessageError } from '../src/core/api.ts'
import { CONNECTION_WORDS } from '../src/core/computers.ts'
import { harnessName } from '../src/core/harnessName.ts'
import { harnessPresetCopy } from '../src/core/harnessPresetCopy.ts'
import { describeFailure } from '../src/core/securityCopy.ts'
import { shortcutRows } from '../src/workbenchShortcuts.ts'
import { auditActionLabel } from '../src/settings/auditCopy.ts'
import { pluginItems } from '../src/settings/PluginsSettings.tsx'
import { draftPermission, permissionView } from '../src/composer/permission.ts'
import {
  currentLocale,
  defineCopy,
  formatList,
  formatNumber,
  isLocalePreference,
  listText,
  plural,
  resolveLocale,
  setLocale,
  systemLocale,
} from '../src/core/i18n.ts'

afterEach(() => {
  vi.unstubAllGlobals()
  setLocale('zh-CN')
})

describe('the page language', () => {
  it('follows the preferred languages unless the device picked one', () => {
    expect(systemLocale(['en-US', 'zh-TW'])).toBe('en')
    expect(systemLocale(['fr', 'zh-TW', 'en-GB'])).toBe('zh-CN')
    expect(systemLocale(['fr', 'de'])).toBe('en')
    expect(systemLocale(['en-GB', 'de'])).toBe('en')
    expect(systemLocale([])).toBe('zh-CN')
    expect(resolveLocale('system', ['fr'])).toBe('en')
    expect(resolveLocale('en', ['zh-CN'])).toBe('en')
    expect(resolveLocale('zh-CN', ['en-US'])).toBe('zh-CN')
    expect(['system', 'zh-CN', 'en', 'en-US', '', null].map(isLocalePreference)).toEqual([true, true, true, false, false, false])
  })

  it('sets the document language even when the preferred language is already current', () => {
    const root = { lang: '' }
    vi.stubGlobal('document', { documentElement: root })

    setLocale('zh-CN')
    expect(root.lang).toBe('zh-CN')
    setLocale('en')
    expect(root.lang).toBe('en')
    expect(currentLocale()).toBe('en')
  })

  it('reads strings and functions from the current language through the same copy object', () => {
    const source = Object.freeze({ send: '发送', files: (count: number) => `${count} 个文件` })
    const copy = defineCopy(source, { send: 'Send', files: count => `${count} files` })
    expect(copy.send).toBe('发送')

    setLocale('en')
    expect(copy.send).toBe('Send')
    expect(copy.files(3)).toBe('3 files')
    expect(Object.keys(copy)).toEqual(['send', 'files'])

    setLocale('zh-CN')
    expect(copy.files(3)).toBe('3 个文件')
  })

  it('localizes the built-in Harness by its Host-assigned mark while preserving other names', () => {
    const builtin = testHarness('standard', { kind: 'builtin', label: BUILTIN_HARNESS_LABEL })
    const external = testHarness('custom-agent', { label: BUILTIN_HARNESS_LABEL })
    const named = testHarness('codex', { label: '团队 Codex' })
    expect(harnessName(builtin)).toBe(BUILTIN_HARNESS_LABEL)

    setLocale('en')
    expect(harnessName(builtin)).toBe('Built-in Latch')
    expect(harnessName(external)).toBe(BUILTIN_HARNESS_LABEL)
    expect(harnessName(named)).toBe('团队 Codex')
    expect(builtin.capabilities.display.label).toBe(BUILTIN_HARNESS_LABEL)
  })

  it('localizes the official direct and adapter descriptions while preserving other text for the same preset', () => {
    const codex = AGENT_PRESETS.find(preset => preset.id === 'codex')!
    const adapter = { ...codex, description: codex.fallback!.description }
    const changed = { ...codex, description: '主机上报的说明', installNote: '自己的安装说明' }
    expect(harnessPresetCopy(codex).description).toBe(codex.description)

    setLocale('en')
    expect(harnessPresetCopy(codex).description).toContain('Connects directly to Codex')
    expect(harnessPresetCopy(adapter).description).toContain('bundled with codex-acp')
    expect(harnessPresetCopy(codex).installNote).toBe('Version 0.156.0 or later')
    expect(harnessPresetCopy(changed)).toMatchObject({ description: changed.description, installNote: changed.installNote })
  })

  it('uses the current language for the chat-only permission in a draft and session', () => {
    const harness = testHarness('standard', { kind: 'builtin' })
    const current = () => permissionView({ harness, mode: 'chat', config: [], access: { legacy: false, local: false } })
    expect(draftPermission(harness, 'chat')?.label).toBe('不读写文件')
    expect(current()?.label).toBe('不读写文件')
    setLocale('en')
    expect(draftPermission(harness, 'chat')?.label).toBe('No file access')
    expect(current()).toMatchObject({ label: 'No file access', line: 'Replies with text only', asksNothing: true })
  })

  it('translates a built-in plugin label only when both its identity and label match', () => {
    const plugin = {
      id: 'workspace-files',
      name: '项目文件',
      description: '',
      version: '1',
      enabled: true,
      activeRuns: 0,
      capabilities: ['tool:write_file'],
    }
    const name = (item: Parameters<typeof pluginItems>[0][number]) => pluginItems([item], [])[0]?.name
    expect(name({ ...plugin, builtIn: true })).toBe('项目文件')

    setLocale('en')
    expect(name({ ...plugin, builtIn: true })).toBe('Project files')
    expect(name(plugin)).toBe('项目文件')
    expect(name({ ...plugin, builtIn: true, name: '自定义名称' })).toBe('自定义名称')
  })

  it('formats counts, lists and amounts with the active language', () => {
    const forms = { one: '{n} file', other: '{n} files' }
    const currencies = { style: 'currency', currency: 'CNY' } as const
    const items = ['A', 'B', 'C']
    expect(plural(1, { one: '{n} 个', other: '{n} 个文件' })).toBe('1 个文件')
    expect(formatList(items, 'disjunction')).toBe(new Intl.ListFormat('zh-CN', { type: 'disjunction' }).format(items))
    expect(formatNumber(1_234.5, currencies)).toBe(new Intl.NumberFormat('zh-CN', currencies).format(1_234.5))

    setLocale('en')
    expect(plural(1, forms)).toBe('1 file')
    expect(plural(1_200, forms)).toBe('1,200 files')
    expect(formatList(items)).toBe('A, B, and C')
    expect(formatNumber(1_234.5, currencies)).toBe(new Intl.NumberFormat('en', currencies).format(1_234.5))
  })

  it('names items one after another with 、 in Chinese and the English list form in English, never mixed', () => {
    const items = ['Codex', 'OpenCode', 'Claude Agent']
    expect(listText(items)).toBe('Codex、OpenCode、Claude Agent')
    expect(listText(items, 'unit')).toBe('Codex、OpenCode、Claude Agent')
    expect(listText(['Codex'])).toBe('Codex')

    setLocale('en')
    expect(listText(items, 'unit')).toBe('Codex, OpenCode, Claude Agent')
    expect(listText(items)).toBe('Codex, OpenCode, and Claude Agent')
    expect(listText(['Codex', 'OpenCode'])).toBe('Codex and OpenCode')
    expect(listText([])).toBe('')
    expect(listText(['Codex', undefined, '', 'OpenCode'], 'unit')).toBe('Codex, OpenCode')
  })

  it('changes an existing security refusal by code and never repeats untrusted text or targets', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            error: 'egress-denied',
            message: 'untrusted raw message',
            target: 'unexpected path',
          }),
          { status: 403 },
        ),
    )
    const failure: unknown = await api('probe').catch((cause: unknown) => cause)
    expect(failure).toBeInstanceOf(ApiError)
    if (!(failure instanceof ApiError)) throw new Error('expected-api-error')
    expect(failure.message).toContain('Latch 不会访问这个地址')
    setLocale('en')
    expect(failure.message).toContain('Latch will not reach this address')
    expect(failure.message).not.toMatch(/unexpected path|untrusted raw message/)
  })

  it('updates existing client errors, connection words and shortcut labels on language changes', () => {
    const copy = defineCopy({ expired: '请求已过期' }, { expired: 'Request expired' })
    const error = new MessageError(() => copy.expired)
    const settings = () => shortcutRows(false, false).find(row => row.id === 'settings')
    expect(errorMessage(error)).toBe('请求已过期')
    expect(describeFailure(500, 'unlisted-helper-error', { host: '原始响应' })).toBe('原始响应')
    expect(CONNECTION_WORDS.reconnecting).toBe('正在重连')
    expect(settings()).toMatchObject({ label: '设置' })

    setLocale('en')
    expect(errorMessage(error)).toBe('Request expired')
    expect(CONNECTION_WORDS.reconnecting).toBe('Reconnecting')
    expect(settings()).toMatchObject({ label: 'Settings' })
    expect(describeFailure(502, 'cert-error', { host: '原始响应' })).toContain('certificate is untrusted')
    expect(describeFailure(0, 'cli-link-failed', { host: '原始响应' })).toContain('Check permissions for ~/.local/bin')
    expect(describeFailure(404, 'post-reply-not-found', { host: '原始响应' })).toBe('This reply could not be found.')
    expect(describeFailure(500, 'unlisted-helper-error', { host: '原始响应' })).toBe(
      'The request did not finish (unlisted-helper-error). Try again.',
    )
  })

  it('describes known send failures without displaying the server message', () => {
    const raw = 'Server-only diagnostic'
    expect(describeFailure(504, 'agent-timeout', { host: raw })).toBe('Harness 没有在时限内答复。')
    expect(describeFailure(503, 'agent-start-failed', { host: raw })).toBe('Harness 未能启动，消息没有发出。')
    expect(describeFailure(409, 'command-queued', { host: raw })).toBe('这条命令不能排队或追加，请等本轮结束后发送。')

    setLocale('en')
    expect(describeFailure(504, 'agent-timeout', { host: raw })).toBe('The Harness didn’t respond in time.')
    expect(describeFailure(503, 'agent-start-failed', { host: raw })).toBe('The Harness couldn’t start. The message was not sent.')
    expect(describeFailure(409, 'command-queued', { host: raw })).toBe(
      'This command can’t be queued or added to a running turn. Send it when the turn finishes.',
    )
  })

  it('explains how to recover from a stale task or an incomplete request', () => {
    const raw = 'Server-only diagnostic'
    expect(describeFailure(409, 'item-changed', { host: raw })).toBe('待办已被修改，请刷新后再试。')
    expect(describeFailure(500, 'internal-error', { host: raw })).toBe('请求未完成。请刷新页面，核对当前状态后重试。')

    setLocale('en')
    expect(describeFailure(409, 'item-changed', { host: raw })).toBe('This task changed. Refresh and try again.')
    expect(describeFailure(500, 'internal-error', { host: raw })).toBe(
      'The request did not finish. Refresh the page and check the current state before trying again.',
    )
  })

  it('reads the display label for an audit action without translating its key', () => {
    const entry = { action: 'git.push', label: '推送' }
    expect(auditActionLabel(entry)).toBe('推送')
    setLocale('en')
    expect(auditActionLabel(entry)).toBe('Pushed changes')
    expect(auditActionLabel({ action: 'presence.helper.identity-pinned', label: '固定确认组件发布身份' })).toBe(
      'Pinned the confirmation helper’s release identity',
    )
    expect(auditActionLabel({ action: 'new.action', label: '新操作' })).toBe('new.action')
  })
})
