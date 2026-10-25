import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PresencePreview } from '@latch/protocol'
const require = createRequire(import.meta.url)
interface Result {
  status: string
  code?: string
}
interface Options {
  type: string
  title: string
  message: string
  detail: string
  buttons: string[]
  defaultId: number
  cancelId: number
  signal?: AbortSignal
}
const { canonicalJson } = require('../src/credentials.cjs') as { canonicalJson(value: unknown): string }
const { createConfirmationActions } = require('../src/confirmations.cjs') as {
  createConfirmationActions(input: {
    request(method: string, path: string, body?: unknown): Promise<{ status: number; json?: unknown }>
    sign(id: string, hash: string): string
    identity(): { hostId: string; deviceId: string } | undefined
    focused(): boolean
    gate: { enter(): boolean; leave(): void }
    confirm(options: Options): Promise<{ response: number }>
    now(): number
  }): { confirm(id: string): Promise<Result> }
}
afterEach(() => {
  vi.useRealTimers()
})
const id = `cfm_${'D'.repeat(22)}`
function fixture() {
  const who = { hostId: 'a'.repeat(52), deviceId: `dev_${'C'.repeat(22)}` }
  const preview = {
    v: 2,
    hostId: who.hostId,
    action: 'approval.r2',
    title: '允许一次高风险操作',
    reason: '批准写入 notes.md（write_file）',
    requester: { ...who, listener: 'unix' },
    subject: { form: 'approval.write', slots: { path: 'notes.md', tool: 'write_file' } },
    lines: [
      { label: '文件', value: '/private/tmp/work/notes.md' },
      { label: '内容', value: 'Host 提供的真实内容' },
    ],
    warnings: ['此操作会写入文件。'],
    expiresAt: new Date(120_000).toISOString(),
    nonce: 'n'.repeat(22),
  }
  let response: unknown = preview
  let digest: string | undefined
  let current: typeof who | undefined = who
  let focus = true
  let allowed = true
  let clock = 0
  const hash = () => createHash('sha256').update(canonicalJson(response)).digest('hex')
  const request = vi.fn(async (method: string, _path: string, _body?: unknown): Promise<{ status: number; json?: unknown }> =>
    method === 'GET'
      ? { status: 200, json: { preview: response, previewHash: digest ?? hash() } }
      : { status: 200, json: { confirmation: { status: 'approved' } } },
  )
  const confirm = vi.fn(async (_options: Options) => ({ response: 1 }))
  const sign = vi.fn(() => 'signed-proof')
  const leave = vi.fn()
  const actions = createConfirmationActions({
    request,
    sign,
    confirm,
    identity: () => current,
    focused: () => focus,
    gate: { enter: () => allowed, leave },
    now: () => clock,
  })
  return {
    actions,
    request,
    confirm,
    sign,
    leave,
    preview,
    hash,
    change: (patch: Partial<PresencePreview>) => {
      response = { ...preview, ...patch }
    },
    wrongHash: () => {
      digest = '0'.repeat(64)
    },
    loseFocus: () => {
      focus = false
    },
    changeDevice: () => {
      current = undefined
    },
    busy: () => {
      allowed = false
    },
    expire: () => {
      clock = 120_000
    },
  }
}
describe('main-owned native confirmation sheets', () => {
  it('reads the Host itself, shows every real line and warning, defaults to cancel, then signs only the bound ID and digest', async () => {
    const t = fixture()
    expect(await t.actions.confirm(id)).toEqual({ status: 'confirmed' })
    expect(t.request.mock.calls[0]).toEqual(['GET', `/link/api/confirmations/${id}/shell`])
    expect(t.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: t.preview.reason,
        detail: '文件：/private/tmp/work/notes.md\n内容：Host 提供的真实内容\n此操作会写入文件。',
        buttons: ['取消', '允许'],
        defaultId: 0,
        cancelId: 0,
      }),
    )
    expect(t.sign).toHaveBeenCalledExactlyOnceWith(id, t.hash())
    expect(t.request.mock.calls.at(-1)).toEqual([
      'POST',
      `/link/api/confirmations/${id}/shell`,
      { previewHash: t.hash(), signature: 'signed-proof' },
    ])
    expect(t.leave).toHaveBeenCalledOnce()
  })
  it('cancels without ever producing a signature', async () => {
    const t = fixture()
    t.confirm.mockResolvedValue({ response: 0 })
    expect(await t.actions.confirm(id)).toEqual({ status: 'cancelled' })
    expect(t.sign).not.toHaveBeenCalled()
    expect(t.request.mock.calls.at(-1)).toEqual(['DELETE', `/link/api/confirmations/${id}`])
  })
  it.each(['loseFocus', 'busy', 'wrongHash', 'expire'] as const)('fails closed for %s', async change => {
    const t = fixture()
    t[change]()
    expect((await t.actions.confirm(id)).status).not.toBe('confirmed')
    expect(t.confirm).not.toHaveBeenCalled()
    expect(t.sign).not.toHaveBeenCalled()
  })
  it.each([
    { action: 'policy.change' },
    { hostId: 'other' },
    { requester: { deviceId: 'other', listener: 'unix' } },
    { requester: { deviceId: `dev_${'C'.repeat(22)}`, listener: 'loopback' } },
  ] as const)('rejects an ineligible Host preview %j', async patch => {
    const t = fixture()
    t.change(patch as Partial<PresencePreview>)
    expect(await t.actions.confirm(id)).toEqual({ status: 'failed', code: 'confirmation-mismatch' })
    expect(t.confirm).not.toHaveBeenCalled()
    expect(t.sign).not.toHaveBeenCalled()
  })
  it.each(['loseFocus', 'changeDevice', 'expire'] as const)('rechecks %s after the sheet closes', async change => {
    const t = fixture()
    t.confirm.mockImplementation(async () => {
      t[change]()
      return { response: 1 }
    })
    expect((await t.actions.confirm(id)).status).toBe('failed')
    expect(t.sign).not.toHaveBeenCalled()
  })
  it('closes the native sheet when its Host ticket has been cancelled, without signing', async () => {
    vi.useFakeTimers()
    const t = fixture()
    t.confirm.mockImplementation(
      options =>
        new Promise(resolve => {
          options.signal!.addEventListener('abort', () => resolve({ response: 0 }), { once: true })
        }),
    )
    t.request.mockImplementation(async (method, path) => ({
      status: 200,
      json:
        method === 'GET' && path.endsWith('/shell')
          ? { preview: t.preview, previewHash: t.hash() }
          : { confirmation: { id, status: 'cancelled' } },
    }))
    const pending = t.actions.confirm(id)
    await vi.advanceTimersByTimeAsync(500)
    expect(await pending).toEqual({ status: 'failed', code: 'confirmation-expired' })
    expect(t.sign).not.toHaveBeenCalled()
    expect(t.leave).toHaveBeenCalledOnce()
  })

  it('refuses malformed IDs and never returns proof or raw transport failures', async () => {
    const t = fixture()
    expect((await t.actions.confirm('../x')).status).toBe('failed')
    expect(t.request).not.toHaveBeenCalled()
    t.request.mockRejectedValue(new Error('sensitive transport detail'))
    expect(await t.actions.confirm(id)).toEqual({ status: 'failed', code: 'confirmation-failed' })
  })
})
