import { useState } from 'react'
import type { AgentHome as Home } from '@latch/protocol'
import { Button, Hint, InlineNotice, FolderOpenGlyph } from '@latch/ui'
import { VisibleText } from '../components/VisibleText.tsx'
import { currentShell, revealLabel, shellFolders } from '../core/shell.ts'
import { errorMessage } from '../core/api.ts'
import { defineCopy } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    title: '家',
    folder: '默认工作文件夹',
    purpose: '家是它默认干活的文件夹，不是隔离。选了项目时，那个话题在项目里做；删除 Agent 后文件夹留着。',
    failed: '工作位置无法确认，请同步后重试。',
  },
  {
    title: 'Home',
    folder: 'Default work folder',
    purpose:
      'The Agent works here by default. The folder offers no isolation. Topics with a project run in that project. Deleting the Agent keeps the folder.',
    failed: 'The work location couldn’t be confirmed. Sync and try again.',
  },
)

export function AgentHome({ home, local, admin }: { home: Home | undefined; local: boolean; admin: boolean }) {
  const [failure, setFailure] = useState<{ unverified: true } | { cause: unknown }>()
  const [busy, setBusy] = useState(false)
  const folders = local && admin ? shellFolders() : null
  const error = failure && ('unverified' in failure ? COPY.failed : errorMessage(failure.cause))
  return (
    <section className="agent-form-section">
      <h3>{COPY.title}</h3>
      <Hint label={home?.reason ?? COPY.folder}>
        {home && (
          <>
            <VisibleText text={home.path} />
            <br />
          </>
        )}
        {COPY.purpose}
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
            setFailure(undefined)
            void folders.revealAgentHome!(home.owner)
              .then(result => {
                if (result.status === 'failed') setFailure({ unverified: true })
              })
              .catch(cause => setFailure({ cause }))
              .finally(() => setBusy(false))
          }}>
          {revealLabel(currentShell()?.platform)}
        </Button>
      )}
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
    </section>
  )
}
