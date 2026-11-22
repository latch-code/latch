import { useSyncExternalStore } from 'react'

const LOCALES = ['zh-CN', 'en'] as const
export type Locale = (typeof LOCALES)[number]
export type LocalePreference = 'system' | Locale

export const isLocalePreference = (value: unknown): value is LocalePreference => value === 'system' || value === 'zh-CN' || value === 'en'

/** The first supported language wins. An empty list uses the source language. */
export function systemLocale(languages: readonly string[] = typeof navigator === 'undefined' ? [] : navigator.languages): Locale {
  for (const language of languages) {
    if (/^zh(?:-|$)/iu.test(language)) return 'zh-CN'
    if (/^en(?:-|$)/iu.test(language)) return 'en'
  }
  return languages.length === 0 ? 'zh-CN' : 'en'
}

export const resolveLocale = (preference: LocalePreference, languages?: readonly string[]): Locale =>
  preference === 'system' ? systemLocale(languages) : preference

let current: Locale = 'zh-CN'
const listeners = new Set<() => void>()

export const currentLocale = (): Locale => current

/** Sets the document language before notifying readers, including on the first render. */
export function setLocale(next: Locale): void {
  const previous = current
  current = next
  const root = globalThis.document?.documentElement
  if (root && root.lang !== next) root.lang = next
  if (next !== previous) for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, currentLocale, currentLocale)
}

type Translation<T> = T extends string
  ? string
  : T extends (...args: infer Args) => infer Result
    ? (...args: Args) => Translation<Result>
    : T extends object
      ? { readonly [Key in keyof T]: Translation<T[Key]> }
      : T

/** Define copy with matching keys and function arguments. Read the returned properties during render. */
export function defineCopy<T extends object>(zh: T, en: NoInfer<Translation<T>>): Translation<T> {
  const english = en as object
  return new Proxy(
    { ...zh },
    {
      get(target, key) {
        return current === 'en' && Object.hasOwn(english, key) ? Reflect.get(english, key) : Reflect.get(target, key)
      },
    },
  ) as Translation<T>
}

const pluralRules = new Map<Locale, Intl.PluralRules>()

export function plural(count: number, forms: { one?: string; other: string }): string {
  let rules = pluralRules.get(current)
  if (!rules) {
    rules = new Intl.PluralRules(current)
    pluralRules.set(current, rules)
  }
  const form = rules.select(count) === 'one' ? (forms.one ?? forms.other) : forms.other
  return form.replaceAll('{n}', formatNumber(count))
}

const numberFormats = new Map<Locale, Intl.NumberFormat>()

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  if (options !== undefined) return new Intl.NumberFormat(current, options).format(value)
  let format = numberFormats.get(current)
  if (!format) {
    format = new Intl.NumberFormat(current)
    numberFormats.set(current, format)
  }
  return format.format(value)
}

export function formatList(items: readonly string[], type: 'conjunction' | 'disjunction' | 'unit' = 'conjunction'): string {
  return new Intl.ListFormat(current, { style: 'long', type }).format(items)
}

/**
 * Items named one after another, as each language writes it: Chinese puts 、 between all of them (its list format ends
 * on 和, which reads as a sentence), English writes `A, B, C` for a row of labels (`unit`) and `A, B, and C` in a sentence.
 * An item with no words (a label lookup that found none) is left out rather than failing the list.
 */
export function listText(items: readonly (string | undefined)[], type: 'conjunction' | 'unit' = 'conjunction'): string {
  const named = items.filter((item): item is string => typeof item === 'string' && item !== '')
  return current === 'zh-CN' ? named.join('、') : formatList(named, type)
}
