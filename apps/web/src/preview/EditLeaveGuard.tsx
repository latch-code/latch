import { useEffect } from 'react'
import { ConfirmDialog } from '@latch/ui'
import { answerLeave, useEditDrafts } from './editDrafts.ts'

/** Asks before a session switch drops an editor's unsaved text, and before a reload does. */
export function EditLeaveGuard() {
  const { leaving, unsaved } = useEditDrafts()
  useEffect(() => {
    if (!unsaved) return undefined
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault()
    }
    addEventListener('beforeunload', guard)
    return () => removeEventListener('beforeunload', guard)
  }, [unsaved])
  if (!leaving) return null
  return (
    <ConfirmDialog
      title="放弃你的修改？"
      message="还没有保存的修改会丢失。"
      confirmLabel="放弃"
      danger
      onConfirm={async () => {
        answerLeave(true)
      }}
      onClose={() => answerLeave(false)}
    />
  )
}
