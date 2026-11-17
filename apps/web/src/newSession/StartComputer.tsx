import { useState } from 'react'
import { LaptopGlyph, ValuePicker } from '@latch/ui'
import { computerState, startComputers, useComputers } from '../core/computers.ts'
import { shellComputers } from '../core/shell.ts'

/**
 * 电脑 on the start screen, before 项目, once the desktop app holds more than one computer. This window's own computer is
 * the value; choosing another brings that computer's window forward on its own start screen, where its projects,
 * Harnesses and models are read from it. Nothing typed here goes along: each window keeps its own draft.
 */
export function StartComputer({ hostId, disabled = false }: { hostId: string | undefined; disabled?: boolean }) {
  const view = useComputers()
  const api = shellComputers()
  const [failed, setFailed] = useState('')
  const computers = startComputers(view)
  if (!api?.start || !hostId || computers.length === 0) return null
  return (
    <span className="start-computer" data-start-computer="">
      <ValuePicker<string>
        label="电脑"
        size="xs"
        width="md"
        align="start"
        leading={LaptopGlyph}
        value={hostId}
        disabled={disabled}
        valueText={computers.find(computer => computer.hostId === hostId)?.local ? '这台 Mac' : undefined}
        options={computers.map(computer => ({
          value: computer.hostId,
          label: computer.local ? '这台 Mac' : computer.name,
          ...(computer.local || computer.state === 'online' ? {} : { disabledReason: computerState(computer).text }),
        }))}
        onValueChange={next => {
          if (next === hostId) return
          setFailed('')
          void api.start?.(next).then(result => {
            if (!result.ok && result.message) setFailed(result.message)
          })
        }}
        {...(failed ? { hint: failed } : {})}
      />
    </span>
  )
}
