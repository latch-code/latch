import type { HarnessInfo, TaskDetail, WorkspaceInfo } from '@latch/protocol'

type RecoveryPhase = 'idle' | 'busy' | 'unknown'
type RecoveryRunGate = { allowed: true } | { allowed: false; reason: string }

export interface WorkspaceRecoveryInput {
  source: TaskDetail
  workspaces: readonly WorkspaceInfo[]
  workspaceId?: string
  forkSupported: boolean
  runGate: RecoveryRunGate
  local: boolean
  phase: RecoveryPhase
  harness?: Pick<HarnessInfo, 'name' | 'projectFolders'>
}

export interface WorkspaceRecoveryIntent {
  taskId: string
  upToMessageId: string
  workspaceId: string
}

const unsettled = new Set(['queued', 'running', 'awaiting-approval'])

/** Match the Host's settled-prefix rule without reading or changing the source directory. */
export function recoveryMessage(source: TaskDetail): string | undefined {
  let user = false
  let result: string | undefined
  for (const message of source.messages) {
    if (unsettled.has(message.state ?? '')) break
    if (message.role === 'user') user = true
    if (user && message.role === 'assistant' && message.text.trim()) result = message.id
  }
  return result
}

/** An explicit saved project avoids the Host-owned default folder's deliberate reuse on a normal fork. */
export function recoveryWorkspaces(input: Pick<WorkspaceRecoveryInput, 'workspaces' | 'local' | 'harness'>): WorkspaceInfo[] {
  const max = input.harness?.projectFolders?.access === 'all' ? input.harness.projectFolders.max : undefined
  return input.workspaces.filter(workspace => {
    const folders = workspace.folders?.length ? workspace.folders : [{ id: 'default', path: workspace.path, unavailable: undefined }]
    return (
      workspace.id !== 'default'
      && workspace.unavailable === undefined
      && folders.every(folder => folder.unavailable === undefined)
      && (input.local || workspace.remoteStart !== false)
      && (max === undefined || folders.length <= max)
    )
  })
}

/** Display-only guard; POST /tasks revalidates the project, device and any real launch confirmation. */
export function workspaceRecovery(input: WorkspaceRecoveryInput): {
  workspaces: WorkspaceInfo[]
  blockedReason?: string
  intent?: WorkspaceRecoveryIntent
} {
  const workspaces = recoveryWorkspaces(input)
  let blockedReason: string | undefined
  if (input.phase === 'unknown') blockedReason = '上次提交的结果还未知。请先确认原请求的结果，再选择继续方式。'
  else if (input.phase === 'busy') blockedReason = '正在处理原会话，请稍后再继续。'
  else if (
    input.source.summary.status === 'running'
    || input.source.summary.status === 'waiting-approval'
    || input.source.activity?.phase === 'cancelling'
  )
    blockedReason = '请等原会话这一轮结束后再继续。'
  else if (!input.forkSupported) blockedReason = '当前 Host 尚不支持从会话记录继续，请先更新执行端。'
  else if (!input.runGate.allowed) blockedReason = input.runGate.reason

  const upToMessageId = recoveryMessage(input.source)
  if (blockedReason === undefined && upToMessageId === undefined) blockedReason = '原会话还没有可继续的已结束回复。'
  if (blockedReason === undefined && !workspaces.length) blockedReason = '暂时没有可用项目，请先在执行端添加或修复项目。'
  if (blockedReason === undefined && !workspaces.some(workspace => workspace.id === input.workspaceId))
    blockedReason = '请选择一个当前可用的项目。'

  return {
    workspaces,
    ...(blockedReason !== undefined
      ? { blockedReason }
      : {
          intent: { taskId: input.source.summary.id, upToMessageId: upToMessageId!, workspaceId: input.workspaceId! },
        }),
  }
}
