import { ArrowLeft, Inbox, PanelLeft, SquarePen } from 'lucide-react'
import { Count, IconButton, useLivePrevious } from '@latch/ui'
import { currentShell } from '../core/shell.ts'
import { waitingCount } from '../sessions.ts'
import { ConversationHeader } from './ConversationHeader.tsx'
import type { ShellState } from './useShellLayout.tsx'

/**
 * The 52px row spanning the window. Its left zone holds the traffic lights' inset and ◧, with 新建会话 once the panel is
 * shut; the rest of the row is the conversation's header, or the title of a page. On the desktop app the row
 * moves the window, except over its controls.
 */
export function TitleBar({ shell }: { shell: ShellState }) {
  const {
    titlebar,
    route,
    sidebarColumn,
    sidebarCollapsed,
    drawerMode,
    drawer,
    setSidebarShut,
    sidebarToggle,
    startNew,
    goEntry,
    selectedId,
    snapshot,
    openApprovals,
    setTitleSlot,
  } = shell
  const desktop = currentShell()
  const approvals = waitingCount(snapshot)
  // The button shows only while something waits, so its count is told the value it rose from.
  const approvalsBefore = useLivePrevious(approvals)
  const sessions = route.entry === 'sessions'
  // What the shut panel would otherwise offer stays one click away here.
  const shut = sidebarColumn ? sidebarCollapsed : drawerMode && sessions
  return (
    <div
      ref={titlebar}
      className="titlebar"
      data-lights={desktop?.platform === 'darwin' ? '' : undefined}
      data-shut={shut ? '' : undefined}
      data-waiting={approvals > 0 ? '' : undefined}>
      <div className="titlebar-lead">
        {sidebarColumn ? (
          <IconButton
            ref={sidebarToggle}
            label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
            icon={PanelLeft}
            shortcut={desktop ? '⌘B' : 'Alt B'}
            aria-controls="session-navigation"
            aria-expanded={!sidebarCollapsed}
            onClick={() => {
              setSidebarShut(!sidebarCollapsed)
            }}
          />
        ) : (
          sessions && (
            <IconButton
              label="打开会话列表"
              icon={PanelLeft}
              aria-controls="session-navigation"
              aria-expanded={drawer.open}
              onClick={() => {
                drawer.show()
              }}
            />
          )
        )}
        {!shut && (sidebarColumn || !sessions) && <span className="titlebar-wordmark">Latch</span>}
        {shut && (
          <>
            {sessions ? (
              <IconButton label="新建会话" icon={SquarePen} pressed={selectedId === null} onClick={startNew} />
            ) : (
              <IconButton
                label="返回会话"
                icon={ArrowLeft}
                onClick={() => {
                  goEntry('sessions')
                }}
              />
            )}
            {approvals > 0 && (
              <IconButton
                label={`${approvals} 项等你处理`}
                icon={Inbox}
                badge={<Count tone="warn" value={approvals} from={approvalsBefore} />}
                onClick={openApprovals}
              />
            )}
          </>
        )}
      </div>
      {sessions ? <ConversationHeader shell={shell} /> : <header ref={setTitleSlot} className="topbar titlebar-page" />}
    </div>
  )
}
