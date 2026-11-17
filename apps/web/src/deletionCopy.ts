import type { HarnessInfo, TaskSummary } from '@latch/protocol'

/**
 * What a deletion really removes, said the same way everywhere (docs/ARCHITECTURE.md「数据、保留与导出」). Latch deletes
 * only its own copy. For an ACP Harness it asks the program to delete the session it started there, and only where
 * the program offers that (`session/delete`); a session brought in from a Harness's history never loses its original.
 * What went to a model service, or into an external Harness's context, cannot be called back.
 */
const NOT_RECALLED = '已发给模型服务的内容无法撤回。'
const IRREVERSIBLE = '此操作无法撤销。'
const KEPT = '审计与用量记录保留。'

type SessionTarget = Pick<TaskSummary, 'harnessId' | 'imported'>

type HarnessView = Pick<HarnessInfo, 'id' | 'capabilities'>

/**
 * A Harness that runs on the Host's own model services keeps the session only in Latch; one with its own models and
 * login is a program with its own record. Unknown (no longer listed) reads as having one, which says more, not less.
 */
const external = (session: SessionTarget, harnesses: readonly HarnessView[]): boolean =>
  harnesses.find(harness => harness.id === session.harnessId)?.capabilities.models.owner !== 'latch'

function harnessLabel(harnessId: string, harnesses: readonly HarnessView[]): string {
  return harnesses.find(harness => harness.id === harnessId)?.capabilities.display.label ?? harnessId
}

/** What happens to the program's own copy of these sessions; empty when every one is the built-in harness's. */
function externalCopies(sessions: readonly SessionTarget[], harnesses: readonly HarnessView[]): string[] {
  const outside = sessions.filter(session => external(session, harnesses))
  if (outside.length === 0) return []
  const names = [...new Set(outside.map(session => harnessLabel(session.harnessId, harnesses)))]
  const name = names.length === 1 ? names[0]! : 'Harness'
  const lines: string[] = []
  if (outside.some(session => !session.imported))
    lines.push(`Latch 能启动 ${name} 且它支持删除会话时，也请它删除自己保存的副本；否则它自己的副本可能留下。`)
  if (outside.some(session => session.imported)) lines.push(`从 ${name} 接入的原会话不会删除。`)
  return lines
}

/** The confirmation of deleting one session or several: what goes, what the Harness keeps, what nothing can recall. */
export function sessionDeletionMessage(sessions: readonly SessionTarget[], harnesses: readonly HarnessView[], title?: string): string {
  const what = title === undefined ? '这些会话' : `「${title}」`
  return [
    `删除${what}在 Latch 里的对话、附件与改动快照。`,
    ...externalCopies(sessions, harnesses),
    `项目文件夹里的文件不受影响。${KEPT}${NOT_RECALLED}${IRREVERSIBLE}`,
  ].join('\n')
}

/** Removing a project only takes it off the list. */
export const PROJECT_REMOVAL = '只从项目列表移除。文件夹里的文件、项目的会话与改动快照都保留；已有会话仍可查看，但不能继续。'

/** Removing one folder from a project. */
export const FOLDER_REMOVAL = '文件夹里的文件不会删除。在这个项目中使用这个文件夹的已有会话仍可查看，但不能继续。'

/** Deleting one of 我的 Agent: its memory goes; its conversations, folder and what it already sent stay. */
export function agentDeletionMessage(homePath?: string): string {
  return [
    '它的记忆会删除，聊天记录和文件夹会保留。',
    `待保存的提议和可撤销的修改一并删除；它在内置 Harness 上的会话不再接受输入。${homePath ? `文件夹：${homePath}` : ''}`,
    `外部 Harness 已收到的上下文留在原会话里，直到清空上下文。${NOT_RECALLED}${IRREVERSIBLE}`,
  ].join('\n')
}
