import { z } from 'zod'
import { readsProjectFiles } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { BranchSwitcher, type BranchSwitcherOptions } from '../branch-switch.ts'
import { json, jsonBody, safeDecode } from '../http-util.ts'
import type { Caller, DeviceCaller, RouteContext, RouteModule } from './registry.ts'

const PATH = /^\/link\/api\/workspaces\/([^/]+)\/branches(\/switch)?$/u
const switchSchema = z.strictObject({
  requestId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u),
  // The Host checks it against its own listing; this only bounds what is read.
  branch: z.string().min(1).max(256),
})

/** What only server.ts knows: projects, their queue, and the sessions working in a folder. */
export interface BranchRouteDeps {
  /** A saved project's folder (its first): where its sessions and drafts work. Throws for an unknown project. */
  projectFolder: (workspaceId: string) => string
  /** Runs in the project's queue: after its starts and changes, before the next ones. */
  projectOperation: <T>(workspaceId: string, caller: Caller, operation: () => Promise<T>) => Promise<T>
  /** A worktree Latch made: its branch is its session's, never switched from here. */
  latchWorktree: (folder: string) => Promise<boolean>
  /** Refuses (409) while a session whose folder overlaps this one runs, waits for approval, is starting a turn or has one queued. */
  assertIdle: (folder: string) => Promise<void>
  /** Marks the folder as switching: new turns, starts and terminals there are refused until the returned call. */
  hold: (folder: string) => () => void
  /** HEAD of the folder may have moved: its branch is read again and its sessions' clients told. */
  moved: (folder: string) => void
  /** Tests: the Git binary and its home. */
  git?: Pick<BranchSwitcherOptions, 'git' | 'home' | 'timeoutMs'>
}

/**
 * 切换分支: `GET …/branches` lists a project folder's local branches for a device that may
 * read its files; `POST …/branches/switch` moves the folder to one of them, pressed by a person on a device with `run`
 * that may read the project's files. No tool, page or schedule reaches these routes.
 */
export function createBranchRoutes(context: RouteContext, deps: BranchRouteDeps): RouteModule {
  const { audited, actorOf, devices, limits, recheck } = context
  const requireScope: RouteContext['requireScope'] = context.requireScope
  const switcher = new BranchSwitcher({
    ...deps.git,
    holds: context.repositoryHolds,
    log: context.log,
    moved: folder => deps.moved(folder),
  })
  context.lifecycle.on('hostStopping', () => {
    switcher.close()
  })

  /** The device may still do this: its scope, and a data scope that includes the project's files. */
  function permitted(caller: DeviceCaller, scope: 'view' | 'run'): void {
    recheck(caller, scope)
    if (!readsProjectFiles(devices.get(caller.device.id)?.dataScope))
      throw new AppError(403, 'file-scope', '这台设备的数据范围不包括项目文件夹中的文件。')
  }

  return {
    features: () => ({ branchSwitch: true }),
    async route({ req, res, path, method, caller }) {
      const match = PATH.exec(path)
      if (!match) return false
      const workspaceId = safeDecode(match[1]!)
      if (method === 'GET' && !match[2]) {
        requireScope(caller, 'view')
        permitted(caller, 'view')
        limits.files.take(caller.device.id)
        const listing = await switcher.list(deps.projectFolder(workspaceId))
        // The scope may have been narrowed while the files were read: nothing read for the wider one leaves.
        permitted(caller, 'view')
        json(res, listing)
        return true
      }
      if (method !== 'POST' || !match[2]) throw new AppError(405, 'method-not-allowed', '不支持这个方法')
      requireScope(caller, 'run')
      permitted(caller, 'run')
      limits.classC.take(caller.device.id)
      const input = switchSchema.parse(await jsonBody(req))
      // Counted as a Git write from here, so an install waits for it; refused once the install window is committed.
      const leave = context.repositoryHolds.enter()
      try {
        const result = await deps.projectOperation(workspaceId, caller, async () => {
          permitted(caller, 'run')
          const folder = deps.projectFolder(workspaceId)
          return switcher.switch(
            {
              deviceId: caller.device.id,
              workspaceId,
              folder,
              async prepare() {
                if (await deps.latchWorktree(folder))
                  throw new AppError(409, 'branch-switch-worktree', '这是一个工作树：它的分支属于它的会话，不在这里切换。')
                await deps.assertIdle(folder)
              },
              async authorize() {
                permitted(caller, 'run')
                if (deps.projectFolder(workspaceId) !== folder)
                  throw new AppError(409, 'workspace-changed', '项目的文件夹已经变了，没有切换。')
                await deps.assertIdle(folder)
                permitted(caller, 'run')
              },
              hold: () => deps.hold(folder),
              async audit(detail) {
                await audited({ action: 'git.switch', actor: actorOf(caller), target: workspaceId, detail: { workspaceId, ...detail } })
              },
              async result(event) {
                await audited({
                  action: 'git.switch.result',
                  actor: actorOf(caller),
                  target: workspaceId,
                  detail: { workspaceId, ...event },
                })
              },
            },
            input,
          )
        })
        json(res, result)
      } finally {
        leave()
      }
      return true
    },
  }
}
