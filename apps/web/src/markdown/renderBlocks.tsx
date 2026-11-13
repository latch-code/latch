import { Children, Fragment, isValidElement, type ReactNode } from 'react'
import { closeInline } from './closeInline.ts'
import { splitStreamBlocks } from './streamBlocks.ts'

interface CachedBlock {
  source: string
  children: ReactNode[]
  from: number
  wrapped: ReactNode[]
}

function childrenOf(element: ReactNode): ReactNode[] {
  return isValidElement<{ children?: ReactNode }>(element) && element.type === Fragment
    ? Children.toArray(element.props.children)
    : Children.toArray(element)
}

/** Memoizes independent blocks, keeping one flat element sequence even when the final document is parsed in full. */
export function createStreamingMarkdown(
  render: (source: string) => ReactNode | null,
  wrap: (source: string, child: ReactNode, index: number) => ReactNode,
) {
  let cache = new Map<number, CachedBlock>()
  return (source: string, streaming: boolean): ReactNode | null => {
    const blocks = streaming ? splitStreamBlocks(source) : null
    if (!blocks) {
      cache = new Map()
      const rendered = render(source)
      return rendered === null ? null : childrenOf(rendered).map((child, index) => wrap(source, child, index))
    }
    const next = new Map<number, CachedBlock>()
    const result: ReactNode[] = []
    for (const [index, block] of blocks.entries()) {
      const text = index === blocks.length - 1 ? closeInline(block.text) : block.text
      let entry = cache.get(block.start)
      if (entry?.source !== text) {
        const rendered = render(text)
        if (rendered === null) return null
        entry = { source: text, children: childrenOf(rendered), from: -1, wrapped: [] }
      }
      if (entry.children.length && result.length) result.push(wrap('', '\n', result.length))
      if (entry.from !== result.length) {
        const from = result.length
        entry = { ...entry, from, wrapped: entry.children.map((child, offset) => wrap(text, child, from + offset)) }
      }
      result.push(...entry.wrapped)
      next.set(block.start, entry)
    }
    cache = next
    return result
  }
}
