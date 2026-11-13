import { AUDIT_ROLLBACK_TEXT } from '../core/auditCheckpoint.ts'
import { LEGACY_HOST_TEXT } from '../core/permissions.ts'
import { hostNeedsStart } from '../core/shellLifecycle.ts'
import { Banner } from '../components/Banner.tsx'
import { Button, Hint, Icon, IconButton, InlineNotice, CloseGlyph, RefreshGlyph } from '@latch/ui'
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
    oldHost,
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
      <Banner show={oldHost !== null && !connectionProblem}>
        {oldHost && (
          <InlineNotice
            tone="warn"
            title={oldHost.title}
            action={
              // Only the Latch app on that Mac starts its Host; anywhere else the person does it there.
              shellHost ? (
                <Button
                  size="xs"
                  onClick={() => {
                    void lifecycle.restartHost().then(message => {
                      if (message) setToast({ text: message, tone: 'error' })
                    })
                  }}>
                  重启 Latch
                </Button>
              ) : undefined
            }>
            <Hint lead={<Icon icon={RefreshGlyph} size={12} />} label={oldHost.label} moreLabel="怎么重启">
              {oldHost.detail}
            </Hint>
          </InlineNotice>
        )}
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
              <IconButton className="banner-close" label="关闭提示" icon={CloseGlyph} size="xs" onClick={audit.dismiss} />
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
