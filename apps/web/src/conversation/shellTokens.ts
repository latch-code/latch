/** What a part of a command line is, for its colour: the program, a flag, a quoted string, a path, a variable, an operator. */
type ShellRole = 'command' | 'flag' | 'string' | 'path' | 'variable' | 'operator' | 'comment' | 'plain'
export interface ShellToken {
  text: string
  role: ShellRole
}

/** What joins, pipes or redirects commands; after any but a redirect the next word is a program again. */
const OPERATOR = /^(?:\|\||&&|;;|\d?>>?|&>|<<?|\|&?|;|&|\(|\)|\$\(|`)/u
const REDIRECT = /^(?:\d?>>?|&>|<<?)$/u
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u
const PATHLIKE = /^(?:~|\.{1,2})?\/|^\.{1,2}$|^~$|\/|^[\w@.-]+\.[A-Za-z0-9]{1,8}(?::\d+)?$/u

/** The end of the word starting at `from`: quotes are part of the word, whitespace and operators end it. */
function wordEnd(line: string, from: number): number {
  let index = from
  while (index < line.length) {
    const char = line[index]
    if (/\s/u.test(char)) break
    if (index > from && OPERATOR.test(line.slice(index)) && !/^\d/u.test(line.slice(index))) break
    if (char === '\\') {
      index += 2
      continue
    }
    if (char === "'" || char === '"') {
      const end = line.indexOf(char, index + 1)
      index = end < 0 ? line.length : end + 1
      continue
    }
    index++
  }
  return Math.min(index, line.length)
}

function wordRole(word: string, expectsCommand: boolean): ShellRole {
  if (/^['"]/u.test(word)) return 'string'
  if (word.startsWith('$')) return 'variable'
  if (expectsCommand) return 'command'
  if (/^--?[A-Za-z0-9]/u.test(word)) return 'flag'
  if (PATHLIKE.test(word)) return 'path'
  return 'plain'
}

/**
 * A command line in parts for display. The parts' texts joined are the line exactly, so colour never changes what is
 * read or copied; anything the scanner does not understand is plain.
 */
export function shellTokens(line: string): ShellToken[] {
  const tokens: ShellToken[] = []
  const push = (text: string, role: ShellRole) => {
    const last = tokens.at(-1)
    if (last && last.role === role && role === 'plain') last.text += text
    else tokens.push({ text, role })
  }
  let index = 0
  let expectsCommand = true
  let afterRedirect = false
  while (index < line.length) {
    const rest = line.slice(index)
    const space = /^\s+/u.exec(rest)?.[0]
    if (space) {
      push(space, 'plain')
      if (space.includes('\n')) expectsCommand = true
      index += space.length
      continue
    }
    if (rest.startsWith('#') && (index === 0 || /\s/u.test(line[index - 1] ?? ''))) {
      const end = line.indexOf('\n', index)
      const stop = end < 0 ? line.length : end
      push(line.slice(index, stop), 'comment')
      index = stop
      continue
    }
    const operator = OPERATOR.exec(rest)?.[0]
    if (operator && !(operator === '(' && !expectsCommand)) {
      push(operator, 'operator')
      index += operator.length
      afterRedirect = REDIRECT.test(operator)
      expectsCommand = !afterRedirect
      continue
    }
    const end = Math.max(wordEnd(line, index), index + 1)
    const word = line.slice(index, end)
    if (expectsCommand && ASSIGNMENT.test(word)) {
      push(word, 'variable')
    } else {
      push(word, afterRedirect && !/^['"$]/u.test(word) ? 'path' : wordRole(word, expectsCommand))
      expectsCommand = false
    }
    afterRedirect = false
    index = end
  }
  return tokens
}
