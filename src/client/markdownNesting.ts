/**
 * Markdown parsing, Markdown-to-HTML conversion and React rendering all recurse once per nesting level, so a reply of
 * a few kilobytes such as `>>>>…`, `- - - …` or `****…` overflows the stack and unmounts the page. Such text is shown
 * as plain text. Two checks: a linear estimate before parsing keeps the parser itself (and its slow paths) away from
 * extreme input, and the parsed tree's real depth decides the rest, so code blocks and ordinary replies stay Markdown.
 */

/** Containers opened at the start of one line, as estimated before parsing. */
export const MAX_LINE_CONTAINERS = 100
/** Emphasis delimiters that could be open at once within one paragraph, as estimated before parsing. */
export const MAX_OPEN_DELIMITERS = 1000
/** Depth of the parsed Markdown tree that is still rendered as Markdown. */
export const MAX_TREE_DEPTH = 128

const LIST_MARKER = /^(?:[-+*]|\d{1,9}[.)])(?=[ \t]|$)/
const FOOTNOTE_LABEL = /^\[\^[^\]\s]{1,999}\]:/
const isSpace = (character: string | undefined) => character === ' ' || character === '\t'
const isWhitespace = (character: string | undefined) => character === undefined || /\s/u.test(character)

/** `>`, list markers and footnote labels at the start of a line, plus indentation (a nested list level needs two columns). */
function lineContainers(line: string): number {
  let index = 0
  let width = 0
  while (isSpace(line[index])) {
    width = line[index] === '\t' ? width + 4 - (width % 4) : width + 1
    index++
  }
  let markers = 0
  for (;;) {
    if (line[index] === '>') {
      markers++
      index++
    } else {
      const marker =
        line[index] === '[' ? FOOTNOTE_LABEL.exec(line.slice(index, index + 1004)) : LIST_MARKER.exec(line.slice(index, index + 11))
      if (!marker) break
      markers++
      index += marker[0].length
    }
    // Deep enough already; the rest of a long line need not be read.
    if (Math.floor(width / 2) + markers > MAX_LINE_CONTAINERS) break
    while (isSpace(line[index])) index++
  }
  return markers === 0 ? 0 : Math.floor(width / 2) + markers
}

/**
 * Emphasis and strikethrough nest at most as deep as the delimiters that could be open at some point while as many
 * that could close follow it. Every run that might open or close is counted as such, so this only overestimates.
 */
function openDelimiters(paragraph: string): number {
  const runs: Array<{ open: number; close: number }> = []
  let closers = 0
  for (const match of paragraph.matchAll(/\*+|_+|~+/g)) {
    const before = paragraph[match.index - 1]
    const after = paragraph[match.index + match[0].length]
    const run = { open: isWhitespace(after) ? 0 : match[0].length, close: isWhitespace(before) ? 0 : match[0].length }
    closers += run.close
    runs.push(run)
  }
  let deepest = 0
  let opened = 0
  for (const run of runs) {
    opened += run.open
    closers -= run.close
    deepest = Math.max(deepest, Math.min(opened, closers))
  }
  return deepest
}

/** Linear and conservative: true when the text must not reach the Markdown parser at all. */
export function exceedsMarkdownNesting(text: string): boolean {
  let paragraph: string[] = []
  const closeParagraph = () => {
    const deep = paragraph.length > 0 && openDelimiters(paragraph.join('\n')) > MAX_OPEN_DELIMITERS
    paragraph = []
    return deep
  }
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (lineContainers(line) > MAX_LINE_CONTAINERS) return true
    if (line.trim() === '') {
      if (closeParagraph()) return true
    } else paragraph.push(line)
  }
  return closeParagraph()
}

interface TreeNode {
  children?: TreeNode[]
}

/** Depth of a parsed tree, measured without recursion. */
export function treeDepth(root: TreeNode): number {
  let deepest = 0
  const stack: Array<[TreeNode, number]> = [[root, 0]]
  while (stack.length > 0) {
    const [node, depth] = stack.pop()!
    if (depth > deepest) deepest = depth
    for (const child of node.children ?? []) stack.push([child, depth + 1])
  }
  return deepest
}
