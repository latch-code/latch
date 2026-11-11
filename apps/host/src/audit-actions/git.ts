import { z } from 'zod'
import type { ZodType } from 'zod'
import { KNOWN_HOOKS } from '../changes/git-status.ts'
import { count, hex64, opaqueId } from './fields.ts'

const oid = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u)
const hooks = z.array(z.enum(KNOWN_HOOKS)).max(KNOWN_HOOKS.length)
const request = { sessionId: opaqueId, requestHash: hex64 }
/** Why a write that ran did not succeed. */
export const RESULT_CODES = [
  'git-stage-failed',
  'git-hook-failed',
  'git-identity-missing',
  'git-commit-failed',
  'git-commit-not-made',
  'git-push-auth',
  'git-push-non-fast-forward',
  'git-push-remote-rejected',
  'git-push-unreachable',
  'git-push-host-key',
  'git-push-failed',
] as const

/**
 * 交付 (docs/GIT-DELIVERY.md). The write is recorded before Git runs and does not run when the record fails; its outcome
 * follows in `git.result`. Never a path, a message, a remote's name or URL, or anything Git printed: the remote is the
 * rule that chose it and the hash of its name.
 */
export const GIT_ACTIONS = {
  'git.stage': z.strictObject({ ...request, files: count, filtered: z.boolean() }),
  'git.unstage': z.strictObject({ ...request, files: count }),
  'git.commit': z.strictObject({ ...request, preHead: oid.optional(), hooks, skipHooks: z.boolean() }),
  'git.push': z.strictObject({
    ...request,
    localSha: oid,
    remote: z.enum(['upstream', 'push-remote', 'origin']),
    remoteHash: hex64,
    refHash: hex64,
    setUpstream: z.boolean(),
    hooks,
  }),
  'git.result': z.strictObject({
    ...request,
    operation: z.enum(['stage', 'unstage', 'commit', 'push']),
    outcome: z.enum(['done', 'failed', 'unknown']),
    code: z.enum(RESULT_CODES).optional(),
    commit: oid.optional(),
  }),
} as const satisfies Record<string, ZodType>
