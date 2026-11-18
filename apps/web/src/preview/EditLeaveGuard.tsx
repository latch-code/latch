import { useEffect } from 'react'
import { ConfirmDialog } from '@latch/ui'
import { defineCopy } from '../core/i18n.ts'
import { answerLeave, useEditDrafts } from './editDrafts.ts'

const COPY = defineCopy(
  { title: '放弃你的修改？', detail: '还没有保存的修改会丢失。', discard: '放弃' },
  { title: 'Discard your changes?', detail: 'Unsaved changes will be lost.', discard: 'Discard' },
)

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
      title={COPY.title}
      message={COPY.detail}
      confirmLabel={COPY.discard}
      danger
      onConfirm={async () => {
        answerLeave(true)
      }}
      onClose={() => answerLeave(false)}
    />
  )
}
