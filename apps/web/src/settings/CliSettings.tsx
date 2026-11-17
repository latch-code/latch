import { useEffect, useState } from 'react'
import { Button, Hint, InlineNotice } from '@latch/ui'
import { currentShell, type ShellCli } from '../core/shell.ts'
import { SettingsRow } from './common.tsx'

const PATH_LINE = 'export PATH="$HOME/.local/bin:$PATH"'

export function CliSettings() {
  const cli = currentShell()?.cli
  const [view, setView] = useState<ShellCli>()
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
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
  const label = view.status === 'linked' ? '已链接' : view.status === 'occupied' ? '被其他命令占用' : '未链接'
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
              disabled={busy || view.status !== 'unlinked'}
              onClick={() => {
                setBusy(true)
                void cli
                  .install()
                  .then(next => {
                    if (next) setView(next)
                  })
                  .catch(() => setView({ ...view, error: '没有完成命令行链接，请重试。' }))
                  .finally(() => setBusy(false))
              }}>
              {busy ? '正在链接…' : '链接 latch'}
            </Button>
          </>
        }
      />
      {view.status === 'linked' && !view.inPath && (
        <SettingsRow
          title={<Hint label={<code>{PATH_LINE}</code>}>复制后由你在终端中运行；Latch 不修改 shell 配置。</Hint>}
          trailing={
            <>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(PATH_LINE)
                    .then(() => setCopied(true))
                    .catch(() => setView({ ...view, error: '没有复制命令，请手动选择后复制。' }))
                }}>
                {copied ? '已复制' : '复制'}
              </Button>
            </>
          }
        />
      )}
      {view.error && <InlineNotice tone="error">{view.error}</InlineNotice>}
    </>
  )
}
