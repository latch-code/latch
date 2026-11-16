import { agentsOverview, OVERVIEW_ROWS } from '../agents/roster.ts'
import { useLayoutEffect } from 'react'
import { api, errorMessage, MessageError } from '../core/api.ts'
import { ShellPalette } from '../palette/ShellPalette.tsx'
import { ConfirmDialog, PromptDialog } from '../components/overlays.tsx'
import { toolRowId } from '../conversation.ts'
import { Button, Toast } from '@latch/ui'
import { settingsSections } from '../settings/SettingsPage.tsx'
import { ShortcutsOverlay } from './ShortcutsOverlay.tsx'
import { UsageSurface } from '../usage/UsageSurface.tsx'
import { LoginTerminalDialog } from '../panel/terminal/LoginTerminalDialog.tsx'
import { FillTerminalDialog } from '../panel/terminal/FillTerminalDialog.tsx'
import { RemoveWorktreeDialog, removalWords } from '../components/RemoveWorktreeDialog.tsx'
import type { ShellState } from './useShellLayout.tsx'
import { spaceOf } from '../sessions.ts'
import { canDelegate } from '../agents/model.ts'

/**
 * Lifts the window's toast 12 above the composer while one is on screen and not covered, centred on it, so it never lies
 * over the model control or the send button; without one, 12 above a phone's tab bar while it shows. The toast itself is ignored when asking what covers the composer: a tall one
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
        root.style.removeProperty('--toast-center')
        // A phone's root pages keep their tab bar (and the safe area under it) at the bottom: the toast stands above it.
        const tabs = document.querySelector<HTMLElement>('.phone-tabs')
        const bar = tabs && getComputedStyle(tabs).visibility !== 'hidden' ? tabs.getBoundingClientRect() : undefined
        if (bar && bar.height > 0) root.style.setProperty('--toast-clearance', `${window.innerHeight - bar.top + 12}px`)
        else root.style.removeProperty('--toast-clearance')
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
    sessionDrafts,
    draftSessionId,
    removingWorktree,
    setRemovingWorktree,
    setToast,
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
  // A 总览 already shows what waits in its own place as a card: Code's home for Code's sessions, 我的 Agent's for its topics.
  const toastTask = approvalToast ? snapshot.tasks.find(task => task.id === approvalToast.sessionId) : undefined
  const toastSpace = toastTask ? spaceOf(toastTask) : undefined
  // Only a card that is really in sight stands in for the toast: on a wide window's 总览, among the rows drawn before
  // 「还有 N 件」, and not while the Host withholds the list of Agents.
  const onAgentsHome =
    route.entry === 'agents'
    && route.myAgent === undefined
    && !route.topics
    && !shell.phone
    && snapshot.customAgents !== undefined
    && approvalToast !== null
    && agentsOverview(snapshot.tasks, shell.stopping)
      .attention.slice(0, OVERVIEW_ROWS)
      .some(task => task.id === approvalToast.sessionId)
  const shownApprovalToast =
    approvalToast && !(route.overview && toastSpace === 'code') && !(onAgentsHome && toastSpace === 'agents') ? approvalToast : null
  return (
    <>
      {commandOpen && <ShellPalette shell={shell} />}
      <UsageSurface
        snapshot={snapshot}
        access={access}
        phone={shell.phone}
        offline={shell.connection === 'offline' || shell.connection === 'reconnecting'}
      />
      {snapshot.catalog?.features?.terminal === true && <LoginTerminalDialog />}
      {snapshot.catalog?.features?.terminal === true && <FillTerminalDialog {...detachedWorkspace(snapshot.catalog)} />}
      {shortcutsOpen && (
        <ShortcutsOverlay
          spaces={shell.entries.includes('agents')}
          delegate={canDelegate(shell.snapshot, shell.access)}
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
              throw new MessageError(errorMessage(cause))
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
              throw new MessageError(errorMessage(cause))
            }
            setStopped(previous => {
              if (!previous.has(deleting.id)) return previous
              const next = new Map(previous)
              next.delete(deleting.id)
              return next
            })
            // Still open here: the Host's own report of the deletion may have closed it already, and pressing 新会话
            // on 新会话 would start that draft over.
            if (deleting.id === draftSessionId.current) choose(null)
            // Leaving it saved its text; the session is gone, so the text goes too.
            sessionDrafts.current.remove(deleting.id)
            await refresh()
          }}
        />
      )}
      {removingWorktree && (
        <RemoveWorktreeDialog
          target={{ kind: 'session', sessionId: removingWorktree.id }}
          title={removingWorktree.title || '未命名会话'}
          onClose={() => {
            setRemovingWorktree(null)
          }}
          onRemoved={result => {
            setToast({ text: removalWords(result), tone: 'ok' })
            void refresh()
          }}
        />
      )}
      {(shownApprovalToast || toast) && <ToastClearance />}
      {shownApprovalToast && (
        <Toast className="toast" duration={null}>
          <span>{toastSpace === 'agents' ? '另一个话题等你处理' : '另一个会话等你处理'}</span>
          <Button
            variant="ghost"
            onClick={() => {
              choose(shownApprovalToast.sessionId)
              const target = snapshot.approvals.find(item => item.id === shownApprovalToast.id)
              if (target) reading.show(target.sessionId, toolRowId(target))
              setApprovalToast(null)
            }}>
            查看
          </Button>
        </Toast>
      )}
      {!shownApprovalToast && toast && (
        <Toast className="toast" tone={toast.tone === 'error' ? 'error' : 'neutral'} duration={null}>
          {toast.text}
        </Toast>
      )}
    </>
  )
}

/** The project a command typed in outside any session goes to: the Host's default one. */
function detachedWorkspace(catalog: NonNullable<ShellState['snapshot']['catalog']>): { workspaceId: string; unavailable?: string } {
  const workspaceId = catalog.defaults.workspaceId ?? 'default'
  const workspace = catalog.workspaces.find(item => item.id === workspaceId)
  const unavailable = workspace ? workspace.unavailable : '找不到默认项目的文件夹'
  return { workspaceId, ...(unavailable ? { unavailable } : {}) }
}
