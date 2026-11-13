import { useState } from 'react'
import type { AgentHome as Home } from '@latch/protocol'
import { Button, Hint, InlineNotice, FolderOpenGlyph } from '@latch/ui'
import { VisibleText } from '../components/VisibleText.tsx'
import { currentShell, revealLabel, shellFolders } from '../core/shell.ts'
import { errorMessage } from '../core/api.ts'

export function AgentHome({ home, local, admin }: { home: Home | undefined; local: boolean; admin: boolean }) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const folders = local && admin ? shellFolders() : null
  return (
    <section className="agent-form-section">
      <h3>家</h3>
      <Hint label={home?.reason ?? '默认工作文件夹'} moreLabel="家的位置与说明">
        {home && (
          <>
            <VisibleText text={home.path} />
            <br />
          </>
        )}
        家是它默认干活的文件夹，不是隔离。选了项目时，那个话题在项目里做；删除 Agent 后文件夹留着。
      </Hint>
      {folders?.revealAgentHome && home && (
        <Button
          variant="ghost"
          size="sm"
          icon={FolderOpenGlyph}
          disabled={!home.available || busy}
          loading={busy}
          onClick={() => {
            setBusy(true)
            setError('')
            void folders.revealAgentHome!(home.owner)
              .then(result => {
                if (result.status === 'failed') setError('工作位置无法确认，请同步后重试。')
              })
              .catch(cause => setError(errorMessage(cause)))
              .finally(() => setBusy(false))
          }}>
          {revealLabel(currentShell()?.platform)}
        </Button>
      )}
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
    </section>
  )
}
