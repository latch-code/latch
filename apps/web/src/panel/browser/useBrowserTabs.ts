import { useEffect, useRef, useState } from 'react'
import type { BrowserColorScheme, BrowserPreset, ShellBrowser } from '../../core/shell.ts'
import { endedTabs, noticeText, refusalText, withEvent, withState, type KnownTab } from './model.ts'
import { defineCopy } from '../../core/i18n.ts'

const COPY = defineCopy(
  {
    takeOverFailed: '没有接手，请重试',
    handBackFailed: '没有交还，请重试',
    viewportFailed: '没有改变视口',
    appearanceFailed: '这个标签现在不能模拟外观（开发者工具可能占用了它）',
  },
  {
    takeOverFailed: 'Couldn’t take over. Try again.',
    handBackFailed: 'Couldn’t return control. Try again.',
    viewportFailed: 'Couldn’t change the viewport',
    appearanceFailed: 'This tab can’t simulate appearance right now. Developer tools may be using it.',
  },
)

const NOTICE_MS = 4_000

/**
 * The tabs of one session in the desktop app's preview browser. Main keeps every tab of the window; this lists them (a
 * page that reloaded gets them back), follows main's events and asks main for every change. Nothing here is optimistic:
 * a tab's state is what main last reported.
 */
export function useBrowserTabs({
  shell,
  sessionId,
  projectId,
  onHidden,
}: {
  shell: ShellBrowser
  sessionId: string
  projectId: string
  /** Main hid a tab (its page went away): whatever placed it must place it again. */
  onHidden?: (tabId: string) => void
}) {
  const hiddenRef = useRef(onHidden)
  hiddenRef.current = onHidden
  const [all, setAll] = useState<KnownTab[]>([])
  const [listed, setListed] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [active, setActive] = useState<string>()
  const [notice, setNotice] = useState<() => string>()
  const [failure, setFailure] = useState<() => string>()
  const allRef = useRef(all)
  allRef.current = all
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const say = (text: () => string) => {
    clearTimeout(noticeTimer.current)
    setNotice(() => text)
    noticeTimer.current = setTimeout(() => setNotice(undefined), NOTICE_MS)
  }

  const list = async () => {
    setListed('loading')
    try {
      const answer = await shell.list()
      if (!answer.ok) {
        setListed('failed')
        return
      }
      const now = Date.now()
      setAll(previous => {
        // An event may have come first: what main lists now wins.
        const known = new Map(previous.map(tab => [tab.tabId, tab]))
        return answer.tabs.map(tab => {
          const before = known.get(tab.tabId)
          const base: KnownTab = before ?? { tabId: tab.tabId, sessionId: tab.sessionId, projectId: tab.projectId, state: tab.state }
          return withState({ ...base, sessionId: tab.sessionId, projectId: tab.projectId }, tab.state, now)
        })
      })
      setActive(current => current ?? answer.tabs.filter(tab => tab.sessionId === sessionId).at(-1)?.tabId)
      setListed('ready')
    } catch {
      setListed('failed')
    }
  }

  useEffect(() => {
    const stop = shell.subscribe(event => {
      if (event.type === 'hidden') {
        hiddenRef.current?.(event.tabId)
        return
      }
      // The Agent works only in a tab in sight: the panel follows it to the tab it needs, or one it opened.
      if (event.type === 'reveal') {
        if (allRef.current.some(tab => tab.tabId === event.tabId && tab.sessionId === sessionId)) setActive(event.tabId)
        return
      }
      if (event.type === 'opened' && event.sessionId === sessionId && event.state.opener === 'agent') setActive(event.tabId)
      if (event.type === 'notice') {
        if (allRef.current.some(tab => tab.tabId === event.tabId && tab.sessionId === sessionId))
          say(() => noticeText(event.notice, event.detail))
        return
      }
      setAll(previous => withEvent(previous, event, Date.now()))
      if (event.type === 'closed')
        setActive(current => {
          if (current !== event.tabId) return current
          const mine = allRef.current.filter(tab => tab.sessionId === sessionId && tab.tabId !== event.tabId)
          return mine.at(-1)?.tabId
        })
    })
    void list()
    return () => {
      stop()
      clearTimeout(noticeTimer.current)
    }
  }, [shell, sessionId])

  const tabs = all.filter(tab => tab.sessionId === sessionId)
  const current = tabs.find(tab => tab.tabId === active) ?? tabs.at(-1)

  /** Opens a tab of this session, empty or at an address as typed; false (and a reason) when main refused it. */
  const open = async (url?: string): Promise<boolean> => {
    setFailure(undefined)
    const answer = await shell.open(projectId, sessionId, url ?? null)
    if (!answer.ok) {
      setFailure(() => () => refusalText(answer.error, answer.reason))
      return false
    }
    const tab: KnownTab = { tabId: answer.tabId, sessionId, projectId, state: answer.state }
    setAll(previous => (previous.some(item => item.tabId === tab.tabId) ? previous : [...previous, tab]))
    setActive(answer.tabId)
    return true
  }

  const navigate = async (tabId: string, url: string): Promise<boolean> => {
    setFailure(undefined)
    const answer = await shell.navigate(tabId, url)
    if (!answer.ok) setFailure(() => () => refusalText(answer.error, answer.reason))
    return answer.ok
  }

  const close = async (tabId: string) => {
    await shell.close(tabId)
  }

  /** Whatever main answers, the state event that follows is what the panel shows. */
  const settle = async (call: Promise<{ ok: boolean; error?: string }>, failed: () => string) => {
    const answer = await call
    if (!answer.ok) setFailure(() => failed)
    return answer.ok
  }

  return {
    tabs,
    /** Every tab of the window: the limit counts them all (tabs of ended sessions are closed as they end). */
    total: all.length,
    /** Tabs of the window's other sessions, closable from here. */
    others: all.filter(tab => tab.sessionId !== sessionId),
    current,
    listed,
    notice: notice?.(),
    failure: failure?.(),
    setFailure,
    say,
    select: setActive,
    list,
    open,
    navigate,
    close,
    /** 接手 and 交还给 Agent; absent from a shell without the Agent's browser. */
    takeOver: shell.takeOver ? (tabId: string) => settle(shell.takeOver!(tabId), () => COPY.takeOverFailed) : undefined,
    handBack: shell.handBack ? (tabId: string) => settle(shell.handBack!(tabId), () => COPY.handBackFailed) : undefined,
    viewport: (tabId: string, preset: BrowserPreset, rotated: boolean) =>
      settle(shell.setViewport(tabId, preset, rotated), () => COPY.viewportFailed),
    colorScheme: (tabId: string, scheme: BrowserColorScheme) => settle(shell.setColorScheme(tabId, scheme), () => COPY.appearanceFailed),
  }
}

/**
 * Closes the preview tabs of sessions the Host reports archived or deleted, whatever session the panel shows; a
 * reload's tabs are checked as soon as the listing arrives.
 */
export function useEndedSessionTabs(
  shell: ShellBrowser | null,
  snapshot: { tasks: ReadonlyArray<{ id: string; archived?: boolean }>; tasksComplete?: true },
  seesAll: boolean,
) {
  useEffect(() => {
    if (!shell) return
    let live = true
    void shell
      .list()
      .then(answer => {
        if (!live || !answer.ok) return
        for (const tabId of endedTabs(answer.tabs, snapshot, seesAll)) void shell.close(tabId)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [shell, snapshot.tasks, snapshot.tasksComplete, seesAll])
}
