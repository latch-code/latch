import { api, errorMessage } from '../core/api.ts'
import { ShellPalette } from '../palette/ShellPalette.tsx'
import { ConfirmDialog, PromptDialog } from '../components/overlays.tsx'
import { toolRowId } from '../conversation.ts'
import { Button, Toast } from '@latch/ui'
import { entrySection, settingsSections } from '../settings/SettingsPage.tsx'
import { PersonalPage } from '../personal/PersonalPage.tsx'
import type { ShellState } from './useShellLayout.tsx'

/** What opens over the shell: settings, personal assistants, the palette, dialogs and toasts. */
export function Overlays({ shell }: { shell: ShellState }) {
  const {
    privateVisible,
    route,
    setRoute,
    canPersonal,
    setPersonalDraft,
    personalGroupId,
    setPersonalGroupId,
    composerRef,
    renaming,
    setRenaming,
    deleting,
    setDeleting,
    toast,
    setStopped,
    access,
    reading,
    submission,
    choose,
    approvalToast,
    setApprovalToast,
    phone,
    setNewSheet,
    commandOpen,
    harness,
    snapshot,
    selectedId,
    refresh,
  } = shell
  const section = entrySection(route, settingsSections(snapshot, access), phone)
  return (
    <>
      {canPersonal && (
        <PersonalPage
          key={privateVisible ? 'private' : 'restricted'}
          open={section === 'assistants' || section === 'routines'}
          area={section === 'routines' ? 'routines' : 'assistants'}
          initialGroupId={personalGroupId}
          canStart={!submission.pending && !submission.sending}
          snapshot={snapshot}
          access={access}
          refreshHint={harness.refreshHints + harness.resyncs}
          onClose={() => {
            setPersonalGroupId(undefined)
            setRoute({ entry: route.entry })
          }}
          onChanged={() => {
            void refresh()
          }}
          onSession={id => {
            setPersonalGroupId(undefined)
            choose(id)
          }}
          onGroupSession={(id, groupId) => {
            setPersonalGroupId(groupId)
            choose(id)
          }}
          onStart={assistant => {
            if (submission.pending || submission.sending) return
            choose(null)
            setPersonalDraft(assistant)
            submission.setFork(null)
            setRoute({ entry: 'sessions' })
            if (phone) setNewSheet(true)
            else requestAnimationFrame(() => composerRef.current?.focus())
          }}
        />
      )}
      {commandOpen && <ShellPalette shell={shell} />}
      {renaming && (
        <PromptDialog
          title="重命名会话"
          label="会话名称"
          initial={renaming.title}
          maxLength={120}
          onClose={() => {
            setRenaming(null)
          }}
          onSubmit={async title => {
            try {
              await api<unknown>(`tasks/${encodeURIComponent(renaming.id)}`, { method: 'PATCH', body: { title } })
            } catch (cause) {
              throw new Error(errorMessage(cause))
            }
            await refresh()
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="删除会话"
          danger
          confirmLabel="删除"
          message={`删除「${deleting.title || '未命名会话'}」及其全部记录？此操作无法撤销。`}
          onClose={() => {
            setDeleting(null)
          }}
          onConfirm={async () => {
            try {
              await api<unknown>(`tasks/${encodeURIComponent(deleting.id)}`, { method: 'DELETE' })
            } catch (cause) {
              throw new Error(errorMessage(cause))
            }
            setStopped(previous => {
              if (!previous.has(deleting.id)) return previous
              const next = new Map(previous)
              next.delete(deleting.id)
              return next
            })
            if (deleting.id === selectedId) choose(null)
            await refresh()
          }}
        />
      )}
      {approvalToast && (
        <Toast className="toast" duration={null}>
          <span>另一个会话有请求等你处理。</span>
          <Button
            variant="ghost"
            onClick={() => {
              choose(approvalToast.sessionId)
              const target = snapshot.approvals.find(item => item.id === approvalToast.id)
              if (target) reading.show(target.sessionId, toolRowId(target))
              setApprovalToast(null)
            }}>
            查看
          </Button>
        </Toast>
      )}
      {!approvalToast && toast && (
        <Toast className="toast" tone={toast.tone === 'error' ? 'error' : 'neutral'} duration={null}>
          {toast.text}
        </Toast>
      )}
    </>
  )
}
