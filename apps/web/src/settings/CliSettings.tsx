import { useEffect, useState } from 'react'
import { Button, Hint, InlineNotice, writeClipboard } from '@latch/ui'
import { latchExecutableWord } from '../core/commands.ts'
import { currentShell, type ShellCli } from '../core/shell.ts'
import { SettingsRow } from './common.tsx'

const PATH_LINE = 'export PATH="$HOME/.local/bin:$PATH"'

export function CliSettings() {
  const cli = currentShell()?.cli
  const [view, setView] = useState<ShellCli>()
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState<'command' | 'path'>()
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
  const label = view.status === 'linked' ? '已链接' : view.status === 'occupied' ? '被其他命令占用' : '未链接'
  function copy(text: string, kind: 'command' | 'path') {
    void writeClipboard(text)
      .then(() => setCopied(kind))
      .catch(() => setView(current => current && { ...current, error: '没有复制命令，请重试。' }))
  }
  return (
    <>
      <SettingsRow
        title="命令行"
        trailing={
          <>
            <Hint label={label}>
              {view.status === 'occupied' ? `${view.path} 已存在，Latch 不会覆盖。` : `${view.path} → ${view.target}`}
            </Hint>
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
                void cli
                  .install()
                  .then(next => {
                    if (next) setView(next)
                  })
                  .catch(() => setView({ ...view, error: '没有完成命令行链接，请重试。' }))
                  .finally(() => setBusy(false))
              }}>
              {unlinked ? (busy ? '正在链接…' : '链接 latch') : copied === 'command' ? '已复制' : '复制命令'}
            </Button>
          </>
        }
      />
      {view.status === 'linked' && !view.inPath && (
        <SettingsRow
          title={<Hint label={<code>{PATH_LINE}</code>}>复制后由你在终端中运行；Latch 不修改 shell 配置。</Hint>}
          trailing={
            <Button size="sm" variant="secondary" onClick={() => copy(PATH_LINE, 'path')}>
              {copied === 'path' ? '已复制' : '复制'}
            </Button>
          }
        />
      )}
      {view.error && <InlineNotice tone="error">{view.error}</InlineNotice>}
    </>
  )
}
