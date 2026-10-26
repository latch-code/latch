import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowRight, Pencil, Plus, Square, UsersRound } from 'lucide-react'
import type { PersonalAssistantSummary, PersonalGroup, PersonalGroupConfig, PersonalGroupDetail } from '@latch/protocol'
import {
  Button,
  Checkbox,
  ConfirmDialog,
  Dialog,
  EmptyState,
  Icon,
  InlineNotice,
  Loading,
  StatusPill,
  TextAreaField,
  TextField,
  ValuePicker,
} from '@latch/ui'
import { api, ApiError, inlineError, newRequestId } from '../core/api.ts'
import { dateTime, relativeTime } from '../format.ts'
import { VisibleText } from '../components/VisibleText.tsx'
import { NavRow, SectionHeading, SettingsGroup } from '../settings/common.tsx'
import {
  activeGroupTurn,
  groupConfig,
  groupConfigProblem,
  groupInput,
  groupOutcome,
  groupPath,
  groupReason,
  type GroupDraft,
  type PersonalMutation,
} from './model.ts'

export interface GroupPageProps {
  groups: readonly PersonalGroup[]
  assistants: readonly PersonalAssistantSummary[]
  groupId: string | null
  draft: GroupDraft
  onDraft: (update: (previous: GroupDraft) => GroupDraft) => void
  onSelect: (id: string | null) => void
  writable: boolean
  locked: boolean
  canStart: boolean
  cancelLocked: boolean
  feedback: ReactNode
  refreshHint: number
  onMutate: (change: PersonalMutation) => void | Promise<void>
  onCancel: (groupId: string, turnId: string) => void | Promise<void>
  onSession: (sessionId: string, groupId: string) => void
  onDenied: (cause: unknown) => void
}

/** This page reads only shared group history. Member memories are never fetched. */
export function GroupPage(props: GroupPageProps) {
  const { groupId, groups, assistants, draft, onDraft, writable, locked } = props
  const [detail, setDetail] = useState<PersonalGroupDetail | null>(null)
  const [error, setError] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [limit, setLimit] = useState(100)
  const [acceptedTurn, setAcceptedTurn] = useState<string | null>(null)
  const acceptance = useRef(0)
  const acceptedRef = useRef<string | null>(null)
  const request = useRef<AbortController | null>(null)
  const generation = useRef(0)
  const latest = useRef(detail)
  latest.current = detail
  const denied = useRef(props.onDenied)
  denied.current = props.onDenied
  const live = useRef(false)
  const selected = useRef(groupId)
  selected.current = groupId
  const load = useCallback(async () => {
    if (!groupId || selected.current !== groupId || !live.current || request.current) return
    const controller = new AbortController(),
      ticket = ++generation.current
    const version = acceptance.current
    request.current = controller
    try {
      const value = await api<PersonalGroupDetail>(groupPath(groupId), { signal: controller.signal })
      if (live.current && selected.current === groupId && ticket === generation.current) {
        setDetail(value)
        setError('')
        if (version === acceptance.current) {
          acceptedRef.current = null
          setAcceptedTurn(null)
        }
      }
    } catch (cause) {
      if (!live.current || selected.current !== groupId || ticket !== generation.current || controller.signal.aborted) return
      if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) {
        setDetail(null)
        denied.current(cause)
      }
      setError(inlineError(cause))
    } finally {
      if (request.current === controller) request.current = null
    }
  }, [groupId])
  useEffect(() => {
    live.current = true
    setDetail(null)
    setError('')
    setLimit(100)
    acceptance.current++
    acceptedRef.current = null
    setAcceptedTurn(null)
    void load()
    const timer = setInterval(() => {
      if (!document.hidden && (activeGroupTurn(latest.current?.turn) || acceptedRef.current !== null)) void load()
    }, 2000)
    const visible = () => {
      if (!document.hidden) void load()
    }
    document.addEventListener('visibilitychange', visible)
    return () => {
      live.current = false
      generation.current++
      request.current?.abort()
      request.current = null
      clearInterval(timer)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [load])
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!document.hidden) void load()
    }, 320)
    return () => clearTimeout(timer)
  }, [load, props.refreshHint])
  const group = detail?.group.id === groupId ? detail.group : groups.find(item => item.id === groupId)
  const current = detail?.group.id === groupId ? detail : null
  const active = activeGroupTurn(current?.turn) || acceptedTurn !== null
  const unavailableResponder =
    group
    && (draft.assistantIds.length ? draft.assistantIds : [group.defaultAssistantId]).some(
      id => !assistants.some(item => item.id === id && item.available && item.harnessId === 'standard'),
    )
  const stopTurnId = acceptedTurn ?? (activeGroupTurn(current?.turn) ? current!.turn!.id : undefined)
  const name = (id: string) => assistants.find(item => item.id === id)?.name ?? '已移除的成员'
  const edit = (value?: PersonalGroup) =>
    onDraft(previous => ({ ...previous, editor: { config: groupConfig(value), ...(value ? { baseRevision: value.revision } : {}) } }))
  const send = () => {
    if (!group || locked || !writable || active || unavailableResponder || !props.canStart) return
    const body = groupInput(group, draft, newRequestId())
    if (!body) return
    void props.onMutate({
      path: groupPath(group.id) + '/messages',
      options: { method: 'POST', body },
      after: value => {
        if (live.current && selected.current === group.id && value.accepted === true && typeof value.turnId === 'string') {
          acceptance.current++
          acceptedRef.current = value.turnId
          setAcceptedTurn(value.turnId)
        }
        onDraft(previous => (previous.prompt === body.prompt ? { ...previous, prompt: '' } : previous))
        void load()
      },
    })
  }
  return (
    <>
      <SectionHeading
        title={groupId ? (group?.name ?? '助手群聊') : '助手群聊'}
        description={groupId ? '共享本群发言与明确的回复顺序，成员的私有记忆不会带进群聊。' : '让几位助手按你选择的顺序一起处理一件事。'}
        action={
          writable && (
            <Button
              icon={groupId ? Pencil : Plus}
              disabled={locked || (groupId !== null && (!current || active))}
              onClick={() => edit(group)}>
              {' '}
              {groupId ? '编辑群聊' : '创建群聊'}{' '}
            </Button>
          )
        }
      />
      {!draft.editor && props.feedback}
      {error && (
        <InlineNotice
          tone="error"
          action={
            <Button size="xs" onClick={() => void load()}>
              重新同步
            </Button>
          }>
          {error}
        </InlineNotice>
      )}
      {!groupId ? (
        groups.length ? (
          <SettingsGroup>
            {groups.map(item => (
              <NavRow
                key={item.id}
                title={item.name}
                leading={<Icon icon={UsersRound} size={16} />}
                value={`${item.memberIds.length} 位成员 · 默认 ${name(item.defaultAssistantId)}`}
                onClick={() => props.onSelect(item.id)}
              />
            ))}
          </SettingsGroup>
        ) : (
          <EmptyState title="还没有群聊" description="选择成员和默认回复者，再写下第一句话。" />
        )
      ) : !current ? (
        !error && <Loading label="正在读取共享记录…" />
      ) : (
        <>
          {(current.turn || acceptedTurn) && (
            <div className="personal-actions">
              {acceptedTurn ? (
                <StatusPill>已接纳，正在同步</StatusPill>
              ) : (
                current.turn && (
                  <StatusPill
                    tone={current.turn.state === 'failed' ? 'err' : current.turn.state === 'waiting-approval' ? 'warn' : 'neutral'}>
                    {groupOutcome[current.turn.state]}
                  </StatusPill>
                )
              )}
              {current.turn?.currentAssistantId && active && (
                <span>
                  当前：
                  <VisibleText text={name(current.turn.currentAssistantId)} />
                </span>
              )}
              {stopTurnId && (
                <Button icon={Square} disabled={props.cancelLocked} onClick={() => void props.onCancel(current.group.id, stopTurnId)}>
                  停止本轮
                </Button>
              )}
            </div>
          )}
          {current.turn?.reason && <InlineNotice tone="warn">{groupReason[current.turn.reason]}</InlineNotice>}
          {current.sessions.length > 0 && (
            <SettingsGroup caption="在成员会话中查看流式内容、审批、问题和文件。" captionIcon={null}>
              {current.sessions.map(session => (
                <NavRow
                  key={session.id}
                  title={session.title}
                  leading={<Icon icon={ArrowRight} size={16} />}
                  value={
                    session.status === 'waiting-approval'
                      ? '等待审批'
                      : session.status === 'running'
                        ? '正在执行'
                        : session.runOutcome === 'failed'
                          ? '执行失败'
                          : session.runOutcome === 'completed'
                            ? '已完成'
                            : '打开会话'
                  }
                  onClick={() => props.onSession(session.id, current.group.id)}
                />
              ))}
            </SettingsGroup>
          )}
          <section aria-label="群聊共享记录" className="personal-shared-history">
            {current.messages.length > limit && (
              <Button size="xs" onClick={() => setLimit(value => value + 100)}>
                显示更早的发言
              </Button>
            )}
            {current.messages.length === 0 && <p className="personal-empty">还没有发言，写下这次想一起完成的事。</p>}
            {current.messages.slice(-limit).map(message => (
              <article className="personal-shared-message" key={message.id}>
                <header>
                  <strong>
                    <VisibleText
                      text={message.role === 'user' ? '你' : message.role === 'assistant' ? name(message.assistantId ?? '') : '群聊状态'}
                    />
                  </strong>
                  <time dateTime={message.createdAt} title={dateTime(message.createdAt)}>
                    {relativeTime(message.createdAt)}
                  </time>
                  {message.sessionId && (
                    <Button size="xs" variant="ghost" onClick={() => props.onSession(message.sessionId!, current.group.id)}>
                      完整会话
                    </Button>
                  )}
                </header>
                <div className="personal-shared-text">
                  <VisibleText text={message.text} />
                </div>
              </article>
            ))}
          </section>
          {writable && (
            <section className="personal-group-compose" aria-label="在群聊中发言">
              <p className="setup-panel-caption">
                默认由 <VisibleText text={name(current.group.defaultAssistantId)} /> 回复；也可以按勾选顺序指定本轮回应者，最多{' '}
                {Math.min(4, current.group.maxRelays + 1)} 位。
              </p>
              <div className="personal-response-order">
                {current.group.memberIds.map(id => (
                  <Checkbox
                    key={id}
                    label={`${name(id)}${draft.assistantIds.includes(id) ? ` · 第 ${draft.assistantIds.indexOf(id) + 1} 位` : ''}`}
                    checked={draft.assistantIds.includes(id)}
                    disabled={
                      locked
                      || active
                      || (!draft.assistantIds.includes(id) && draft.assistantIds.length >= Math.min(4, current.group.maxRelays + 1))
                    }
                    onChange={event =>
                      onDraft(previous => ({
                        ...previous,
                        assistantIds: event.target.checked
                          ? [...previous.assistantIds, id]
                          : previous.assistantIds.filter(item => item !== id),
                      }))
                    }
                  />
                ))}
              </div>
              {draft.assistantIds.length > 0 && (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={locked || active}
                  onClick={() => onDraft(previous => ({ ...previous, assistantIds: [] }))}>
                  恢复默认回复者
                </Button>
              )}
              <TextAreaField
                label="群聊消息"
                value={draft.prompt}
                maxLength={16000}
                rows={3}
                disabled={locked || active}
                onChange={event => {
                  const prompt = event.target.value
                  onDraft(previous => ({ ...previous, prompt }))
                }}
              />
              <p className="setup-panel-caption">本群暂不接收附件、文件引用或排队输入；正在执行时可以打开成员会话查看。</p>
              {unavailableResponder && <InlineNotice tone="warn">选中的回复成员暂不可用，请重新选择或检查助手配置。</InlineNotice>}
              <Button
                variant="primary"
                disabled={locked || active || unavailableResponder || !props.canStart || !groupInput(current.group, draft, 'check')}
                tooltip={!props.canStart ? '先确认上一条提交的结果，再开始新的执行。' : active ? '请等本轮结束或先停止。' : undefined}
                onClick={send}>
                发送到群聊
              </Button>
            </section>
          )}
          {writable && (
            <Button variant="ghost" disabled={locked || active} onClick={() => setDeleting(true)}>
              删除群聊
            </Button>
          )}
        </>
      )}
      {draft.editor && writable && (
        <GroupEditor
          value={draft.editor.config}
          assistants={assistants}
          locked={locked}
          feedback={props.feedback}
          onChange={config => onDraft(previous => ({ ...previous, editor: { ...previous.editor!, config } }))}
          onClose={() => onDraft(previous => ({ ...previous, editor: undefined }))}
          onSave={() => {
            const editor = draft.editor!
            void props.onMutate({
              path: groupId ? groupPath(groupId) : 'personal/groups',
              options: {
                method: groupId ? 'PATCH' : 'POST',
                body: {
                  ...editor.config,
                  ...(editor.baseRevision ? { baseRevision: editor.baseRevision } : {}),
                  requestId: newRequestId(),
                },
              },
              after: value => {
                onDraft(previous => ({ ...previous, editor: undefined }))
                if (typeof value.id === 'string') props.onSelect(value.id)
                void load()
              },
            })
          }}
        />
      )}
      {deleting && current && (
        <ConfirmDialog
          title="删除群聊"
          confirmLabel="删除群聊"
          danger
          message="共享发言记录会删除，实际成员会话仍独立保存。"
          onClose={() => setDeleting(false)}
          onConfirm={async () => {
            await props.onMutate({
              path: groupPath(current.group.id),
              options: { method: 'DELETE', body: { requestId: newRequestId() } },
              after: () => {
                setDeleting(false)
                props.onSelect(null)
              },
            })
          }}
        />
      )}
    </>
  )
}

function GroupEditor({
  value,
  assistants,
  locked,
  feedback,
  onChange,
  onClose,
  onSave,
}: {
  value: PersonalGroupConfig
  assistants: readonly PersonalAssistantSummary[]
  locked: boolean
  feedback: ReactNode
  onChange: (value: PersonalGroupConfig) => void
  onClose: () => void
  onSave: () => void
}) {
  const problem =
    groupConfigProblem(value)
    ?? (value.memberIds.some(id => !assistants.some(item => item.id === id && item.available && item.harnessId === 'standard'))
      ? '请移除或修复当前不可用于群聊的成员。'
      : undefined)
  return (
    <Dialog
      open
      size="wide"
      title="群聊设置"
      onClose={onClose}
      footer={
        <Button variant="primary" disabled={locked || problem !== undefined} tooltip={problem} onClick={onSave}>
          保存群聊
        </Button>
      }>
      <div className="settings-form">
        <TextField
          label="群聊名称"
          value={value.name}
          maxLength={80}
          disabled={locked}
          onChange={event => onChange({ ...value, name: event.target.value })}
        />
        <fieldset className="personal-plugin-options">
          <legend>成员（1–8 位）</legend>
          {assistants.map(assistant => (
            <Checkbox
              key={assistant.id}
              label={assistant.name}
              checked={value.memberIds.includes(assistant.id)}
              description={
                !assistant.available || assistant.harnessId !== 'standard'
                  ? (assistant.unavailableReason ?? '当前执行方式暂不可用于群聊')
                  : undefined
              }
              disabled={
                locked
                || (!value.memberIds.includes(assistant.id)
                  && (!assistant.available || assistant.harnessId !== 'standard' || value.memberIds.length >= 8))
              }
              onChange={event => {
                const memberIds = event.target.checked
                  ? [...value.memberIds, assistant.id]
                  : value.memberIds.filter(id => id !== assistant.id)
                onChange({
                  ...value,
                  memberIds,
                  defaultAssistantId:
                    value.defaultAssistantId && memberIds.includes(value.defaultAssistantId)
                      ? value.defaultAssistantId
                      : event.target.checked && memberIds.length === 1
                        ? assistant.id
                        : '',
                })
              }}
            />
          ))}
          {value.memberIds
            .filter(id => !assistants.some(item => item.id === id))
            .map(id => (
              <Checkbox
                key={id}
                label="已移除的成员"
                checked
                disabled={locked}
                onChange={() =>
                  onChange({
                    ...value,
                    memberIds: value.memberIds.filter(item => item !== id),
                    defaultAssistantId: value.defaultAssistantId === id ? '' : value.defaultAssistantId,
                  })
                }
              />
            ))}
        </fieldset>
        <ValuePicker
          label="默认回复者"
          value={value.defaultAssistantId}
          disabled={locked}
          placeholder="选择成员"
          options={value.memberIds.map(id => ({ value: id, label: assistants.find(item => item.id === id)?.name ?? '已移除的成员' }))}
          onValueChange={defaultAssistantId => onChange({ ...value, defaultAssistantId })}
        />
        <ValuePicker
          label="每轮回复上限"
          value={String(value.maxRelays)}
          disabled={locked}
          options={[0, 1, 2, 3].map(count => ({ value: String(count), label: `最多 ${count + 1} 位回复` }))}
          onValueChange={maxRelays => onChange({ ...value, maxRelays: Number(maxRelays) })}
        />
        <TextAreaField
          label="共同指令"
          value={value.instructions}
          maxLength={8000}
          rows={4}
          disabled={locked}
          onChange={event => onChange({ ...value, instructions: event.target.value })}
        />
        <p className="setup-panel-caption">只共享本群的指令和发言。不会读取成员的私有记忆，也不会让模型自行增加接力成员。</p>
        {feedback}
      </div>
    </Dialog>
  )
}
