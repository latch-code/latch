import type { Terminal } from '@xterm/xterm'

export interface TerminalMatch {
  row: number
  current: number
  total: number
}

/** Match logical output lines, including ones soft-wrapped by xterm. Row selection also works for wide and combining characters. */
export function findTerminalLine(terminal: Terminal, query: string, previous: number | undefined, direction: 1 | -1): TerminalMatch {
  const buffer = terminal.buffer.active
  const needle = query.toLowerCase()
  const hits: Array<{ start: number; end: number }> = []
  if (needle) {
    for (let row = 0; row < buffer.length; row++) {
      const start = row
      let line = ''
      while (buffer.getLine(row + 1)?.isWrapped) {
        line += buffer.getLine(row)?.translateToString(false) ?? ''
        row++
      }
      line += buffer.getLine(row)?.translateToString(true) ?? ''
      if (line.toLowerCase().includes(needle)) hits.push({ start, end: row })
    }
  }
  if (!hits.length) {
    terminal.clearSelection()
    return { row: -1, current: 0, total: 0 }
  }
  let index = hits.length - 1
  if (previous !== undefined) {
    index = direction === 1 ? hits.findIndex(hit => hit.start > previous) : hits.findLastIndex(hit => hit.start < previous)
    if (index < 0) index = direction === 1 ? 0 : hits.length - 1
  }
  const match = hits[index]!
  terminal.selectLines(match.start, match.end)
  terminal.scrollToLine(Math.max(0, match.start - Math.floor(terminal.rows / 2)))
  return { row: match.start, current: index + 1, total: hits.length }
}
