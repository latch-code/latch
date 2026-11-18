import { useEffect, useState } from 'react'
import { Button, Hint, InlineNotice, writeClipboard } from '@latch/ui'
import { latchExecutableWord } from '../core/commands.ts'
import { defineCopy } from '../core/i18n.ts'
import { describeFailure } from '../core/securityCopy.ts'
import { currentShell, type ShellCli } from '../core/shell.ts'
import { SettingsRow } from './common.tsx'

const PATH_LINE = 'export PATH="$HOME/.local/bin:$PATH"'
const COPY = defineCopy(
  {
    status: { linked: '已链接', occupied: '被其他命令占用', unlinked: '未链接' },
    commandLine: '命令行',
    occupied: (path: string) => `${path} 已存在，Latch 不会覆盖。`,
    copyFailed: '没有复制命令，请重试。',
    linkFailed: '没有完成命令行链接，请重试。',
    linking: '正在链接…',
    link: '链接 latch',
    copied: '已复制',
    copyCommand: '复制命令',
    pathHint: '复制后由你在终端中运行；Latch 不修改 shell 配置。',
    copy: '复制',
  },
  {
    status: { linked: 'Linked', occupied: 'Used by another command', unlinked: 'Not linked' },
    commandLine: 'Command line',
    occupied: (path: string) => `${path} already exists. Latch keeps the existing file.`,
    copyFailed: 'Couldn’t copy the command. Try again.',
    linkFailed: 'Couldn’t finish linking the command. Try again.',
    linking: 'Linking…',
    link: 'Link latch',
    copied: 'Copied',
    copyCommand: 'Copy command',
    pathHint: 'Copy and run this command in your terminal. Your shell configuration is left as it is.',
    copy: 'Copy',
  },
)

export function CliSettings() {
  const cli = currentShell()?.cli
  const [view, setView] = useState<ShellCli>()
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState<'command' | 'path'>()
  const [actionError, setActionError] = useState<'copyFailed' | 'linkFailed'>()
  useEffect(() => {
    let active = true
    void cli
      ?.get()
      .then(next => {
        if (active) setView(next)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [cli])
  if (!cli || !view || view.status === 'unavailable') return null
  const unlinked = view.status === 'unlinked'
  const launcher = latchExecutableWord(view.target)
  const label = COPY.status[view.status]
  const error = actionError ? COPY[actionError] : view.error && describeFailure(0, 'cli-link-failed', view.error)
  function copy(text: string, kind: 'command' | 'path') {
    setActionError(undefined)
    void writeClipboard(text)
      .then(() => setCopied(kind))
      .catch(() => setActionError('copyFailed'))
  }
  return (
    <>
      <SettingsRow
        title={COPY.commandLine}
        trailing={
          <>
            <Hint label={label}>{view.status === 'occupied' ? COPY.occupied(view.path) : `${view.path} → ${view.target}`}</Hint>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || (!unlinked && !launcher)}
              onClick={() => {
                if (!unlinked) {
                  if (launcher) copy(`${launcher} --help`, 'command')
                  return
                }
                setBusy(true)
                setActionError(undefined)
                void cli
                  .install()
                  .then(next => {
                    if (next) setView(next)
                  })
                  .catch(() => setActionError('linkFailed'))
                  .finally(() => setBusy(false))
              }}>
              {unlinked ? (busy ? COPY.linking : COPY.link) : copied === 'command' ? COPY.copied : COPY.copyCommand}
            </Button>
          </>
        }
      />
      {view.status === 'linked' && !view.inPath && (
        <SettingsRow
          title={<Hint label={<code>{PATH_LINE}</code>}>{COPY.pathHint}</Hint>}
          trailing={
            <Button size="sm" variant="secondary" onClick={() => copy(PATH_LINE, 'path')}>
              {copied === 'path' ? COPY.copied : COPY.copy}
            </Button>
          }
        />
      )}
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
    </>
  )
}
