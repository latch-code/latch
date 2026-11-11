import { useLayoutEffect } from 'react'
import { api, errorMessage } from '../core/api.ts'
import { ShellPalette } from '../palette/ShellPalette.tsx'
import { ConfirmDialog, PromptDialog } from '../components/overlays.tsx'
import { toolRowId } from '../conversation.ts'
import { Button, Toast } from '@latch/ui'
import { settingsSections } from '../settings/SettingsPage.tsx'
import { ShortcutsOverlay } from './ShortcutsOverlay.tsx'
import type { ShellState } from './useShellLayout.tsx'

/**
 * Lifts the window's toast 12 above the composer while one is on screen and not covered, centred on it, so it never lies
 * over the model control or the send button. The toast itself is ignored when asking what covers the composer: a tall one
 * standing at its resting place would otherwise read as covering it and stay there. It tracks the composer's height, which
 * drawers and typing change while a toast shows, and a composer that appears only after the toast does.
 */
function ToastClearance() {
  useLayoutEffect(() => {
    const root = document.documentElement
    const composerInView = (composers: readonly HTMLElement[]) =>
      composers.find(element => {
        const box = element.getBoundingClientRect()
        if (box.height === 0) return false
        const top = document
          .elementsFromPoint(box.left + box.width / 2, box.top + box.height / 2)
          .find(candidate => !candidate.closest('.toast'))
        return top !== undefined && (element.contains(top) || top.contains(element))
      })
    const resized = new ResizeObserver(() => {
      measure()
    })
    let watched: readonly HTMLElement[] = []
    const measure = () => {
      const composers = [...document.querySelectorAll<HTMLElement>('.composer-stack')]
      if (composers.length !== watched.length || composers.some((element, index) => element !== watched[index])) {
        resized.disconnect()
        for (const element of composers) resized.observe(element)
        watched = composers
      }
      const composer = composerInView(composers)
      if (composer) {
        const box = composer.getBoundingClientRect()
        root.style.setProperty('--toast-clearance', `${window.innerHeight - box.top + 12}px`)
        root.style.setProperty('--toast-center', `${box.left + box.width / 2}px`)
      } else {
        root.style.removeProperty('--toast-clearance')
        root.style.removeProperty('--toast-center')
      }
    }
    measure()
    let frame = 0
    // Pages and dialogs that open or close change what is in view without resizing anything.
    const changed = new MutationObserver(() => {
      if (frame === 0)
        frame = requestAnimationFrame(() => {
          frame = 0
          measure()
        })
    })
    changed.observe(document.body, { childList: true, subtree: true })
    window.addEventListener('resize', measure)
    return () => {
      cancelAnimationFrame(frame)
      changed.disconnect()
      resized.disconnect()
      window.removeEventListener('resize', measure)
      root.style.removeProperty('--toast-clearance')
      root.style.removeProperty('--toast-center')
    }
  }, [])
  return null
}

/** What opens over the shell: the palette, the shortcuts, dialogs and toasts. */
export function Overlays({ shell }: { shell: ShellState }) {
  const {
    renaming,
    setRenaming,
    deleting,
    setDeleting,
    toast,
    setStopped,
    reading,
    choose,
    approvalToast,
    setApprovalToast,
    commandOpen,
    snapshot,
    selectedId,
    refresh,
    shortcutsOpen,
    setShortcutsOpen,
    openSettings,
    route,
    composerRef,
    access,
  } = shell
  return (
    <>
      {commandOpen && <ShellPalette shell={shell} />}
      {shortcutsOpen && (
        <ShortcutsOverlay
          onClose={() => {
            setShortcutsOpen(false)
            // The dialog gives the focus back to where it was; opened from nowhere in particular, it lands in the input.
            requestAnimationFrame(() => {
              if (route.entry === 'sessions' && (document.activeElement === null || document.activeElement === document.body))
                composerRef.current?.focus({ preventScroll: true })
            })
          }}
          onSettings={
            settingsSections(snapshot, access).includes('shortcuts')
              ? () => {
                  setShortcutsOpen(false)
                  openSettings('shortcuts')
                }
              : undefined
          }
        />
      )}
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
      {(approvalToast || toast) && <ToastClearance />}
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
