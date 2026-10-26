import { useState, type ReactNode } from 'react'
import { CalendarClock, Pencil, Plus } from 'lucide-react'
import type { PersonalAssistantSummary, PersonalRoutine, PersonalRoutineConfig } from '@latch/protocol'
import { Button, ConfirmDialog, Dialog, EmptyState, Icon, InlineNotice, StatusPill, TextAreaField, TextField, ValuePicker } from '@latch/ui'
import { newRequestId } from '../core/api.ts'
import { LOCAL_ONLY_TEXT } from '../core/securityCopy.ts'
import { dateTime } from '../format.ts'
import { VisibleText } from '../components/VisibleText.tsx'
import { NavRow, SectionHeading, SettingsGroup, SettingsRow } from '../settings/common.tsx'
import {
  routineConfig,
  routineConfigProblem,
  routinePath,
  routineReason,
  routineState,
  type PersonalMutation,
  type RoutineDraft,
} from './model.ts'

export interface RoutinePageProps {
  routines: readonly PersonalRoutine[]
  assistants: readonly PersonalAssistantSummary[]
  routineId: string | null
  draft: RoutineDraft
  onDraft: (update: (previous: RoutineDraft) => RoutineDraft) => void
  onSelect: (id: string | null) => void
  local: boolean
  writable: boolean
  locked: boolean
  feedback: ReactNode
  onMutate: (change: PersonalMutation) => void | Promise<void>
  onSession: (id: string) => void
}

/** Daily tasks are created disabled. Only a real local device can grant future execution; allowed devices may pause. */
export function RoutinePage(props: RoutinePageProps) {
  const { routines, assistants, routineId, draft, onDraft, writable, locked } = props
  const [deleting, setDeleting] = useState(false)
  const routine = routines.find(item => item.id === routineId)
  const available = routine && assistants.some(item => item.id === routine.assistantId && item.canSchedule)
  const name = (id: string) => assistants.find(item => item.id === id)?.name ?? '已移除的助手'
  const edit = (value?: PersonalRoutine) =>
    onDraft(previous => ({ ...previous, editor: { config: routineConfig(value), ...(value ? { baseRevision: value.revision } : {}) } }))
  const enable = (enabled: boolean) => {
    if (!routine || locked || !writable || (enabled && (!props.local || !available))) return
    void props.onMutate({
      path: routinePath(routine.id) + '/enabled',
      options: { method: 'POST', body: { requestId: newRequestId(), baseRevision: routine.revision, enabled } },
    })
  }
  return (
    <>
      <SectionHeading
        title={routine?.name ?? '例行任务'}
        description="把明确的日常事项交给一位助手，按保存的每日时间处理。"
        action={
          writable && (
            <Button
              icon={routineId ? Pencil : Plus}
              disabled={locked || (routineId !== null && (!routine || routine.state === 'running'))}
              onClick={() => edit(routine)}>
              {routineId ? '编辑任务' : '创建例行任务'}
            </Button>
          )
        }
      />
      {!draft.editor && props.feedback}
      {!routineId ? (
        routines.length ? (
          <SettingsGroup>
            {routines.map(item => (
              <NavRow
                key={item.id}
                leading={<Icon icon={CalendarClock} size={16} />}
                title={item.name}
                description={`${name(item.assistantId)} · 每日 ${item.schedule.time} · ${item.schedule.timeZone}`}
                value={<StatusPill tone={item.state === 'paused' ? 'warn' : 'neutral'}>{routineState[item.state]}</StatusPill>}
                onClick={() => props.onSelect(item.id)}
              />
            ))}
          </SettingsGroup>
        ) : (
          <EmptyState title="还没有例行任务" description="保存后默认关闭。检查任务、助手和时区后，再在电脑上明确开启。" />
        )
      ) : !routine ? (
        <EmptyState title="找不到这项任务" description="它可能已在其他设备删除，请返回列表重新选择。" />
      ) : (
        <>
          <SettingsGroup>
            <SettingsRow title="执行助手" trailing={<VisibleText text={name(routine.assistantId)} />} />
            <SettingsRow title="每日时间" description={routine.schedule.timeZone} trailing={routine.schedule.time} />
            <SettingsRow
              title="状态"
              trailing={<StatusPill tone={routine.state === 'paused' ? 'warn' : 'neutral'}>{routineState[routine.state]}</StatusPill>}
            />
            {routine.nextRunAt && <SettingsRow title="下次执行" trailing={dateTime(routine.nextRunAt)} />}
          </SettingsGroup>
          <section aria-label="保存的例行任务内容">
            <div className="personal-shared-text">
              <VisibleText text={routine.prompt} />
            </div>
          </section>
          {routine.pauseReason && <InlineNotice tone="warn">{routineReason[routine.pauseReason]}</InlineNotice>}
          {routine.lastRun && (
            <SettingsGroup caption="执行结果来自实际会话；未知或中断不会自动重发。" captionIcon={null}>
              <SettingsRow
                title="最近一次"
                description={dateTime(routine.lastRun.at)}
                trailing={
                  {
                    running: '正在执行',
                    completed: '已完成',
                    failed: '执行失败',
                    cancelled: '已取消',
                    interrupted: '已中断',
                    unknown: '结果未知',
                  }[routine.lastRun.state]
                }
              />
              {routine.lastRun.sessionId && <NavRow title="打开实际会话" onClick={() => props.onSession(routine.lastRun!.sessionId!)} />}
            </SettingsGroup>
          )}
          {writable && (
            <div className="personal-actions">
              {routine.enabled && (
                <Button disabled={locked} onClick={() => enable(false)}>
                  暂停以后执行
                </Button>
              )}
              {(!routine.enabled || routine.state === 'paused') && props.local && (
                <Button
                  variant="primary"
                  disabled={locked || routine.state === 'running' || !available}
                  tooltip={!available ? '请先检查这位助手的执行方式和模型配置。' : undefined}
                  onClick={() => enable(true)}>
                  {routine.state === 'paused' ? '重新开启' : '开启每日执行'}
                </Button>
              )}
              <Button variant="ghost" disabled={locked || routine.state === 'running'} onClick={() => setDeleting(true)}>
                删除任务
              </Button>
            </div>
          )}
          {!props.local && (!routine.enabled || routine.state === 'paused') && (
            <p className="setup-panel-caption">开启例行任务：{LOCAL_ONLY_TEXT}。</p>
          )}
          {routine.state === 'running' && (
            <p className="setup-panel-caption">暂停只影响以后启动。当前执行继续显示真实结果，可在实际会话中停止。</p>
          )}
        </>
      )}
      {draft.editor && writable && (
        <RoutineEditor
          value={draft.editor.config}
          assistants={assistants}
          locked={locked}
          feedback={props.feedback}
          onChange={config => onDraft(previous => ({ ...previous, editor: { ...previous.editor!, config } }))}
          onClose={() => onDraft(previous => ({ ...previous, editor: undefined }))}
          onSave={() => {
            const editor = draft.editor!
            void props.onMutate({
              path: routineId ? routinePath(routineId) : 'personal/routines',
              options: {
                method: routineId ? 'PATCH' : 'POST',
                body: {
                  ...editor.config,
                  ...(editor.baseRevision ? { baseRevision: editor.baseRevision } : {}),
                  requestId: newRequestId(),
                },
              },
              after: value => {
                onDraft(previous => ({ ...previous, editor: undefined }))
                if (typeof value.id === 'string') props.onSelect(value.id)
              },
            })
          }}
        />
      )}
      {deleting && routine && (
        <ConfirmDialog
          title="删除例行任务"
          message="删除后不再按这个计划启动，已有会话仍独立保存。"
          confirmLabel="删除任务"
          danger
          onClose={() => setDeleting(false)}
          onConfirm={async () => {
            await props.onMutate({
              path: routinePath(routine.id),
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

function RoutineEditor({
  value,
  assistants,
  locked,
  feedback,
  onChange,
  onClose,
  onSave,
}: {
  value: PersonalRoutineConfig
  assistants: readonly PersonalAssistantSummary[]
  locked: boolean
  feedback: ReactNode
  onChange: (value: PersonalRoutineConfig) => void
  onClose: () => void
  onSave: () => void
}) {
  const problem =
    routineConfigProblem(value)
    ?? (!assistants.some(item => item.id === value.assistantId && item.canSchedule) ? '请选择当前可执行例行任务的助手。' : undefined)
  return (
    <Dialog
      open
      size="wide"
      title="例行任务设置"
      onClose={onClose}
      footer={
        <Button variant="primary" disabled={locked || problem !== undefined} tooltip={problem} onClick={onSave}>
          保存任务
        </Button>
      }>
      <div className="settings-form">
        <TextField
          label="任务名称"
          value={value.name}
          maxLength={80}
          disabled={locked}
          onChange={event => onChange({ ...value, name: event.target.value })}
        />
        <ValuePicker
          label="执行助手"
          value={value.assistantId}
          placeholder="选择助手"
          disabled={locked}
          options={assistants.map(assistant => ({
            value: assistant.id,
            label: assistant.name,
            disabledReason: !assistant.canSchedule ? (assistant.unavailableReason ?? '当前执行方式暂不支持例行任务') : undefined,
          }))}
          onValueChange={assistantId => onChange({ ...value, assistantId })}
        />
        <TextAreaField
          label="任务内容"
          value={value.prompt}
          rows={5}
          maxLength={16000}
          disabled={locked}
          onChange={event => onChange({ ...value, prompt: event.target.value })}
        />
        <TextField
          type="time"
          label="每日时间"
          value={value.schedule.time}
          disabled={locked}
          onChange={event => onChange({ ...value, schedule: { ...value.schedule, time: event.target.value } })}
        />
        <TextField
          label="时区"
          value={value.schedule.timeZone}
          maxLength={80}
          placeholder="Asia/Shanghai"
          disabled={locked}
          onChange={event => onChange({ ...value, schedule: { ...value.schedule, timeZone: event.target.value } })}
        />
        <p className="setup-panel-caption">新建任务默认关闭；保存后在电脑上明确开启。按当地时间执行，夏令时不存在的时刻会跳过。</p>
        {feedback}
      </div>
    </Dialog>
  )
}
