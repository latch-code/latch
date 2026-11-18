import { useState } from 'react'
import { Button, Icon, LaptopGlyph, Tooltip } from '@latch/ui'
import { api, errorMessage } from '../core/api.ts'
import { defineCopy } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    stopHint: '已发出的操作可能还在 Cua Driver 里完成，Latch 撤不回',
    controllingHint: '这个会话的 Agent 正在操控这台 Mac 上的 App',
    stopping: '正在停止',
    controlling: '操控这台 Mac',
    stopMac: '停止操控这台 Mac',
    stop: '停',
  },
  {
    stopHint: 'Actions already sent may still finish in Cua Driver. Latch can’t undo them.',
    controllingHint: 'This session’s Agent is controlling apps on this Mac',
    stopping: 'Stopping',
    controlling: 'Mac control',
    stopMac: 'Stop controlling this Mac',
    stop: 'Stop',
  },
)

/**
 * 「操控这台 Mac」 in use in this session (`TaskDetail.computer`): a quiet chip, and 停, which ends this session's bridge
 * to the server (`POST /tasks/:id/computer-stop`). The agent keeps running without it until its process starts again.
 * `stopping`: a call already sent may still run in the driver, which Latch cannot recall; the chip says 正在停止.
 */
export function ComputerChip({ sessionId, stopping: ending = false }: { sessionId: string; stopping?: boolean }) {
  const [stopping, setStopping] = useState(false)
  const [failed, setFailed] = useState('')
  const stop = async () => {
    setStopping(true)
    setFailed('')
    try {
      await api(`tasks/${encodeURIComponent(sessionId)}/computer-stop`, { method: 'POST', body: {} })
    } catch (cause) {
      setFailed(errorMessage(cause))
    } finally {
      setStopping(false)
    }
  }
  return (
    <span className="topbar-computer-use" data-computer-use={ending ? 'stopping' : 'on'} data-failed={failed ? '' : undefined}>
      <Tooltip content={failed || (ending ? COPY.stopHint : COPY.controllingHint)}>
        <span className="topbar-computer-use-label" tabIndex={0}>
          <Icon icon={LaptopGlyph} size={12} />
          <span>{ending ? COPY.stopping : COPY.controlling}</span>
        </span>
      </Tooltip>
      {!ending && (
        <Button variant="ghost" size="xs" loading={stopping} onClick={() => void stop()} aria-label={COPY.stopMac}>
          {COPY.stop}
        </Button>
      )}
    </span>
  )
}
