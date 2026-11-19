import { z } from 'zod'
import { CODEX_GATEWAY_PROVIDER, CODEX_MODES, type CodexMode } from './codex.ts'

/**
 * What this computer's Codex requires (`configRequirements/read`, managed policy: MDM, `requirements.toml` or the cloud):
 * the approval policies, sandboxes and reviewers a turn may name, the models whose turns its review model must decide,
 * and a model provider it forces. Codex refuses a turn that names anything else (`invalid thread settings override`)
 * rather than narrowing it, so a mode it refuses is offered greyed with why, never sent. Only these few fields are read.
 */
export interface CodexPolicy {
  approvalPolicies?: string[]
  sandboxes?: string[]
  reviewers?: string[]
  autoReviewModels?: string[]
  /** A provider the policy forces, or the providers it defines in full; a gateway session cannot run under either. */
  provider?: string
  providers?: string[]
}

const names = z.array(z.unknown()).max(64).nullish()
const requirements = z.object({
  requirements: z
    .object({
      allowedApprovalPolicies: names,
      allowedSandboxModes: names,
      allowedApprovalsReviewers: names,
      autoReview: z.object({ requiredOnModels: names }).nullish().catch(undefined),
      modelProvider: z.string().max(256).nullish().catch(undefined),
      modelProviders: z.record(z.string().max(256), z.unknown()).nullish().catch(undefined),
    })
    .nullish(),
})

/** Plain names only: a granular approval policy (an object) is a policy none of Latch's modes sends. */
const plain = (values: unknown[] | null | undefined) =>
  values == null ? undefined : values.filter((value): value is string => typeof value === 'string' && value.length <= 128)

/** The answer to `configRequirements/read`; undefined when there are none or the answer cannot be read. */
export function codexPolicy(answer: unknown): CodexPolicy | undefined {
  const parsed = requirements.safeParse(answer)
  const read = parsed.success ? parsed.data.requirements : undefined
  if (!read) return undefined
  const policy: CodexPolicy = {}
  const approvalPolicies = plain(read.allowedApprovalPolicies)
  const sandboxes = plain(read.allowedSandboxModes)
  const reviewers = plain(read.allowedApprovalsReviewers)
  const autoReviewModels = plain(read.autoReview?.requiredOnModels)
  if (approvalPolicies) policy.approvalPolicies = approvalPolicies
  if (sandboxes) policy.sandboxes = sandboxes
  // `guardian_subagent` is the older name of `auto_review`, which Codex still takes.
  if (reviewers) policy.reviewers = reviewers.map(reviewer => (reviewer === 'guardian_subagent' ? 'auto_review' : reviewer))
  if (autoReviewModels?.length) policy.autoReviewModels = autoReviewModels
  if (read.modelProvider) policy.provider = read.modelProvider
  const providers = read.modelProviders ? Object.keys(read.modelProviders).slice(0, 64) : []
  if (providers.length) policy.providers = providers
  return Object.keys(policy).length ? policy : undefined
}

const APPROVAL_WORDS: Readonly<Record<string, string>> = { untrusted: '每次询问', 'on-request': '按需询问', never: '从不询问' }
const SANDBOX_WORDS: Readonly<Record<string, string>> = {
  'read-only': '只读沙箱',
  'workspace-write': '项目可写沙箱',
  'danger-full-access': '不用沙箱',
}
const REVIEWER_WORDS: Readonly<Record<string, string>> = { user: '由你审批', auto_review: '由 Codex 的模型审阅' }

/**
 * Why Codex's policy refuses a mode on a model, in one short line; undefined when it allows it. A model the policy
 * requires review on takes only Codex's review model in a sandbox that cannot write everywhere (`step_settings.rs`).
 */
export function codexModeRefusal(policy: CodexPolicy | undefined, mode: CodexMode, model?: string): string | undefined {
  if (!policy) return undefined
  const { approvalPolicy, sandbox, reviewer } = CODEX_MODES[mode]
  const said = (what: string) => `这台电脑的 Codex 管理策略不允许${what}`
  if (policy.approvalPolicies && !policy.approvalPolicies.includes(approvalPolicy))
    return said(APPROVAL_WORDS[approvalPolicy] ?? approvalPolicy)
  if (policy.sandboxes && !policy.sandboxes.includes(sandbox)) return said(SANDBOX_WORDS[sandbox] ?? sandbox)
  if (policy.reviewers && !policy.reviewers.includes(reviewer)) return said(REVIEWER_WORDS[reviewer] ?? reviewer)
  if (model && policy.autoReviewModels?.includes(model) && reviewer !== 'auto_review')
    return `这台电脑的 Codex 管理策略要求 ${model} 由 Codex 的模型审阅`
  return undefined
}

/** Why a gateway session cannot run under this policy: it forces another provider, or defines the providers in full. */
export function codexProviderRefusal(policy: CodexPolicy | undefined): string | undefined {
  if (policy?.provider && policy.provider !== CODEX_GATEWAY_PROVIDER)
    return '这台电脑的 Codex 管理策略指定了它自己的模型服务，经 Latch 的模型服务开会话会被 Codex 拒绝，未打开会话。'
  if (policy?.providers && !policy.providers.includes(CODEX_GATEWAY_PROVIDER))
    return '这台电脑的 Codex 管理策略只允许它列出的模型服务，经 Latch 的模型服务开会话会被 Codex 拒绝，未打开会话。'
  return undefined
}

const origin = z.object({ name: z.object({ type: z.string().max(64) }).passthrough() }).passthrough()
const reading = z.object({ origins: z.record(z.string(), z.unknown()).nullish().catch(undefined) })

/**
 * Why Codex's effective configuration would not run a gateway session as Latch set it up, from where each setting came
 * (`config/read`'s `origins`, never a value; its effective provider lists every field, defaults included): a provider of
 * the person's own named as Latch's merges its other settings (headers, query parameters, credentials) into the requests
 * to Latch's gateway, since Codex merges `-c` field by field; and a layer above Latch's `-c` (a legacy
 * `managed_config.toml`, MDM) that picks the provider replaces Latch's. Undefined when neither is the case, or the answer
 * says nothing either way. Checked on Codex 0.170: a `[model_providers.latch]` header in `config.toml` reports its key as
 * `user`, Latch's own as `sessionFlags`.
 */
export function codexGatewayClash(answer: unknown): string | undefined {
  const parsed = reading.safeParse(answer)
  if (!parsed.success) return undefined
  const origins = parsed.data.origins ?? {}
  const from = (key: string) => {
    const read = origin.safeParse(origins[key])
    return read.success ? read.data.name.type : undefined
  }
  const foreign = Object.keys(origins).some(
    key => key.startsWith(`model_providers.${CODEX_GATEWAY_PROVIDER}.`) && from(key) !== undefined && from(key) !== 'sessionFlags',
  )
  if (foreign)
    return `你的 Codex 配置里已有名为「${CODEX_GATEWAY_PROVIDER}」的模型服务（[model_providers.${CODEX_GATEWAY_PROVIDER}]），它的设置会混进发往 Latch 模型服务的请求。请在 Codex 配置里给它改名后再试，未打开会话。`
  const chosen = from('model_provider')
  if (chosen !== undefined && chosen !== 'sessionFlags')
    return 'Codex 的一层更高优先级的配置（如管理员的 managed_config.toml）指定了模型服务，会盖过 Latch 的设置，未打开会话。'
  return undefined
}
