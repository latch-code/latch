import { useCallback, useEffect, useState } from 'react'
import type { ReservedAttachments as Reserved } from '@latch/protocol'
import { Button, ConfirmDialog, Hint } from '@latch/ui'
import { api, ApiError, errorMessage, newRequestId, readPending, MessageError } from '../../core/api.ts'
import { defineCopy, formatNumber, plural, useLocale } from '../../core/i18n.ts'
import { sizeText } from '../../hooks/useAttachments.ts'
import { heldSubmission } from '../../hooks/useSubmission.ts'
import { SettingsGroup, SettingsRow } from '../common.tsx'

const COPY = defineCopy(
  {
    title: '保留的附件',
    detail: '放弃的提交还留着这些文件，它们占用这台设备的附件额度（32 个、256 MB）。只能释放没有消息用到的。',
    retained: (count: number) => ` 有 ${formatNumber(count)} 个还可能被用到，先保留。`,
    possibleUse: '都还可能被用到',
    releaseAction: '释放…',
    releaseTitle: '释放保留的附件',
    release: '释放',
    summary: (count: number) => `${formatNumber(count)} 个`,
    confirm: (count: number, size: string) => `删除 ${formatNumber(count)} 个没有消息用到的附件（${size}）？此操作无法撤销。`,
    released: (count: number) => `已释放 ${formatNumber(count)} 个`,
  },
  {
    title: 'Reserved attachments',
    detail:
      'Abandoned submissions left these files in this device’s attachment quota of 32 files and 256 MB. You can release files that no message uses.',
    retained: (count: number) =>
      plural(count, { one: ' Keeping {n} file that may still be needed.', other: ' Keeping {n} files that may still be needed.' }),
    possibleUse: 'All files may still be needed',
    releaseAction: 'Release…',
    releaseTitle: 'Release reserved attachments',
    release: 'Release',
    summary: (count: number) => plural(count, { one: '{n} file', other: '{n} files' }),
    confirm: (count: number, size: string) =>
      `Permanently delete ${plural(count, { one: '{n} unused attachment', other: '{n} unused attachments' })} (${size})?`,
    released: (count: number) => plural(count, { one: 'Released {n} file', other: 'Released {n} files' }),
  },
)

/** What is still held: nothing held has no size (a released row never says 「0 个 · 1 KB」). */
export const reservedLabel = (reserved: { count: number; bytes: number }) =>
  reserved.count === 0 ? COPY.summary(0) : `${COPY.summary(reserved.count)} · ${sizeText(reserved.bytes)}`

/**
 * This device's uploads still held for submissions it gave up (放弃这次提交): they count against its 32-file, 256 MB draft
 * quota until released. The Host releases only those it proves no saved message or request needs; an unconfirmed
 * submission of this device that carries attachments keeps the button off, since retrying it needs them.
 */
export function ReservedAttachments({ deviceId }: { deviceId: string }) {
  useLocale()
  const [reserved, setReserved] = useState<Reserved | null>(null)
  const [asking, setAsking] = useState(false)
  // One request per confirmation: a retry after a lost answer gets the first answer.
  const [requestId, setRequestId] = useState(newRequestId)
  const [released, setReleased] = useState<number | null>(null)
  const load = useCallback(async () => {
    try {
      const result = await api<{ reserved: Reserved }>('attachments/reserved')
      setReserved(result.reserved)
    } catch (cause) {
      // An older Host has no such list; nothing to show.
      if (!(cause instanceof ApiError)) throw cause
      setReserved(null)
    }
  }, [])
  useEffect(() => {
    void load().catch(() => setReserved(null))
  }, [load])
  if (!reserved || (reserved.count === 0 && released === null)) return null
  // This device's unconfirmed submission keeps what it carries: a retry of it needs them. Stored, or held in memory when
  // storage cannot keep it.
  const held = [readPending(`latch.pending.${location.origin}.${deviceId}`), heldSubmission()]
  const keep = new Set(held.flatMap(item => (item ? [item.requestId] : [])))
  const shown = reserved.items.filter(item => item.releasable && !keep.has(item.requestId))
  const shownBytes = shown.reduce((sum, item) => sum + item.bytes, 0)
  const kept = reserved.count - shown.length
  return (
    <SettingsGroup>
      <SettingsRow
        title={COPY.title}
        description={
          <Hint label={reservedLabel(reserved)}>
            {COPY.detail}
            {kept > 0 ? COPY.retained(kept) : ''}
          </Hint>
        }
        trailing={
          released !== null && shown.length === 0 ? (
            <span className="settings-row-value">{COPY.released(released)}</span>
          ) : (
            <Button
              disabled={shown.length === 0}
              title={shown.length === 0 ? COPY.possibleUse : undefined}
              onClick={() => {
                setRequestId(newRequestId())
                setAsking(true)
              }}>
              {COPY.releaseAction}
            </Button>
          )
        }
      />
      {asking && (
        <ConfirmDialog
          title={COPY.releaseTitle}
          danger
          confirmLabel={COPY.release}
          message={COPY.confirm(shown.length, sizeText(shownBytes))}
          onClose={() => setAsking(false)}
          onConfirm={async () => {
            try {
              const result = await api<{ released: { count: number; bytes: number } }>('attachments/reserved/release', {
                method: 'POST',
                body: { requestId, ids: shown.map(item => item.id) },
              })
              setReleased(result.released.count)
            } catch (cause) {
              throw new MessageError(errorMessage(cause))
            } finally {
              // Read again either way: an answer that did not arrive may still have released them.
              await load().catch(() => {})
            }
          }}
        />
      )}
    </SettingsGroup>
  )
}
