import { useCallback, useEffect, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'

import { GENERAL_AGENT_ID } from '@latch/protocol'
import {
  Button,
  ICON_STROKE,
  IconButton,
  InlineNotice,
  ChevronLeftGlyph,
  HistoryGlyph,
  PlusGlyph,
  OfflineGlyph,
  SettingsGlyph,
} from '@latch/ui'
import { useBackLayer } from '../hooks/backStack.ts'
import type { ShellState } from '../shell/useShellLayout.tsx'
import { NavTop, shellOverview, shellSpaces, ShellNewAgent, ShellNavFoot, SpaceSwitch } from '../shell/SpaceNav.tsx'
import { WorkbenchComputer } from '../shell/WorkbenchNav.tsx'
import { AgentsSpaceList } from './AgentsSpaceList.tsx'
import { askDelegateFocus } from './delegateFocus.ts'
import { HelperCreate } from './HelperCreate.tsx'
import { AgentImport } from './AgentTransfer.tsx'
import { AgentChat } from './AgentChat.tsx'
import { AgentsHome, WaitingCards } from './AgentsHome.tsx'
import { AgentTopics } from './AgentTopics.tsx'
import { GENERAL_NAME, readsAgents } from './model.ts'
import { LockedAgents } from './parts.tsx'
import { useAgentWrites } from './useAgentWrites.ts'

/**
 * The left of 我的 Agent on wide windows. 侧栏 layout: the sidebar's own top (the switch, 总览, 新建 Agent, 搜索, 定时任务),
 * the roster and the shared foot. 顶栏 layout: the top bar holds the navigation, so this is the queue's rail alone.
 */
function AgentsNav({ shell }: { shell: ShellState }) {
  if (shell.preferences.workbenchLayout === 'triage')
    return (
      <div className="triage-sidebar agents-rail agents-nav-body" data-space="agents">
        <AgentsSpaceList shell={shell} rail />
      </div>
    )
  return (
    <div className="sidebar-body agents-nav-body agents-sidebar" data-space="agents">
      <NavTop
        snapshot={shell.snapshot}
        spaces={shellSpaces(shell)}
        overview={shellOverview(shell)}
        primary={<ShellNewAgent shell={shell} />}
        onSearch={shell.openSearch}
        {...(shell.catalog?.features?.automations
          ? { onSchedules: () => shell.openMyAgent({ id: GENERAL_AGENT_ID, tab: 'schedules' }) }
          : {})}
        drawer={false}
        computerAtFoot
        onManageComputers={() => {
          shell.openSettings('computers')
        }}
      />
      <AgentsSpaceList shell={shell} />
      {/* The computer stands at the foot, where the sidebar beside a topic has it, so nothing moves between the two. */}
      <div className="sidebar-work-computer">
        <WorkbenchComputer shell={shell} />
      </div>
      <ShellNavFoot shell={shell} />
    </div>
  )
}

/**
 * 我的 Agent. Like 设置, it covers the session's columns without unmounting them. On wide windows the people stand at the
 * left (the 侧栏 layout's roster, or the 顶栏 layout's queue) and the work panel shows the space's 总览, 全部话题, the
 * creation page or a new topic with an Agent; in the 顶栏 layout 全部话题 takes the whole width, as Code's 全部会话 does.
 * On phones the roster or queue is the root page, and a topic, the creation page and 全部话题 are pushed over it. The panel
 * is the same element in both layouts, so a layout change keeps the Agent, the page and what was typed.
 */
export function AgentsPage({ shell }: { shell: ShellState }) {
  const { snapshot, route, phone, connection, titleSlot } = shell
  const offline = connection === 'offline'
  const target = route.myAgent
  const id = target?.id
  const chat = id !== undefined && id !== 'new'
  // 导入 is the creation page's other way in: from a file instead of the two steps. It has no route of its own and closes
  // when the creation page does.
  const [importing, setImporting] = useState(false)
  useEffect(() => {
    if (id !== 'new') setImporting(false)
  }, [id])
  const creating = importing ? '导入 Agent' : '新建 Agent'
  const topics = id === undefined && route.topics === true
  const home = id === undefined && !topics
  const locked = !readsAgents(snapshot)
  const refreshShell = shell.refresh
  const writes = useAgentWrites(
    useCallback(() => void refreshShell(), [refreshShell]),
    {
      origin: location.origin,
      deviceId: snapshot.device.id,
      allowed: snapshot.device.dataScope === 'all' && shell.access.scopes.has('view') && shell.access.scopes.has('run'),
    },
  )
  const back = () => {
    if (writes.saving || writes.held) return
    writes.clear()
    shell.setRoute({ entry: 'agents' })
  }
  const pushed = phone && !home
  useBackLayer(pushed, back)
  const escape = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || !phone || !pushed || event.defaultPrevented) return
    if (event.target instanceof Element && event.target.closest('dialog, [popover]')) return
    back()
  }
  // 顶栏 layout: 全部话题 takes the whole width, as Code's 全部会话 does. The 总览 keeps the queue beside it: an Agent with no
  // topic yet is on no lane, and the queue is the way to it.
  const wide = !phone && shell.preferences.workbenchLayout === 'triage' && topics
  const canCreate = shell.access.scopes.has('run') && !locked
  const triage = shell.preferences.workbenchLayout === 'triage'
  const spaces = shellSpaces(shell)
  return (
    <section
      aria-label="我的 Agent"
      className="settings-page agents-page"
      data-entry="agents"
      data-view={home ? 'home' : topics ? 'topics' : chat ? 'chat' : 'new'}
      data-wide={wide ? '' : undefined}
      data-chat={chat ? '' : undefined}
      onKeyDown={escape}>
      {!locked && id !== 'new' && writes.held && writes.state?.write.key === 'agent:new' && (
        <InlineNotice
          tone="warn"
          title="创建结果未知"
          action={<Button onClick={() => shell.openMyAgent({ id: 'new' })}>继续确认创建</Button>}>
          上一次创建还没有确认结果，原请求仍然保留。
        </InlineNotice>
      )}
      {!phone
        && titleSlot
        && id === 'new'
        && createPortal(
          <div className="agents-crumb">
            <span className="titlebar-page-title">{creating}</span>
            {offline && (
              <span className="agents-offline">
                <OfflineGlyph size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
                Mac 不在线
              </span>
            )}
          </div>,
          titleSlot,
        )}
      <div className="settings-layout" data-level={phone ? (pushed ? 'section' : 'root') : undefined}>
        <div className="settings-nav-pane" inert={pushed || wide || undefined} hidden={wide || undefined}>
          {phone ? (
            <>
              {/* 顶栏 layout: the top of a phone holds the switch between the places and 设置, as Code's home does there. */}
              <header className={spaces && triage ? 'settings-bar workbench-phone-heading' : 'settings-bar'}>
                {spaces && triage ? (
                  <SpaceSwitch {...spaces} />
                ) : (
                  <>
                    <span />
                    <h2>我的 Agent</h2>
                  </>
                )}
                {triage && shell.entries.includes('settings') && (
                  <IconButton size="lg" label="设置" icon={SettingsGlyph} onClick={() => shell.goEntry('settings')} />
                )}
                {offline ? (
                  <span className="agents-offline">
                    <OfflineGlyph size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
                    不在线
                  </span>
                ) : (
                  canCreate && (
                    <IconButton
                      size="lg"
                      label="新建 Agent"
                      icon={PlusGlyph}
                      onClick={() => {
                        shell.openMyAgent({ id: 'new' })
                      }}
                    />
                  )
                )}
              </header>
              <div className="settings-scroll">
                <div className="settings-content agents-root">
                  {!locked && <WaitingCards shell={shell} />}
                  <AgentsSpaceList shell={shell} />
                  {!locked && (
                    <Button
                      variant="ghost"
                      className="agents-root-topics"
                      icon={HistoryGlyph}
                      onClick={() => {
                        shell.openAgentTopics()
                      }}>
                      全部话题
                    </Button>
                  )}
                </div>
              </div>
            </>
          ) : (
            !wide && <AgentsNav shell={shell} />
          )}
        </div>
        <section
          className={chat ? 'settings-panel agent-chat-panel' : 'settings-panel'}
          aria-label={
            chat
              ? id === GENERAL_AGENT_ID
                ? GENERAL_NAME
                : (snapshot.customAgents?.find(agent => agent.id === id)?.name ?? 'Agent')
              : topics
                ? '全部话题'
                : home
                  ? '总览'
                  : creating
          }
          aria-hidden={(phone && !pushed) || undefined}
          inert={(phone && !pushed) || undefined}>
          {chat && (!phone || pushed) && <AgentChat key={id} shell={shell} owner={id} onBack={back} />}
          {/* A phone's root page is the roster or the queue; the 总览 is a wide window's. */}
          {home && !phone && <AgentsHome shell={shell} />}
          {topics && <AgentTopics shell={shell} onBack={back} />}
          {id === 'new' && (
            <>
              {phone && (
                <header className="settings-bar">
                  <IconButton label="返回" icon={ChevronLeftGlyph} onClick={back} />
                  <h2>{creating}</h2>
                </header>
              )}
              <div className="settings-scroll">
                <div className="settings-content agents-content settings-enter">
                  {locked && <LockedAgents />}
                  {!locked && importing && (
                    <AgentImport
                      writes={writes}
                      offline={offline}
                      onImported={agent => {
                        writes.clear()
                        void shell.refresh()
                        shell.setRoute({ entry: 'agents', myAgent: { id: agent.id } })
                      }}
                      onCancel={() => {
                        if (writes.saving || writes.held) return
                        writes.clear()
                        setImporting(false)
                      }}
                    />
                  )}
                  {!locked && !importing && snapshot.catalog && (
                    <div className="agent-page">
                      <Button
                        variant="ghost"
                        className="agents-import"
                        disabled={offline || writes.saving || writes.held}
                        onClick={() => {
                          writes.clear()
                          setImporting(true)
                        }}>
                        从文件导入
                      </Button>
                      <HelperCreate
                        key={snapshot.device.id}
                        catalog={snapshot.catalog}
                        access={shell.access}
                        agents={snapshot.customAgents ?? []}
                        writes={writes}
                        disabled={offline || locked}
                        onCreated={agent => {
                          writes.clear()
                          void shell.refresh()
                          askDelegateFocus()
                          shell.setRoute({ entry: 'agents', myAgent: { id: agent.id, topic: 'new' } })
                        }}
                        onCancel={back}
                        {...(shell.owner
                          ? { onSettings: () => shell.openSettings('engines'), onManageProviders: shell.manageProviders }
                          : {})}
                      />
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </section>
      </div>
    </section>
  )
}
