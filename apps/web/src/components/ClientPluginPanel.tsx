import * as React from 'react'
import { Component, useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react'
import { Button, Checkbox, InlineNotice, Loading, StatusPill, TextAreaField, TextField, type PluginPanelProps } from '@latch/ui'
import type { TaskSummary, UiPanelInfo } from '@latch/protocol'
import { api } from '../core/api.ts'

const ui = { Button, Checkbox, TextField, TextAreaField, InlineNotice, StatusPill, Loading }
type Panel = ComponentType<PluginPanelProps<TaskSummary>>
// Browsers retain failed ESM entries too. Keep the retry generation across component unmounts.
const failedModules = new Map<string, number>()

class PanelBoundary extends Component<{ children: ReactNode; retry: () => void }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? (
      <InlineNotice
        tone="error"
        action={
          <Button size="xs" onClick={this.props.retry}>
            重新加载
          </Button>
        }>
        这个插件的界面无法显示。其他会话仍可使用。
      </InlineNotice>
    ) : (
      this.props.children
    )
  }
}

/** Trusted ESM modules use the page's React instance and the existing conversation controls. */
export function ClientPluginPanel({
  panel,
  summary,
  canCompose,
  onCompose,
}: {
  panel: UiPanelInfo
  summary: TaskSummary
  canCompose: boolean
  onCompose: (text: string) => void
}) {
  const [retry, setRetry] = useState(0)
  const key = JSON.stringify([panel.id, panel.moduleHash, retry])
  const [loaded, setLoaded] = useState<{ key: string; component?: Panel; failed?: boolean } | null>(null)
  const mounted = useRef(false)
  const lifetime = useRef<AbortController | null>(null)
  useEffect(() => {
    mounted.current = true
    lifetime.current = new AbortController()
    return () => {
      mounted.current = false
      lifetime.current?.abort()
    }
  }, [])
  useEffect(() => {
    let current = true
    const base = `/link/api/ui-modules/${encodeURIComponent(panel.id)}/${panel.moduleHash}.mjs`
    const attempt = failedModules.get(base) ?? 0
    const url = `${base}${attempt ? `?reload=${attempt}` : ''}`
    void import(/* @vite-ignore */ url)
      .then((module: { default?: unknown }) => {
        if (typeof module.default !== 'function') throw new Error('Missing component')
        if (current) setLoaded({ key, component: module.default as Panel })
      })
      .catch(() => {
        if ((failedModules.get(base) ?? 0) === attempt) failedModules.set(base, attempt + 1)
        if (current) setLoaded({ key, failed: true })
      })
    return () => {
      current = false
    }
  }, [key, panel.id, panel.moduleHash])
  const reload = () => setRetry(value => value + 1)
  const current = loaded?.key === key ? loaded : null
  if (current?.failed)
    return (
      <InlineNotice
        tone="error"
        action={
          <Button size="xs" onClick={reload}>
            重试
          </Button>
        }>
        无法加载这个插件的界面，请同步后重试。
      </InlineNotice>
    )
  const View = current?.component
  if (!View) return <Loading label="正在加载插件界面…" />
  return (
    <PanelBoundary key={retry} retry={reload}>
      <View
        session={structuredClone(summary)}
        react={React}
        ui={ui}
        canCompose={canCompose}
        compose={text => {
          if (mounted.current && canCompose && typeof text === 'string' && text.trim() && text.length <= 16_000) onCompose(text)
        }}
        readData={(id, signal) => {
          if (!/^[a-zA-Z0-9_-]{1,64}$/u.test(id) || !lifetime.current || !mounted.current) return Promise.reject(new Error('面板已关闭。'))
          return api(`tasks/${encodeURIComponent(summary.id)}/ui-panels/${encodeURIComponent(`${panel.pluginId}:${id}`)}`, {
            signal: signal ? AbortSignal.any([signal, lifetime.current.signal]) : lifetime.current.signal,
          })
        }}
      />
    </PanelBoundary>
  )
}
