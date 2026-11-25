/** Source titles travel with the quoted text when a draft is restored on another device. */
export const quoteHeading = { handoff: '交回结果：', board: '待办回复：', side: '旁支回答：' } as const

export function quotedExcerpt(source: keyof typeof quoteHeading, text: string): string {
  const lines = text
    .trim()
    .split('\n')
    .map(line => (line ? '> ' + line : '>'))
  return [quoteHeading[source], ...lines].join('\n')
}
