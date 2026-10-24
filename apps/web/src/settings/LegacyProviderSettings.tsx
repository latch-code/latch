import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, errorMessage } from '../core/api.ts'
import { Button, InlineNotice } from '@latch/ui'
import { Loading, SectionHeading } from './common.tsx'

/** `GET /provider` of a Host that predates multiple providers (its snapshot has no catalog). */
interface LegacyProvider {
  configured: boolean
  baseURL: string
  model: string
  hasKey: boolean
  demo: boolean
}

/**
 * The single OpenAI-compatible provider of an older Host. Its `PUT /provider`
 * replaces the key on every save, so an empty key field removes a saved key.
 */
export function LegacyProviderSettings({ onChanged }: { onChanged: () => void }) {
  const [provider, setProvider] = useState<LegacyProvider | null>(null)
  const [baseURL, setBaseURL] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const load = useCallback(async (): Promise<LegacyProvider | null> => {
    try {
      const next = await api<LegacyProvider>('provider')
      setProvider(next)
      setBaseURL(next.baseURL)
      setModel(next.model)
      setError('')
      return next
    } catch (cause) {
      setError(errorMessage(cause))
      return null
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (busy || !baseURL.trim() || !model.trim()) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await api('provider', { method: 'PUT', body: { baseURL: baseURL.trim(), model: model.trim(), apiKey } })
      setApiKey('')
      onChanged()
      const next = await load()
      setNotice(next?.demo ? '已保存。执行端当前为演示模式，重启到普通模式后才会使用此模型服务。' : '已保存，可以开始会话。')
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const heading = (
    <SectionHeading title="模型服务" description="当前执行端版本只支持一个 OpenAI 兼容接口；升级执行端后可添加多个模型服务。" />
  )
  if (provider === null)
    return (
      <>
        {heading}
        {error ? (
          <InlineNotice
            tone="error"
            action={
              <Button
                onClick={() => {
                  void load()
                }}>
                重试
              </Button>
            }>
            {error}
          </InlineNotice>
        ) : (
          <Loading />
        )}
      </>
    )
  return (
    <>
      {heading}
      <form
        className="settings-group"
        onSubmit={event => {
          void save(event)
        }}>
        <div className="form-grid">
          <label className="field field-wide">
            <span>API 地址</span>
            <input
              type="url"
              required
              value={baseURL}
              placeholder="https://api.example.com/v1"
              spellCheck={false}
              autoComplete="off"
              disabled={busy}
              onChange={event => {
                setBaseURL(event.target.value)
                setNotice('')
              }}
            />
          </label>
          <label className="field field-wide">
            <span>模型 ID</span>
            <input
              required
              value={model}
              placeholder="服务提供方的模型名称"
              spellCheck={false}
              autoComplete="off"
              disabled={busy}
              onChange={event => {
                setModel(event.target.value)
                setNotice('')
              }}
            />
          </label>
          <label className="field field-wide">
            <span>
              API Key<small>可选</small>
            </span>
            <input
              type="password"
              value={apiKey}
              placeholder="输入密钥"
              autoComplete="new-password"
              disabled={busy}
              onChange={event => {
                setApiKey(event.target.value)
                setNotice('')
              }}
            />
            <small className="field-hint">
              {provider.hasKey
                ? '已保存密钥，不会回显。此版本保存时会用这里的内容替换密钥：留空将移除原密钥，继续使用请重新输入。'
                : '无需认证的本地服务可以留空。密钥只保存在执行端的私有目录。'}
            </small>
          </label>
        </div>
        <div className="settings-actions">
          <Button type="submit" disabled={busy || !baseURL.trim() || !model.trim()} loading={busy}>
            保存
          </Button>
        </div>
      </form>
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      {notice && !error && <InlineNotice tone="neutral">{notice}</InlineNotice>}
    </>
  )
}
