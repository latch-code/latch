import { useRef, useState } from 'react'
import { Play } from 'lucide-react'
import { AGENT_PROBE_MAX_MS, type AgentProbeResult, type AgentSettings } from '@latch/protocol'
import { Button, Hint, InlineNotice, CopyButton } from '@latch/ui'
import { VisibleText } from '../components/VisibleText.tsx'
import { api, inlineError, isUncertain } from '../core/api.ts'
import { dateTime } from '../format.ts'
import { NoteLine, SettingsGroup, SettingsRow } from './common.tsx'
import { defineCopy, formatNumber, listText, plural } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    notTested: '尚未测试启动',
    loggedOut: '还没登录',
    readyLoggedIn: '可以启动，已登录',
    handshake: '启动握手成功',
    loginNeeded: '需要先登录',
    testFailed: '测试启动失败',
    loginInTerminal: '在终端里登录，再重新测试。',
    modelUnchecked: '模型访问尚未验证。',
    loginAndModelUnchecked: '登录状态与模型访问尚未验证。',
    checkDiagnostics: '查看诊断，检查安装、启动配置或登录状态后重试。',
    whatItChecks: '检查程序能否启动，以及它声明的能力。',
    images: '图片',
    resume: '恢复会话',
    load: '加载会话',
    extraFolders: '附加文件夹',
    test: '测试启动',
    noPrompt: '不发送提示词',
    noPromptDetail: '会运行 Harness 程序，只检查启动握手。',
    testing: '正在测试启动',
    retryThis: '重试本次测试',
    uncertain: '测试结果未确认；请重试同一次请求以同步结果。',
    lastTest: '最近测试：',
    unknownVersion: '版本未知',
    untestedPair: '这个组合 Latch 没有核对过',
    stillAvailable: '仍可以开始会话',
    noAdditionalCapabilities: '没有声明附加能力。',
    loginMethods: '提供的登录方式：',
    diagnostics: '诊断',
    copyDiagnostics: '复制诊断',
    launchDiagnostics: '启动诊断内容',
    timeout: (seconds: number) => `最多等待 ${formatNumber(seconds)} 秒。`,
    versionDetail: (program: string) => `会话出现异常时，可能与适配器和 ${program} 的版本不配套有关。`,
    declared: (items: string) => `声明支持：${items}`,
    capabilitySeparator: '、',
  },
  {
    notTested: 'Not tested yet',
    loggedOut: 'Not logged in',
    readyLoggedIn: 'Launches, logged in',
    handshake: 'Launch handshake OK',
    loginNeeded: 'Login needed',
    testFailed: 'Launch test failed',
    loginInTerminal: 'Log in from a terminal, then test again.',
    modelUnchecked: 'Model access not checked yet.',
    loginAndModelUnchecked: 'Login and model access not checked yet.',
    checkDiagnostics: 'See the diagnostics, check the install, launch setup or login, then try again.',
    whatItChecks: 'Checks that the program launches and what it supports.',
    images: 'images',
    resume: 'resuming sessions',
    load: 'loading sessions',
    extraFolders: 'extra folders',
    test: 'Test launch',
    noPrompt: 'Sends no prompt',
    noPromptDetail: 'Runs the Harness program and only checks the launch handshake.',
    testing: 'Testing launch',
    retryThis: 'Retry this test',
    uncertain: 'Result not confirmed. Retry the same test to sync it.',
    lastTest: 'Last test: ',
    unknownVersion: 'Version unknown',
    untestedPair: 'Latch hasn’t checked this pairing',
    stillAvailable: 'Sessions can still start',
    noAdditionalCapabilities: 'No extra capabilities declared.',
    loginMethods: 'Login methods: ',
    diagnostics: 'Diagnostics',
    copyDiagnostics: 'Copy diagnostics',
    launchDiagnostics: 'Launch diagnostics',
    timeout: (seconds: number) => `Waits up to ${plural(seconds, { one: '{n} second', other: '{n} seconds' })}.`,
    versionDetail: (program: string) => `Session problems may stem from a version mismatch between the adapter and ${program}.`,
    declared: (items: string) => `Reports support for ${items}`,
    capabilitySeparator: ', ',
  },
)

export function probeResultTitle(result: AgentProbeResult | undefined): string {
  if (!result) return COPY.notTested
  if (result.login === 'unauthenticated') return COPY.loggedOut
  if (result.status === 'ready') return result.login === 'authenticated' ? COPY.readyLoggedIn : COPY.handshake
  return result.status === 'authentication-required' ? COPY.loginNeeded : COPY.testFailed
}

export function probeRowDescription(result: AgentProbeResult | undefined, busy: boolean): string {
  if (busy) return COPY.timeout(AGENT_PROBE_MAX_MS / 1000)
  if (result?.status === 'ready') {
    if (result.login === 'unauthenticated') return COPY.loginInTerminal
    return result.login === 'authenticated' ? COPY.modelUnchecked : COPY.loginAndModelUnchecked
  }
  if (result?.status === 'authentication-required') return COPY.loginInTerminal
  return result ? COPY.checkDiagnostics : COPY.whatItChecks
}

export function AgentProbe({
  agent,
  disabledReason,
  disabled = false,
  onSaved,
}: {
  agent: AgentSettings
  disabledReason?: string
  disabled?: boolean
  onSaved(): void
}) {
  const [result, setResult] = useState(agent.lastProbe)
  const [seen, setSeen] = useState(agent.lastProbe)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [uncertain, setUncertain] = useState(false)
  const inFlight = useRef(false)
  const pending = useRef<string | null>(null)
  if (seen !== agent.lastProbe) {
    setSeen(agent.lastProbe)
    setResult(agent.lastProbe)
  }
  const run = async () => {
    if (inFlight.current || disabled || disabledReason) return
    inFlight.current = true
    setBusy(true)
    setError('')
    const body = { requestId: (pending.current ??= crypto.randomUUID()) }
    try {
      // Past the Host's own limit it still stops the program and saves the result.
      const next = await api<AgentProbeResult>(`agents/${encodeURIComponent(agent.id)}/probe`, {
        method: 'POST',
        body,
        timeoutMs: AGENT_PROBE_MAX_MS + 5_000,
      })
      setResult(next)
      pending.current = null
      setUncertain(false)
      onSaved()
    } catch (cause) {
      const unknown = isUncertain(cause)
      if (!unknown) pending.current = null
      setUncertain(unknown)
      setError(inlineError(cause))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }
  const supported = result
    ? [
        result.capabilities.images && COPY.images,
        result.capabilities.resume && COPY.resume,
        result.capabilities.load && COPY.load,
        result.capabilities.additionalDirectories && COPY.extraFolders,
      ]
        .filter(Boolean)
        .join(COPY.capabilitySeparator)
    : ''
  return (
    <SettingsGroup
      title={COPY.test}
      caption={disabledReason}
      captionIcon="lock"
      note={disabledReason ? undefined : <NoteLine brief={{ label: COPY.noPrompt, detail: COPY.noPromptDetail }} />}>
      <SettingsRow
        title={busy ? COPY.testing : probeResultTitle(result)}
        description={probeRowDescription(result, busy)}
        trailing={
          <Button
            icon={Play}
            loading={busy}
            disabled={disabled || Boolean(disabledReason)}
            onClick={() => {
              void run()
            }}>
            {uncertain ? COPY.retryThis : COPY.test}
          </Button>
        }
      />
      <div className="settings-card-body agent-probe-body">
        {error && <InlineNotice tone="error">{uncertain ? COPY.uncertain : error}</InlineNotice>}
        {result && (
          <>
            <p className="agent-probe-meta">
              {COPY.lastTest}
              <time dateTime={result.checkedAt}>{dateTime(result.checkedAt)}</time>
              {result.agent && (
                <span>
                  <VisibleText text={[result.agent.name, result.agent.version].filter(Boolean).join(' ')} />
                </span>
              )}
              {result.program && (
                <span>
                  <VisibleText text={`${result.program.name} ${result.program.version ?? COPY.unknownVersion}`} />
                </span>
              )}
            </p>
            {result.program?.unchecked && (
              <InlineNotice tone="warn" title={COPY.untestedPair}>
                <Hint inline label={COPY.stillAvailable}>
                  <VisibleText text={COPY.versionDetail(result.program.name)} />
                </Hint>
              </InlineNotice>
            )}
            {result.status === 'ready' && (
              <p className="agent-probe-meta">{supported ? COPY.declared(supported) : COPY.noAdditionalCapabilities}</p>
            )}
            {result.authMethods.length > 0 && (
              <p className="agent-probe-meta">
                {COPY.loginMethods}
                <VisibleText
                  text={listText(
                    result.authMethods.map(method => method.name),
                    'unit',
                  )}
                />
              </p>
            )}
            {result.diagnostic && (
              <div className="agent-probe-diagnostic">
                <div className="agent-probe-diagnostic-head">
                  <span>{COPY.diagnostics}</span>
                  <CopyButton text={result.diagnostic} label={COPY.copyDiagnostics} />
                </div>
                <pre className="agent-probe-output" role="region" aria-label={COPY.launchDiagnostics} tabIndex={0}>
                  <VisibleText text={result.diagnostic} />
                </pre>
              </div>
            )}
          </>
        )}
      </div>
    </SettingsGroup>
  )
}
