import { defineCopy } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    retry: '重试',
    harness: '打开设置 › Harness',
    model: '换个模型',
    providers: '打开设置 › 模型服务',
    continue: '在新会话中继续',
  },
  {
    retry: 'Retry',
    harness: 'Open Settings › Harness',
    model: 'Choose another model',
    providers: 'Open Settings › Model services',
    continue: 'Continue in new session',
  },
)
/**
 * The one next step a failure offers, chosen by the error code the Host recorded or answered with (`Message.errorCode`,
 * `ApiError.code`). The failure's own text is the reason; an unknown or absent code offers 重试.
 */
export type FailureAction = 'retry' | 'harness' | 'model' | 'providers' | 'continue' | 'none'
/** The steps that open something on this device rather than resend the turn. */
export type FailureStep = 'harness' | 'model' | 'providers'

/** The Harness's command, version or definition stopped it: the fix is in 设置 › Harness. */
const HARNESS = new Set([
  'agent-not-found',
  'agent-start-failed',
  'agent-paused',
  'agent-handshake-timeout',
  'agent-env-reserved',
  'agent-folders-unsupported',
  'agent-definition-changed',
  'harness-version-unsupported',
  'harness-folder-limit',
  'login-program-changed',
])
/** This model cannot answer this: another one can. */
const MODEL = new Set([
  'model-unavailable',
  'model-route-unavailable',
  'model-route-changed',
  'model-vision-unsupported',
  'attachments-unsupported',
  'effort-unavailable',
  'chat-tools-disabled',
  'http-404',
])
/** The model service refused the key, or Latch may not reach it: the fix is in 设置 › 模型服务. */
const PROVIDERS = new Set(['egress-denied', 'invalid-url', 'model-gateway-unavailable', 'http-401', 'http-403'])
/** This session cannot go on as it is; a new one from its record can. */
const CONTINUE = new Set(['harness-session-lost', 'permission-drift', 'project-config-changed', 'l3-confirmation-missing'])
/** Already offered elsewhere: the project recovery panel, or nothing can be sent here. */
const NONE = new Set(['workspace-changed', 'session-read-only'])

export function failureAction(code: string | undefined): FailureAction {
  if (code === undefined) return 'retry'
  if (HARNESS.has(code)) return 'harness'
  if (MODEL.has(code)) return 'model'
  if (PROVIDERS.has(code)) return 'providers'
  if (CONTINUE.has(code)) return 'continue'
  if (NONE.has(code)) return 'none'
  return 'retry'
}

export const FAILURE_ACTION_LABEL: Record<Exclude<FailureAction, 'none'>, string> = {
  get retry() {
    return COPY.retry
  },
  get harness() {
    return COPY.harness
  },
  get model() {
    return COPY.model
  },
  get providers() {
    return COPY.providers
  },
  get continue() {
    return COPY.continue
  },
}
