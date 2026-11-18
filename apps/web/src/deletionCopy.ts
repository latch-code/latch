import type { HarnessInfo, TaskSummary } from '@latch/protocol'
import { defineCopy } from './core/i18n.ts'

/**
 * What a deletion really removes, said the same way everywhere (docs/ARCHITECTURE.md「数据、保留与导出」). Latch deletes
 * only its own copy. For an ACP Harness it asks the program to delete the session it started there, and only where
 * the program offers that (`session/delete`); a session brought in from a Harness's history never loses its original.
 * What went to a model service, or into an external Harness's context, cannot be called back.
 */
export const DELETION_COPY = defineCopy(
  {
    external: (name: string) => `Latch 能启动 ${name} 且它支持删除会话时，也请它删除自己保存的副本；否则它自己的副本可能留下。`,
    imported: (name: string) => `从 ${name} 接入的原会话不会删除。`,
    deletion: (title?: string) => `删除${title === undefined ? '这些会话' : `「${title}」`}在 Latch 里的对话、附件与改动快照。`,
    sessionKept: '项目文件夹里的文件不受影响。审计与用量记录保留。已发给模型服务的内容无法撤回。此操作无法撤销。',
    projectRemoval: '只从项目列表移除。文件夹里的文件、项目的会话与改动快照都保留；已有会话仍可查看，但不能继续。',
    folderRemoval: '文件夹里的文件不会删除。在这个项目中使用这个文件夹的已有会话仍可查看，但不能继续。',
    agent: '它的记忆会删除，聊天记录和文件夹会保留。',
    agentPending: (path?: string) =>
      `待保存的提议和可撤销的修改一并删除；它在内置 Harness 上的会话不再接受输入。${path ? `文件夹：${path}` : ''}`,
    agentExternal: '外部 Harness 已收到的上下文留在原会话里，直到清空上下文。已发给模型服务的内容无法撤回。此操作无法撤销。',
  },
  {
    external: (name: string) =>
      `If Latch can start ${name} and it supports session deletion, Latch also asks it to delete its copy. Otherwise its copy may remain.`,
    imported: (name: string) => `The original sessions imported from ${name} will be kept.`,
    deletion: (title?: string) =>
      `Delete the conversations, attachments, and change snapshots for ${title === undefined ? 'these sessions' : `“${title}”`} from Latch.`,
    sessionKept:
      'Files in the project folder are unaffected. Audit and usage records are kept. Content sent to model services cannot be recalled. This action cannot be undone.',
    projectRemoval:
      'Removes the project from the list. Files, sessions, and change snapshots are kept. Existing sessions become read-only.',
    folderRemoval: 'Files in this folder are kept. Existing sessions that used this folder in the project become read-only.',
    agent: 'The Agent’s memory is deleted. Its chat history and folders are kept.',
    agentPending: (path?: string) =>
      `Pending proposals and reversible changes are deleted. Sessions in the built-in Harness stop accepting input.${path ? ` Folder: ${path}` : ''}`,
    agentExternal:
      'Context already sent to an external Harness remains in the original session until its context is cleared. Content sent to model services cannot be recalled. This action cannot be undone.',
  },
)

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
  if (outside.some(session => !session.imported)) lines.push(DELETION_COPY.external(name))
  if (outside.some(session => session.imported)) lines.push(DELETION_COPY.imported(name))
  return lines
}

/** The confirmation of deleting one session or several: what goes, what the Harness keeps, what nothing can recall. */
export function sessionDeletionMessage(sessions: readonly SessionTarget[], harnesses: readonly HarnessView[], title?: string): string {
  return [DELETION_COPY.deletion(title), ...externalCopies(sessions, harnesses), DELETION_COPY.sessionKept].join('\n')
}

/** Deleting one of 我的 Agent: its memory goes; its conversations, folder and what it already sent stay. */
export function agentDeletionMessage(homePath?: string): string {
  return [DELETION_COPY.agent, DELETION_COPY.agentPending(homePath), DELETION_COPY.agentExternal].join('\n')
}
