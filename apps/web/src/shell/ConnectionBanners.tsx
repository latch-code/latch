import { AUDIT_COPY } from '../core/auditCheckpoint.ts'
import { DEVICE_PERMISSION_COPY } from '../core/permissions.ts'
import { hostNeedsStart } from '../core/shellLifecycle.ts'
import { Banner } from '../components/Banner.tsx'
import { Button, Hint, Icon, IconButton, InlineNotice, CloseGlyph, RefreshGlyph } from '@latch/ui'
import { restartLatch } from './UpdateCheck.tsx'
import type { ShellState } from './useShellLayout.tsx'
import { defineCopy } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    start: '启动 Latch',
    retry: '重试',
    restart: '重启 Latch',
    restartHelp: '怎么重启',
    checked: '已核对',
    dismiss: '关闭提示',
  },
  {
    start: 'Start Latch',
    retry: 'Retry',
    restart: 'Restart Latch',
    restartHelp: 'How to restart',
    checked: 'Reviewed',
    dismiss: 'Dismiss notice',
  },
)

/** The connection and the Host itself: over the open conversation, or at the top of a phone's list. */
export function ConnectionBanners({ shell }: { shell: ShellState }) {
  const { access, audit, connectionProblem, shellHost, hostProblem, connectionTitle, connectionText, resync, connection, oldHost } = shell
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
                  restartLatch(shell)
                }}>
                {COPY.start}
              </Button>
            ) : (
              <Button
                size="xs"
                onClick={() => {
                  void resync()
                }}>
                {COPY.retry}
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
                    restartLatch(shell)
                  }}>
                  {COPY.restart}
                </Button>
              ) : undefined
            }>
            <Hint inline lead={<Icon icon={RefreshGlyph} size={12} />} label={oldHost.label} moreLabel={COPY.restartHelp}>
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
                {COPY.checked}
              </Button>
              <IconButton className="banner-close" label={COPY.dismiss} icon={CloseGlyph} size="xs" onClick={audit.dismiss} />
            </span>
          }>
          {AUDIT_COPY.rollback}
        </InlineNotice>
      </Banner>
      <Banner show={access.legacy}>
        <InlineNotice tone="neutral" secure>
          {DEVICE_PERMISSION_COPY.legacyHost}
        </InlineNotice>
      </Banner>
    </>
  )
}
