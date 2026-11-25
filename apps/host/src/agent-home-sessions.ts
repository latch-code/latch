import { dirname, isAbsolute, join } from 'node:path'
import { createSnapshotStore, type StoredTask } from '@latch/core'
import { GENERAL_AGENT_ID } from '@latch/protocol'
import { homeBelongsTo } from './session-folders.ts'
import { SessionMetaStore } from './session-meta.ts'

interface GeneralHomeSessions {
  paths(legacyName: string): string[]
  move(legacyName: string, from: string, to: string): Promise<void>
}

/**
 * Migrate Standard's working directories before its Driver opens the snapshot. The caller proves which old directory
 * and destination belong to this Host. Keep the logical folder marker in Host metadata, as well as history and receipts.
 */
export async function withGeneralHomeSessions<T>(dataDir: string, migrate: (sessions: GeneralHomeSessions) => Promise<T>): Promise<T> {
  const meta = await SessionMetaStore.open(dataDir)
  const store = createSnapshotStore(join(dataDir, 'sessions'))
  try {
    let state = await store.load()
    const homeOf = ({ summary }: StoredTask, legacyName: string): string | undefined => {
      const saved = meta.get(summary.id)
      const cwd = summary.cwd
      const workspace = saved?.workspaceId ?? summary.workspaceId
      if (
        cwd === undefined
        || !isAbsolute(cwd)
        || !homeBelongsTo(legacyName, GENERAL_AGENT_ID)
        || join(dirname(dirname(cwd)), legacyName) !== cwd
        || (workspace !== undefined && workspace !== 'default')
        || summary.personal
        || saved?.personal
        || summary.agent
        || saved?.agent
        || saved?.imported
        || saved?.worktree
        || (saved?.sessionFolder !== undefined && saved.sessionFolder !== legacyName)
      )
        return undefined
      // A General automation does not carry the conversation flag, but the Host recorded its own home allocation.
      if (summary.generalChat || saved?.generalChat || (saved?.automationId && saved.sessionFolder === legacyName)) return cwd
      return undefined
    }

    return await migrate({
      paths(legacyName) {
        return [...new Set(Object.values(state.tasks).flatMap(task => homeOf(task, legacyName) ?? []))]
      },
      async move(legacyName, from, to) {
        if (from === to) return
        const tasks = { ...state.tasks }
        let changed = false
        for (const [id, task] of Object.entries(state.tasks)) {
          if (homeOf(task, legacyName) !== from) continue
          const { summary } = task
          tasks[id] = {
            ...task,
            summary: {
              ...summary,
              cwd: to,
              ...(summary.folders
                ? { folders: summary.folders.map(folder => (folder.path === from ? { ...folder, path: to } : folder)) }
                : {}),
            },
          }
          changed = true
        }
        if (changed) {
          const next = { ...state, tasks }
          await store.commit(next)
          state = next
        }
      },
    })
  } finally {
    await store.close()
  }
}
