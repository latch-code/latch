import type {
  PersonalGroup,
  PersonalGroupConfig,
  PersonalGroupInput,
  PersonalGroupTurn,
  PersonalRoutine,
  PersonalRoutineConfig,
} from '@latch/protocol'
import type { ApiOptions } from '../core/api.ts'

export interface PersonalMutation {
  path: string
  options: ApiOptions
  after?: (value: Record<string, unknown>) => void
}
export interface GroupDraft {
  prompt: string
  assistantIds: string[]
  editor?: { config: PersonalGroupConfig; baseRevision?: number }
}
export interface RoutineDraft {
  editor?: { config: PersonalRoutineConfig; baseRevision?: number }
}
export const emptyGroupDraft = (): GroupDraft => ({ prompt: '', assistantIds: [] })
export const groupPath = (id: string) => `personal/groups/${encodeURIComponent(id)}`
export const routinePath = (id: string) => `personal/routines/${encodeURIComponent(id)}`
export const activeGroupTurn = (turn: PersonalGroupTurn | undefined) => turn?.state === 'running' || turn?.state === 'waiting-approval'

export function groupInput(group: PersonalGroup, draft: GroupDraft, requestId: string): PersonalGroupInput | undefined {
  if (!draft.prompt.trim() || draft.prompt.length > 16_000) return undefined
  const ids = draft.assistantIds
  if (ids.length > Math.min(4, group.maxRelays + 1) || new Set(ids).size !== ids.length || ids.some(id => !group.memberIds.includes(id)))
    return undefined
  return { requestId, prompt: draft.prompt, ...(ids.length ? { assistantIds: [...ids] } : {}) }
}

export function groupConfigProblem(config: PersonalGroupConfig): string | undefined {
  if (!config.name.trim() || config.name.length > 80 || /[\p{Cc}\p{Cf}]/u.test(config.name)) return '给群聊一个清晰的名字（最多 80 字）。'
  if (config.memberIds.length < 1 || config.memberIds.length > 8 || new Set(config.memberIds).size !== config.memberIds.length)
    return '请选择 1–8 位成员。'
  if (!config.memberIds.includes(config.defaultAssistantId)) return '请从成员中选择默认回复者。'
  if (config.instructions.length > 8000) return '共同指令最多 8000 字。'
  if (!Number.isInteger(config.maxRelays) || config.maxRelays < 0 || config.maxRelays > 3) return '每轮最多由 1–4 位成员回复。'
}

export function groupConfig(group?: PersonalGroup): PersonalGroupConfig {
  return group
    ? {
        name: group.name,
        memberIds: [...group.memberIds],
        defaultAssistantId: group.defaultAssistantId,
        instructions: group.instructions,
        maxRelays: group.maxRelays,
      }
    : { name: '', memberIds: [], defaultAssistantId: '', instructions: '', maxRelays: 0 }
}

export function routineConfig(routine?: PersonalRoutine): PersonalRoutineConfig {
  return routine
    ? { assistantId: routine.assistantId, name: routine.name, prompt: routine.prompt, schedule: { ...routine.schedule } }
    : {
        assistantId: '',
        name: '',
        prompt: '',
        schedule: { kind: 'daily', time: '09:00', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' },
      }
}

export function routineConfigProblem(config: PersonalRoutineConfig): string | undefined {
  if (!config.name.trim() || config.name.length > 80 || /[\p{Cc}\p{Cf}]/u.test(config.name)) return '给任务一个清晰的名字（最多 80 字）。'
  if (!config.assistantId) return '请选择可执行例行任务的助手。'
  if (!config.prompt.trim() || config.prompt.length > 16_000) return '请填写任务内容（最多 16000 字）。'
  if (!/^([01]\d|2[0-3]):[0-5]\d$/u.test(config.schedule.time)) return '请选择有效的每日时间。'
  if (!config.schedule.timeZone || config.schedule.timeZone.length > 80) return '请填写有效的 IANA 时区。'
  try {
    new Intl.DateTimeFormat('en', { timeZone: config.schedule.timeZone }).format(0)
  } catch {
    return '这个时区无法识别，请使用 IANA 名称，例如 Asia/Shanghai。'
  }
}

export const groupOutcome: Record<PersonalGroupTurn['state'], string> = {
  running: '正在接力',
  'waiting-approval': '等待审批',
  completed: '本轮已完成',
  failed: '本轮失败',
  cancelled: '本轮已停止',
  interrupted: '本轮已中断',
}
export const groupReason: Record<NonNullable<PersonalGroupTurn['reason']>, string> = {
  'definition-changed': '成员或执行配置已变化，后续接力已停止。',
  'owner-unavailable': '发起设备暂时不能继续，请检查访问权限或重新解锁。后续接力已停止。',
  'unknown-outcome': '执行结果无法确认，后续接力没有继续。',
  'host-restarted': 'Host 已重启，这一轮没有自动重放。',
  'storage-unavailable': '执行状态尚未确认，后续接力没有继续。',
}
export const routineState: Record<PersonalRoutine['state'], string> = {
  disabled: '未开启',
  ready: '已开启',
  running: '正在执行',
  paused: '已暂停',
}
export const routineReason: Record<NonNullable<PersonalRoutine['pauseReason']>, string> = {
  'definition-changed': '职责、记忆或执行配置已变化，请在电脑上检查后重新开启。',
  'owner-unavailable': '开启设备暂不可用，请回电脑检查权限。',
  'harness-unavailable': '执行方式暂不可用。',
  'plugin-unavailable': '所选插件暂不可用。',
  missed: '错过了执行时间，没有自动补跑。',
  'unknown-outcome': '上次执行结果未知，没有自动重发。',
  'audit-unavailable': 'Host 无法保存审计，未启动新的执行。',
}
