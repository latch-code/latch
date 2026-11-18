import { useEffect, useState } from 'react'
import { Monitor } from 'lucide-react'
import { Hint, Icon, Loading, GlobeGlyph } from '@latch/ui'
import { AgentsGlyph } from '../../agents/AgentAvatar.tsx'
import { api, errorMessage } from '../../core/api.ts'
import { VisibleText } from '../../components/VisibleText.tsx'
import { defineCopy } from '../../core/i18n.ts'

const COPY = defineCopy(
  {
    agentControl: 'Agent 在操作',
    personControl: '你在 Mac 上操作',
    loading: '加载中',
    browser: '浏览器',
    macTabs: 'Mac 上的标签',
    macOnly: '画面与操作只在这台 Mac 的 Latch 桌面端；这里只列出标签。在这里看实时画面尚未实现：那要把带登录的页面画面传到别的设备。',
    reading: '正在读取标签…',
    noWindow: 'Mac 上的 Latch 窗口没有打开',
    empty: '这个会话在 Mac 上没有标签',
    newTab: '新标签',
  },
  {
    agentControl: 'Agent is in control',
    personControl: 'You’re in control on the Mac',
    loading: 'Loading',
    browser: 'Browser',
    macTabs: 'Tabs on the Mac',
    macOnly:
      'Live view and controls are available in Latch on this Mac. Live viewing here isn’t available yet because it would require sending signed-in pages to another device.',
    reading: 'Reading tabs…',
    noWindow: 'The Latch window on the Mac is closed',
    empty: 'This session has no tabs on the Mac',
    newTab: 'New tab',
  },
)

/** A tab of the session as the Mac's desktop app reports it to the Host: never the query of its address. */
export interface ListedTab {
  tabId: string
  title: string
  url: string
  loading: boolean
  control: 'agent' | 'person' | null
}

const POLL_MS = 2_000

/** 「加载中 / Agent 在操作 / 你在 Mac 上操作」 */
export function tabStateText(tab: ListedTab): string | undefined {
  if (tab.control === 'agent') return COPY.agentControl
  if (tab.control === 'person') return COPY.personControl
  return tab.loading ? COPY.loading : undefined
}

/**
 * The 浏览器 page of a session on a phone, a browser or another computer: the session's tabs on the Mac, read-only. The
 * page itself shows only in the desktop app on that Mac; seeing or driving it from here is not built.
 */
export function BrowserTabList({ sessionId, shown }: { sessionId: string; shown: boolean }) {
  const [tabs, setTabs] = useState<ListedTab[]>()
  const [available, setAvailable] = useState(true)
  const [failure, setFailure] = useState<string>()

  useEffect(() => {
    if (!shown) return
    let live = true
    const controller = new AbortController()
    const read = () =>
      api<{ available: boolean; tabs: ListedTab[] }>(`tasks/${encodeURIComponent(sessionId)}/browser-tabs`, { signal: controller.signal })
        .then(answer => {
          if (!live) return
          setTabs(answer.tabs)
          setAvailable(answer.available)
          setFailure(undefined)
        })
        .catch(error => {
          if (live && !controller.signal.aborted) setFailure(errorMessage(error))
        })
    void read()
    const timer = setInterval(() => void read(), POLL_MS)
    return () => {
      live = false
      controller.abort()
      clearInterval(timer)
    }
  }, [sessionId, shown])

  return (
    <section className="browser-list" aria-label={COPY.browser}>
      <header className="browser-list-head">
        <Hint lead={<Icon icon={Monitor} size={12} />} label={COPY.macTabs}>
          {COPY.macOnly}
        </Hint>
      </header>
      {failure ? (
        <p className="browser-list-empty" role="status">
          <VisibleText text={failure} />
        </p>
      ) : tabs === undefined ? (
        <Loading label={COPY.reading} />
      ) : !available ? (
        <p className="browser-list-empty">{COPY.noWindow}</p>
      ) : tabs.length === 0 ? (
        <p className="browser-list-empty">{COPY.empty}</p>
      ) : (
        <ul className="browser-list-items">
          {tabs.map(tab => {
            const words = tabStateText(tab)
            return (
              <li key={tab.tabId} className="browser-list-item">
                <Icon icon={tab.control === 'agent' ? AgentsGlyph : GlobeGlyph} size={14} />
                <span className="browser-list-text">
                  <span className="browser-list-title">
                    <VisibleText text={tab.title || tab.url || COPY.newTab} />
                  </span>
                  <span className="browser-list-url">
                    <VisibleText text={tab.url} />
                  </span>
                </span>
                {words && <span className="browser-list-state">{words}</span>}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
