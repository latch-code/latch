import { useCallback, useEffect, useState } from 'react'
import type { ReservedAttachments as Reserved } from '@latch/protocol'
import { Button, ConfirmDialog, Hint } from '@latch/ui'
import { api, ApiError, errorMessage, newRequestId, readPending, MessageError } from '../../core/api.ts'
import { sizeText } from '../../hooks/useAttachments.ts'
import { heldSubmission } from '../../hooks/useSubmission.ts'
import { SettingsGroup, SettingsRow } from '../common.tsx'

/**
 * This device's uploads still held for submissions it gave up (放弃这次提交): they count against its 32-file, 256 MB draft
 * quota until released. The Host releases only those it proves no saved message or request needs; an unconfirmed
 * submission of this device that carries attachments keeps the button off, since retrying it needs them.
 */
export function ReservedAttachments({ deviceId }: { deviceId: string }) {
  const [reserved, setReserved] = useState<Reserved | null>(null)
  const [asking, setAsking] = useState(false)
  // One request per confirmation: a retry after a lost answer gets the first answer.
  const [requestId, setRequestId] = useState(newRequestId)
  const [released, setReleased] = useState('')
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
  if (!reserved || (reserved.count === 0 && !released)) return null
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
        title="保留的附件"
        description={
          <Hint label={`${reserved.count} 个 · ${sizeText(reserved.bytes)}`}>
            放弃的提交还留着这些文件，它们占用这台设备的附件额度（32 个、256 MB）。只能释放没有消息用到的。
            {kept > 0 ? ` 有 ${kept} 个还可能被用到，先保留。` : ''}
          </Hint>
        }
        trailing={
          released && shown.length === 0 ? (
            <span className="settings-row-value">{released}</span>
          ) : (
            <Button
              disabled={shown.length === 0}
              title={shown.length === 0 ? '都还可能被用到' : undefined}
              onClick={() => {
                setRequestId(newRequestId())
                setAsking(true)
              }}>
              释放…
            </Button>
          )
        }
      />
      {asking && (
        <ConfirmDialog
          title="释放保留的附件"
          danger
          confirmLabel="释放"
          message={`删除 ${shown.length} 个没有消息用到的附件（${sizeText(shownBytes)}）？此操作无法撤销。`}
          onClose={() => setAsking(false)}
          onConfirm={async () => {
            try {
              const result = await api<{ released: { count: number; bytes: number } }>('attachments/reserved/release', {
                method: 'POST',
                body: { requestId, ids: shown.map(item => item.id) },
              })
              setReleased(`已释放 ${result.released.count} 个`)
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
