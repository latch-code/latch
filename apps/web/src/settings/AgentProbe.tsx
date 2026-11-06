import { useRef, useState } from 'react'
import { FlaskConical } from 'lucide-react'
import { AGENT_PROBE_MAX_MS, type AgentProbeResult, type AgentSettings, type HarnessLogin } from '@latch/protocol'
import { Button, InlineNotice, CopyButton } from '@latch/ui'
import { HarnessLoginSteps } from '../components/HarnessLogin.tsx'
import { VisibleText } from '../components/VisibleText.tsx'
import { api, inlineError, isUncertain } from '../core/api.ts'
import { dateTime } from '../format.ts'
import { SettingsGroup, SettingsRow } from './common.tsx'

export function probeResultTitle(result: AgentProbeResult | undefined): string {
  if (!result) return '尚未测试启动'
  if (result.login === 'unauthenticated') return '还没登录'
  if (result.status === 'ready') return result.login === 'authenticated' ? '可以启动，已登录' : '启动握手成功'
  return result.status === 'authentication-required' ? '需要先登录' : '测试启动失败'
}

export function probeRowDescription(result: AgentProbeResult | undefined, busy: boolean): string {
  if (busy) return `最多等待 ${AGENT_PROBE_MAX_MS / 1000} 秒。`
  if (result?.status === 'ready') {
    if (result.login === 'unauthenticated') return '在终端里登录，再重新测试。'
    return result.login === 'authenticated' ? '模型访问尚未验证。' : '登录状态与模型访问尚未验证。'
  }
  if (result?.status === 'authentication-required') return '在终端里登录，再重新测试。'
  return result ? '查看诊断，检查安装、启动配置或登录状态后重试。' : '检查程序能否启动，以及它声明的能力。'
}

export function AgentProbe({
  agent,
  disabledReason,
  disabled = false,
  onSaved,
  login,
  terminal = false,
}: {
  agent: AgentSettings
  login?: HarnessLogin | undefined
  terminal?: boolean
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
        result.capabilities.images && '图片',
        result.capabilities.resume && '恢复会话',
        result.capabilities.load && '加载会话',
        result.capabilities.additionalDirectories && '附加文件夹',
      ]
        .filter(Boolean)
        .join('、')
    : ''
  return (
    <SettingsGroup
      title="测试启动"
      caption={disabledReason ?? '会运行 Harness 程序；只检查启动握手，不发送提示词。'}
      captionIcon={disabledReason ? 'lock' : 'info'}>
      <SettingsRow
        title={busy ? '正在测试启动' : probeResultTitle(result)}
        description={probeRowDescription(result, busy)}
        trailing={
          <Button
            icon={FlaskConical}
            loading={busy}
            disabled={disabled || Boolean(disabledReason)}
            onClick={() => {
              void run()
            }}>
            {uncertain ? '重试本次测试' : '测试启动'}
          </Button>
        }
      />
      <div className="settings-card-body agent-probe-body">
        {error && <InlineNotice tone="error">{uncertain ? '测试结果未确认；请重试同一次请求以同步结果。' : error}</InlineNotice>}
        {result?.login === 'unauthenticated' && login && <HarnessLoginSteps harnessId={agent.id} login={login} terminal={terminal} />}
        {result && (
          <>
            <p className="agent-probe-meta">
              最近测试：<time dateTime={result.checkedAt}>{dateTime(result.checkedAt)}</time>
              {result.agent && (
                <span>
                  <VisibleText text={[result.agent.name, result.agent.version].filter(Boolean).join(' ')} />
                </span>
              )}
              {result.program && (
                <span>
                  <VisibleText text={`${result.program.name} ${result.program.version ?? '版本未知'}`} />
                </span>
              )}
            </p>
            {result.program?.unchecked && (
              <InlineNotice tone="warn" title="这个组合 Latch 没有核对过">
                {`仍可以开始会话；会话出现异常时，可能与适配器和 ${result.program.name} 的版本不配套有关。`}
              </InlineNotice>
            )}
            {result.status === 'ready' && <p className="agent-probe-meta">{supported ? `声明支持：${supported}` : '没有声明附加能力。'}</p>}
            {result.authMethods.length > 0 && (
              <p className="agent-probe-meta">
                提供的登录方式：
                <VisibleText text={result.authMethods.map(method => method.name).join('、')} />
              </p>
            )}
            {result.diagnostic && (
              <div className="agent-probe-diagnostic">
                <div className="agent-probe-diagnostic-head">
                  <span>诊断</span>
                  <CopyButton text={result.diagnostic} label="复制诊断" />
                </div>
                <pre className="agent-probe-output" role="region" aria-label="启动诊断内容" tabIndex={0}>
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
