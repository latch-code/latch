import { useCallback, useEffect, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'

import { GENERAL_AGENT_ID, type AgentWorkComputer } from '@latch/protocol'
import { Button, ICON_STROKE, IconButton, InlineNotice, ChevronLeftGlyph, HistoryGlyph, PlusGlyph, OfflineGlyph } from '@latch/ui'
import { useBackLayer } from '../hooks/backStack.ts'
import type { ShellState } from '../shell/useShellLayout.tsx'
import { NavTop, shellOverview, shellSpaces, ShellNewAgent, ShellNavFoot } from '../shell/SpaceNav.tsx'
import { WorkbenchComputer } from '../shell/WorkbenchNav.tsx'
import { AgentsSpaceList } from './AgentsSpaceList.tsx'
import { askDelegateFocus } from './delegateFocus.ts'
import { AgentWorkComputerField } from './AgentWorkComputer.tsx'
import { useAgentList } from './useAgentData.ts'
import { HelperCreate } from './HelperCreate.tsx'
import { AgentImport } from './AgentTransfer.tsx'
import { AgentChat } from './AgentChat.tsx'
import { AgentsHome } from './AgentsHome.tsx'
import { AgentTopics } from './AgentTopics.tsx'
import { readsAgents } from './model.ts'
import { LockedAgents } from './parts.tsx'
import { AGENT_SPACE_COPY as COPY } from './spaceCopy.ts'
import { useAgentWrites } from './useAgentWrites.ts'
import { CONNECTION_COPY } from '../core/hostState.ts'

/**
 * The left of 我的 Agent on wide windows: the sidebar's own top (the switch, 总览, 新建 Agent, 搜索, 定时任务), the roster
 * and the shared foot.
 */
function AgentsNav({ shell }: { shell: ShellState }) {
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
 * left and the work panel shows the space's 总览, 全部话题, the creation page or a new topic with an Agent. On phones the
 * roster is the root page, and a topic, the creation page and 全部话题 are pushed over it.
 */
export function AgentsPage({ shell }: { shell: ShellState }) {
  const { snapshot, route, phone, connection, titleSlot } = shell
  const offline = connection === 'offline'
  const target = route.myAgent
  const id = target?.id
  const { read: creationList } = useAgentList(snapshot, id === 'new')
  const chat = id !== undefined && id !== 'new'
  // 导入 is the creation page's other way in: from a file instead of the two steps. It has no route of its own and closes
  // when the creation page does.
  const [importing, setImporting] = useState(false)
  const [computerDraft, setComputerDraft] = useState<{ deviceId: string; target: AgentWorkComputer }>()
  const workComputer = computerDraft?.deviceId === snapshot.device.id ? computerDraft.target : undefined
  const [pickingComputer, setPickingComputer] = useState(false)
  useEffect(() => {
    if (id !== 'new') {
      setImporting(false)
      setComputerDraft(undefined)
    }
  }, [id])
  const creating = importing ? COPY.importAgent : COPY.newAgent
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
  const canCreate = shell.access.scopes.has('run') && !locked
  return (
    <section
      aria-label={COPY.myAgents}
      className="settings-page agents-page"
      data-entry="agents"
      data-view={home ? 'home' : topics ? 'topics' : chat ? 'chat' : 'new'}
      data-chat={chat ? '' : undefined}
      onKeyDown={escape}>
      {!locked && id !== 'new' && writes.held && writes.state?.write.key === 'agent:new' && (
        <InlineNotice
          tone="warn"
          title={COPY.createUnknown}
          action={<Button onClick={() => shell.openMyAgent({ id: 'new' })}>{COPY.continueCreate}</Button>}>
          {COPY.originalRequest}
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
                {CONNECTION_COPY.offline}
              </span>
            )}
          </div>,
          titleSlot,
        )}
      <div className="settings-layout" data-level={phone ? (pushed ? 'section' : 'root') : undefined}>
        <div className="settings-nav-pane" inert={pushed || undefined}>
          {phone ? (
            <>
              <header className="settings-bar">
                <span />
                <h2>{COPY.myAgents}</h2>
                {offline ? (
                  <span className="agents-offline">
                    <OfflineGlyph size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
                    {COPY.offline}
                  </span>
                ) : (
                  canCreate && (
                    <IconButton
                      size="lg"
                      label={COPY.newAgent}
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
                  {home && !locked ? <AgentsHome shell={shell} compact /> : <AgentsSpaceList shell={shell} page />}
                  {!locked && (
                    <Button
                      variant="ghost"
                      className="agents-root-topics"
                      icon={HistoryGlyph}
                      onClick={() => {
                        shell.openAgentTopics()
                      }}>
                      {COPY.allTopics}
                    </Button>
                  )}
                </div>
              </div>
            </>
          ) : (
            <AgentsNav shell={shell} />
          )}
        </div>
        <section
          className={chat ? 'settings-panel agent-chat-panel' : 'settings-panel'}
          aria-label={
            chat
              ? id === GENERAL_AGENT_ID
                ? COPY.general
                : (snapshot.customAgents?.find(agent => agent.id === id)?.name ?? 'Agent')
              : topics
                ? COPY.allTopics
                : home
                  ? COPY.overview
                  : creating
          }
          aria-hidden={(phone && !pushed) || undefined}
          inert={(phone && !pushed) || undefined}>
          {chat && (!phone || pushed) && <AgentChat key={id} shell={shell} owner={id} onBack={back} />}
          {/* A phone's root page is the roster; the 总览 is a wide window's. */}
          {home && !phone && <AgentsHome shell={shell} />}
          {topics && <AgentTopics shell={shell} onBack={back} />}
          {id === 'new' && (
            <>
              {phone && (
                <header className="settings-bar">
                  <IconButton label={COPY.back} icon={ChevronLeftGlyph} onClick={back} />
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
                        {COPY.importFile}
                      </Button>
                      {snapshot.catalog.features?.agentWorkComputer && shell.access.local && canCreate && (
                        <AgentWorkComputerField
                          target={workComputer}
                          creating
                          disabled={offline || writes.saving || writes.held}
                          onManage={() => shell.openSettings('computers')}
                          onPicking={setPickingComputer}
                          onChange={next => setComputerDraft(next ? { deviceId: snapshot.device.id, target: next } : undefined)}
                        />
                      )}
                      <HelperCreate
                        workComputer={workComputer}
                        key={snapshot.device.id}
                        catalog={snapshot.catalog}
                        access={shell.access}
                        agents={snapshot.customAgents ?? []}
                        plugins={creationList.state === 'ready' ? creationList.value.plugins : undefined}
                        writes={writes}
                        disabled={offline || locked || pickingComputer}
                        onCreated={agent => {
                          writes.clear()
                          void shell.refresh()
                          askDelegateFocus()
                          shell.setRoute({ entry: 'agents', myAgent: { id: agent.id } })
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
