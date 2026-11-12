import type { BrowserTool } from './index.ts'

/** At most this many tabs, and references per tab, are remembered for labels. */
const TABS = 64
const REFS = 2_000
const NAME = 40

interface Seen {
  /** `localhost:5173`, from the last address a result named. */
  host?: string
  /** Element references to the name the page gave them, from the last read or find. */
  refs: Map<string, string>
}

const clip = (text: string) => (text.length > NAME ? `${text.slice(0, NAME - 1)}…` : text)

function hostOf(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.host : undefined
  } catch {
    return undefined
  }
}

/** `button "保存设置" [e1]` → e1 is 「"保存设置"」; an element with no name goes by its role. */
function refLine(line: string): [string, string] | undefined {
  const ref = /\[(e\d{1,6})\]/u.exec(line)?.[1]
  if (!ref) return undefined
  const body = line.replace(/^\s*-\s*/u, '').replace(/\s*\[e\d{1,6}\].*$/u, '')
  const name = /"([^"]{1,200})"/u.exec(body)?.[1]
  const role = /^[a-z]+/u.exec(body)?.[0]
  const words = name ? `"${clip(name)}"` : role
  return words ? [ref, words] : undefined
}

/**
 * What the Host's own results said of each tab: where it is and what its element references name. Only for labels on an
 * approval card, never for deciding anything; the page's words are shown as the page's (quoted, cut short).
 */
export class BrowserLabels {
  private readonly tabs = new Map<string, Seen>()

  private tab(tabId: string): Seen {
    let seen = this.tabs.get(tabId)
    if (!seen) {
      seen = { refs: new Map() }
      this.tabs.set(tabId, seen)
      if (this.tabs.size > TABS) this.tabs.delete(this.tabs.keys().next().value!)
    }
    return seen
  }

  /** Learns from a call that succeeded: its arguments and the text main answered with. */
  learn(tool: BrowserTool, args: Record<string, unknown>, text: string): void {
    const tabId = typeof args.tabId === 'string' ? args.tabId : undefined
    if (tool === 'browser_open') {
      const opened = /(brw_[A-Za-z0-9_-]{22})\s*打开\s*(\S+?)[：:\s]/u.exec(text)
      if (opened) {
        const seen = this.tab(opened[1]!)
        seen.host = hostOf(opened[2]!) ?? seen.host
        seen.refs.clear()
      }
      return
    }
    if (tool === 'browser_tabs') {
      for (const line of text.split('\n')) {
        const listed = /(brw_[A-Za-z0-9_-]{22})\b.*?\s(https?:\/\/\S+)/u.exec(line)
        if (listed) this.tab(listed[1]!).host = hostOf(listed[2]!) ?? this.tab(listed[1]!).host
      }
      return
    }
    if (!tabId) return
    if (tool === 'browser_close') {
      this.tabs.delete(tabId)
      return
    }
    const seen = this.tab(tabId)
    if (tool === 'browser_navigate' && typeof args.url === 'string') {
      seen.host = hostOf(args.url) ?? seen.host
      seen.refs.clear()
      return
    }
    if (tool !== 'browser_read' && tool !== 'browser_find') return
    const page = /https?:\/\/\S+/u.exec(text.split('\n').find(line => line.includes('页面：')) ?? '')?.[0]
    if (page) seen.host = hostOf(page) ?? seen.host
    // A new read starts the references afresh; a find adds to them.
    if (tool === 'browser_read') seen.refs.clear()
    for (const line of text.split('\n')) {
      const found = refLine(line)
      if (!found) continue
      seen.refs.delete(found[0])
      seen.refs.set(found[0], found[1])
      if (seen.refs.size > REFS) seen.refs.delete(seen.refs.keys().next().value!)
    }
  }

  /** The approval card's short label for a call that acts, or undefined when there is nothing better than its title. */
  summary(tool: BrowserTool, args: Record<string, unknown>): string | undefined {
    const seen = typeof args.tabId === 'string' ? this.tabs.get(args.tabId) : undefined
    const where = seen?.host ? `在 ${seen.host} ` : ''
    const element = typeof args.ref === 'string' ? (seen?.refs.get(args.ref) ?? args.ref) : undefined
    switch (tool) {
      case 'browser_click':
        return element ? `${where}${args.hover === true ? '悬停在' : args.double === true ? '双击' : '点击'} ${element}` : undefined
      case 'browser_type': {
        const length = typeof args.text === 'string' ? [...args.text].length : 0
        return element ? `${where}往 ${element} 输入 ${length} 个字${args.submit === true ? '并按回车' : ''}` : undefined
      }
      case 'browser_select':
        return element ? `${where}在 ${element} 选择 "${clip(String(args.value ?? ''))}"` : undefined
      case 'browser_key':
        return typeof args.key === 'string' ? `${where}按 ${clip(args.key)}` : undefined
      case 'browser_navigate': {
        const to = typeof args.url === 'string' ? hostOf(args.url.includes('://') ? args.url : `http://${args.url}`) : undefined
        if (to) return `${where}打开 ${clip(args.url as string)}`
        const step = { back: '后退', forward: '前进', reload: '重新载入' }[String(args.action)]
        return step ? `${where}${step}` : undefined
      }
      case 'browser_open':
        return typeof args.url === 'string' ? `打开 ${clip(args.url)}` : '打开空白标签'
      case 'browser_close':
        return seen?.host ? `关闭 ${seen.host} 的标签` : undefined
      default:
        return undefined
    }
  }
}
