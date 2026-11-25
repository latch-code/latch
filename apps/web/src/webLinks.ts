import { escapeSecurityText, looksSecret } from '@latch/protocol'

/** UTF-16 ranges of explicit web addresses in plain prose, preserving the spelling the person typed. */
export function webLinks(text: string): Array<{ start: number; end: number }> {
  const links: Array<{ start: number; end: number }> = []
  const scheme = /\bhttps?:\/\/(?![/?#])/giu
  for (let match = scheme.exec(text); match; match = scheme.exec(text)) {
    let end = scheme.lastIndex
    const closers: string[] = []
    for (; end < text.length; end++) {
      const char = text.charAt(end)
      if (/[\s<>"'`，。；！？：、（）【】《》“”‘’「」『』]/u.test(char)) break
      // Keep balanced parentheses in paths and brackets in IPv6 addresses. An outer closer belongs to the prose.
      if (char === '(') closers.push(')')
      if (char === '[') closers.push(']')
      if ((char === ')' || char === ']') && closers.pop() !== char) break
    }
    scheme.lastIndex = end
    while (end > match.index && /[.,;:!?]/u.test(text.charAt(end - 1))) end--
    const address = text.slice(match.index, end)
    if (address.includes('\\') || escapeSecurityText(address) !== address || looksSecret(address)) continue
    try {
      const url = new URL(address)
      if (!url.username && !url.password) links.push({ start: match.index, end })
    } catch {
      // A malformed or incomplete address stays plain, including while the person is typing it.
    }
  }
  return links
}
