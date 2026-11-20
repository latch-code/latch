import { useSyncExternalStore } from 'react'

export type UiLocale = 'zh-CN' | 'en'

let fixed: UiLocale | undefined
let observer: MutationObserver | undefined
const listeners = new Set<() => void>()

export function uiLocale(): UiLocale {
  if (fixed !== undefined) return fixed
  const lang = globalThis.document?.documentElement?.lang ?? ''
  return lang === '' || /^zh(?:-|$)/iu.test(lang) ? 'zh-CN' : 'en'
}

function publish(): void {
  for (const listener of listeners) listener()
}

/** The gallery may set a language of its own. Clearing it follows the document again. */
export function setUiLocale(locale: UiLocale | undefined): void {
  const previous = uiLocale()
  fixed = locale
  if (uiLocale() !== previous) publish()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  const root = globalThis.document?.documentElement
  if (observer === undefined && typeof MutationObserver === 'function' && root) {
    observer = new MutationObserver(publish)
    observer.observe(root, { attributes: true, attributeFilter: ['lang'] })
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      observer?.disconnect()
      observer = undefined
    }
  }
}

/** Subscribes to the document's language without coupling the primitives to their caller. */
export function useUiLocale(): UiLocale {
  return useSyncExternalStore(subscribe, uiLocale, uiLocale)
}

type Translation<T> = T extends string
  ? string
  : T extends (...args: infer Args) => infer Result
    ? (...args: Args) => Translation<Result>
    : T extends object
      ? { readonly [Key in keyof T]: Translation<T[Key]> }
      : T

function defineCopy<T extends object>(zh: T, en: NoInfer<Translation<T>>): Translation<T> {
  const english = en as object
  return new Proxy(zh, {
    get(target, key) {
      return uiLocale() === 'en' ? Reflect.get(english, key) : Reflect.get(target, key)
    },
  }) as Translation<T>
}

/** Default labels are read on each render so the primitives can follow a change to the document language. */
export const UI_COPY = defineCopy(
  {
    unavailable: '此项暂不可用',
    back: '返回',
    actionFailed: '操作未完成，请重试。',
    cancel: '取消',
    save: '保存',
    saveFailed: '保存失败，请重试。',
    copy: '复制',
    copied: '已复制',
    copyUnavailable: '复制不可用，请手动选择',
    copyFailed: '复制失败',
    close: '关闭',
    clearSearch: '清除搜索',
    dev: '开发版',
    demo: '演示',
    demoModel: '演示模型',
    search: '搜索',
    searchIn: (label: string) => `搜索${label}`,
    unselected: '未选择',
    verifying: '等待验证…',
    more: '说明',
    collapsed: '已收起',
    pixels: (value: number) => `${value} 像素`,
    loading: '正在加载',
    running: '运行中',
    waiting: '等你处理',
    failed: '失败',
    fresh: '有新内容',
    moreTabs: (count: number) => `其余 ${count} 个标签`,
    noMatches: '没有匹配的',
    noChoices: '没有可选的',
    sources: '来源',
    total: '合计',
    checks: (passed: number, total: number, failed: number) => `检查 ${passed}/${total} 通过${failed > 0 ? `，${failed} 项失败` : ''}`,
    heatWeek: ['一', '二', '三', '四', '五', '六', '日'] as const,
    heatTotal: (label: string, total: string) => `${label}：共 ${total}`,
    heatHour: (day: string, hour: number) => `周${day} ${hour}:00–${hour + 1}:00`,
  },
  {
    unavailable: 'Not available right now',
    back: 'Back',
    actionFailed: 'Not done. Try again.',
    cancel: 'Cancel',
    save: 'Save',
    saveFailed: 'Could not save. Try again.',
    copy: 'Copy',
    copied: 'Copied',
    copyUnavailable: 'Copy unavailable. Select the text manually.',
    copyFailed: 'Copy failed',
    close: 'Close',
    clearSearch: 'Clear search',
    dev: 'Dev',
    demo: 'Demo',
    demoModel: 'Demo model',
    search: 'Search',
    searchIn: (label: string) => `Search ${label}`,
    unselected: 'None selected',
    verifying: 'Verifying…',
    more: 'Details',
    collapsed: 'Collapsed',
    pixels: (value: number) => `${value} pixels`,
    loading: 'Loading',
    running: 'Running',
    waiting: 'Needs you',
    failed: 'Failed',
    fresh: 'New content',
    moreTabs: (count: number) => `${count} more ${count === 1 ? 'tab' : 'tabs'}`,
    noMatches: 'No matches',
    noChoices: 'No choices',
    sources: 'Sources',
    total: 'Total',
    checks: (passed: number, total: number, failed: number) => `Checks: ${passed}/${total} passed${failed > 0 ? `, ${failed} failed` : ''}`,
    heatWeek: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const,
    heatTotal: (label: string, total: string) => `${label}: ${total} total`,
    heatHour: (day: string, hour: number) => `${day} ${hour}:00–${hour + 1}:00`,
  },
)
