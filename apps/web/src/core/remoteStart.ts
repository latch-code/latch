import { api, auditFailed, ClientError } from './api.ts'
import { withConfirmation } from './confirmations.ts'

/**
 * Whether phones and other devices may start new sessions, the one policy value with a row of its own. Turning it off
 * works from any admin device; turning it on comes back as `stepup-required`, and the local confirmation resends the
 * identical body. The Host decides both again.
 */

function allowedOf(body: unknown): boolean {
  const policy = (body as { policy?: { remote?: { allowRemoteStart?: unknown } } } | null)?.policy
  const allowed = policy?.remote?.allowRemoteStart
  if (typeof allowed !== 'boolean') throw new ClientError('读不懂这台 Mac 返回的设置，请刷新后重试。', 'policy-unreadable')
  return allowed
}

export async function readRemoteStart(): Promise<boolean> {
  return allowedOf(await api<unknown>('policy'))
}

export async function changeRemoteStart(allowRemoteStart: boolean): Promise<{ allowed: boolean; auditFailed: boolean }> {
  let failed = false
  const body = await withConfirmation(confirmation =>
    api<unknown>('policy', {
      method: 'PATCH',
      body: { remote: { allowRemoteStart } },
      ...(confirmation ? { confirmation } : {}),
      onHeaders: headers => {
        failed = auditFailed(headers)
      },
    }),
  )
  return { allowed: allowedOf(body), auditFailed: failed }
}
