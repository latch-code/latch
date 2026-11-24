import * as React from 'react'
import { Component, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  BarChart,
  Button,
  Checkbox,
  IconButton,
  InlineNotice,
  LineChart,
  Loading,
  Meter,
  ShareBar,
  StatusPill,
  TextAreaField,
  TextField,
  type ContextPluginPanelProps,
  type PluginPanelProps,
} from '@latch/ui'
import type { SessionContext, TaskDetail, TaskSummary, UiPanelInfo } from '@latch/protocol'
import { api, MessageError } from '../core/api.ts'
import { defineCopy, useLocale } from '../core/i18n.ts'
import { useSessionContext } from '../panel/sessionContext.ts'

const COPY = defineCopy(
  {
    reload: '重新加载',
    crashed: '这个插件的界面无法显示。其他会话仍可使用。',
    retry: '重试',
    loadFailed: '无法加载这个插件的界面，请同步后重试。',
    loading: '正在加载插件界面…',
    loadingContext: '正在读取会话上下文…',
  },
  {
    reload: 'Reload',
    crashed: 'This plugin’s view could not be shown. Other sessions are available.',
    retry: 'Retry',
    loadFailed: 'Could not load this plugin’s view. Sync and try again.',
    loading: 'Loading plugin view…',
    loadingContext: 'Loading session context…',
  },
)

const ui = { Button, Checkbox, TextField, TextAreaField, InlineNotice, StatusPill, Loading }
const contextUi = { ...ui, IconButton, BarChart, LineChart, ShareBar, Meter }
type ContextProps = ContextPluginPanelProps<SessionContext>
type Panel = (props: PluginPanelProps<TaskSummary> | ContextProps) => ReactNode
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
            {COPY.reload}
          </Button>
        }>
        {COPY.crashed}
      </InlineNotice>
    ) : (
      this.props.children
    )
  }
}

function ContextPluginView({
  View,
  detail,
  onRevealTurn,
  onRevealTool,
}: {
  View: (props: ContextProps) => ReactNode
  detail: TaskDetail
  onRevealTurn: ((messageId: string) => void) | undefined
  onRevealTool: ((messageId: string) => void) | undefined
}) {
  const locale = useLocale()
  const bridge = useSessionContext(detail, onRevealTurn, onRevealTool)
  return <View {...bridge} react={React} ui={contextUi} locale={locale} />
}

/** Trusted ESM modules use the page's React instance and the existing conversation controls. */
export function ClientPluginPanel({
  panel,
  summary,
  canCompose,
  onCompose,
  detail,
  onRevealTurn,
  onRevealTool,
}: {
  panel: UiPanelInfo
  summary: TaskSummary
  canCompose: boolean
  onCompose: (text: string) => void
  detail?: TaskDetail | undefined
  onRevealTurn?: ((messageId: string) => void) | undefined
  onRevealTool?: ((messageId: string) => void) | undefined
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
            {COPY.retry}
          </Button>
        }>
        {COPY.loadFailed}
      </InlineNotice>
    )
  const View = current?.component
  if (!View) return <Loading label={COPY.loading} />
  if (panel.context)
    return (
      <PanelBoundary key={retry} retry={reload}>
        {detail?.summary.id === summary.id ? (
          <ContextPluginView View={View} detail={detail} onRevealTurn={onRevealTurn} onRevealTool={onRevealTool} />
        ) : (
          <Loading label={COPY.loadingContext} />
        )}
      </PanelBoundary>
    )
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
          if (!/^[a-zA-Z0-9_-]{1,64}$/u.test(id) || !lifetime.current || !mounted.current)
            return Promise.reject(new MessageError('面板已关闭。'))
          return api(`tasks/${encodeURIComponent(summary.id)}/ui-panels/${encodeURIComponent(`${panel.pluginId}:${id}`)}`, {
            signal: signal ? AbortSignal.any([signal, lifetime.current.signal]) : lifetime.current.signal,
          })
        }}
      />
    </PanelBoundary>
  )
}
