import { X } from 'lucide-react'
import { AUDIT_ROLLBACK_TEXT } from '../core/auditCheckpoint.ts'
import { LEGACY_HOST_TEXT } from '../core/permissions.ts'
import { hostNeedsStart } from '../core/shellLifecycle.ts'
import { Banner } from '../components/Banner.tsx'
import { Button, IconButton, InlineNotice } from '@latch/ui'
import type { ShellState } from './useShellLayout.tsx'

/** The connection and the Host itself: over the open conversation, or at the top of a phone's list. */
export function ConnectionBanners({ shell }: { shell: ShellState }) {
  const {
    setToast,
    access,
    lifecycle,
    audit,
    connectionProblem,
    shellHost,
    hostProblem,
    connectionTitle,
    connectionText,
    resync,
    connection,
  } = shell
  return (
    <>
      <Banner show={Boolean(connectionProblem)}>
        <InlineNotice
          tone={hostProblem?.tone === 'error' && connection !== 'offline' ? 'error' : 'warn'}
          title={connectionTitle}
          action={
            shellHost && hostNeedsStart(shellHost) && connection !== 'offline' ? (
              <Button
                size="xs"
                onClick={() => {
                  void lifecycle.restartHost().then(message => {
                    if (message) setToast({ text: message, tone: 'error' })
                  })
                }}>
                启动 Latch
              </Button>
            ) : (
              <Button
                size="xs"
                onClick={() => {
                  void resync()
                }}>
                重试
              </Button>
            )
          }>
          {connectionText}
        </InlineNotice>
      </Banner>
      <Banner show={audit.rollback}>
        <InlineNotice
          tone="error"
          secure
          action={
            <span className="banner-actions">
              <Button size="xs" onClick={audit.accept}>
                已核对
              </Button>
              <IconButton className="banner-close" label="关闭提示" icon={X} size="xs" onClick={audit.dismiss} />
            </span>
          }>
          {AUDIT_ROLLBACK_TEXT}
        </InlineNotice>
      </Banner>
      <Banner show={access.legacy}>
        <InlineNotice tone="neutral" secure>
          {LEGACY_HOST_TEXT}
        </InlineNotice>
      </Banner>
    </>
  )
}
