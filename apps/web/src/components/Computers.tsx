import { ChevronsUpDown, Laptop } from 'lucide-react'
import { ICON_STROKE, MenuFooterLink } from '@latch/ui'
import type { AppSnapshot, ComputerSummary } from '@latch/protocol'
import { ATTENTION_WORDS, computerState, olderVersion, type OtherWaiting } from '../core/computers.ts'
import { hostView } from '../core/permissions.ts'
import { computerName } from '../core/securityCopy.ts'
import { shellComputers, type ComputersView } from '../core/shell.ts'
import { relativeTime } from '../format.ts'
import { waitingCount } from '../sessions.ts'
import { Menu, type MenuSection } from './overlays.tsx'

const nameOf = (computer: Pick<ComputerSummary, 'local' | 'name'>) => (computer.local ? '这台 Mac' : computer.name)

/**
 * The sidebar's computer row in the desktop app once it reaches more than one computer: the computer this window
 * belongs to, and a menu of all of them with their state and what waits there; choosing one brings its window.
 * This page's own count comes from its own snapshot; another computer's only to this Mac's page, from main.
 */
export function ComputerMenu({
  snapshot,
  view,
  onManage,
}: {
  snapshot: AppSnapshot
  view: ComputersView
  onManage?: (() => void) | undefined
}) {
  const api = shellComputers()
  const hostId = hostView(snapshot)?.hostId
  const current = view.computers.find(computer => computer.hostId === hostId)
  const title = current ? nameOf(current) : computerName(snapshot.hostName)
  const here = current ? computerState(current) : undefined
  const own = waitingCount(snapshot)
  // Compared with this Mac's Host, which updates with the app; only this Mac's page knows it.
  const reference = view.computers.find(computer => computer.local)?.hostId === hostId ? snapshot.version : undefined
  const sections: MenuSection[] = [
    {
      id: 'computers',
      items: view.computers.map(computer => {
        const mine = computer.hostId === hostId
        const state = computerState(computer)
        const live = computer.state === 'online'
        const waiting = computer.waiting?.length ?? 0
        const count = mine ? own : live ? waiting : 0
        const stale = !mine && !live && waiting > 0 ? `离线前 ${waiting} 项` : undefined
        const older = !computer.local && olderVersion(computer.version, reference)
        return {
          id: computer.hostId,
          label: nameOf(computer),
          description: [state.text, stale].filter(Boolean).join(' · '),
          leading: <span className="computer-dot" data-state={computer.state} aria-hidden="true" />,
          ...(older ? { tag: <span className="computer-older">版本较旧</span> } : {}),
          ...(count > 0 ? { meta: <span className="computer-count">{count}</span> } : {}),
          checked: mine,
          onSelect: () => {
            if (!mine) void api?.open(computer.hostId)
          },
        }
      }),
    },
  ]
  return (
    <Menu
      label="电脑"
      selection
      sections={sections}
      footer={onManage ? () => <MenuFooterLink onClick={onManage}>管理电脑…</MenuFooterLink> : undefined}
      trigger={props => (
        <button {...props} type="button" className="sidebar-host sidebar-host-menu" data-computers={view.computers.length} title={title}>
          <Laptop size={16} strokeWidth={ICON_STROKE[16]} aria-hidden="true" />
          <span className="sidebar-host-name">{title}</span>
          {here && current?.state !== 'online' && <span className="sidebar-host-state">{here.text}</span>}
          <ChevronsUpDown className="sidebar-host-chevron" size={12} strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
        </button>
      )}
    />
  )
}

/**
 * 等你处理's rows from other computers, after this computer's own: a computer that answers lists its sessions, each with
 * its name on the second line, and clicking one opens that computer's window on it. One that does not answer is a single
 * grey row, 「离线前 N 项」: what waited before it went, not live.
 */
export function OtherComputersWaiting({ others, now }: { others: readonly OtherWaiting[]; now: number }) {
  const api = shellComputers()
  if (others.length === 0 || !api) return null
  return (
    <div className="other-computers" data-other-computers="">
      <p className="other-computers-label">其他电脑</p>
      <ul>
        {others.map(({ computer, items, live }) =>
          live ? (
            items.map(item => {
              const title = item.title || '未命名会话'
              const words = ATTENTION_WORDS[item.kind]
              return (
                <li key={`${computer.hostId}:${item.taskId}`} className="session-entry">
                  <div className="session-item is-strong" data-computer-item={computer.hostId}>
                    <button
                      type="button"
                      className="session-item-main"
                      data-attention-task={item.taskId}
                      title={`${computer.name} · ${title}`}
                      onClick={() => void api.open(computer.hostId, item.taskId)}>
                      <span className="session-line">
                        <span className="session-title">{title}</span>
                        <span className="session-status ui-status-time">{relativeTime(item.since, new Date(now))}</span>
                      </span>
                      <span className="session-meta" aria-hidden="true">
                        <Laptop className="session-computer-icon" size={12} strokeWidth={ICON_STROKE[12]} />
                        <span className="session-computer">{computer.name}</span>
                        <span className="session-wait">{`· ${words}`}</span>
                      </span>
                      <span className="sr-only">{`，${computer.name}，${words}`}</span>
                    </button>
                  </div>
                </li>
              )
            })
          ) : (
            <li key={computer.hostId} className="session-entry">
              <div className="session-item" data-computer-item={computer.hostId} data-stale="">
                <button
                  type="button"
                  className="session-item-main"
                  title={`${computer.name} · 不是实时`}
                  onClick={() => void api.open(computer.hostId)}>
                  <span className="session-line">
                    <span className="session-title">{computer.name}</span>
                    <span className="other-computers-stale">{`离线前 ${items.length} 项`}</span>
                  </span>
                  <span className="session-meta" aria-hidden="true">
                    <Laptop className="session-computer-icon" size={12} strokeWidth={ICON_STROKE[12]} />
                    <span className="session-meta-rest">{computerState(computer).text}</span>
                  </span>
                  <span className="sr-only">{`，${computerState(computer).text}，不是实时`}</span>
                </button>
              </div>
            </li>
          ),
        )}
      </ul>
    </div>
  )
}
