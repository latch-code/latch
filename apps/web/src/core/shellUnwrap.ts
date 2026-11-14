/** A command as a row shows it: the command a shell wrapper carried, and the wrapper it came in. */
export interface UnwrappedCommand {
  command: string
  /** The wrapper exactly as reported, directory and all: `/bin/zsh -lc`. Absent when the command is shown as reported. */
  shell?: string
}

/**
 * A system shell by its bare name or in one of the directories systems keep it in, written exactly so: any other path
 * (a project's own `bash`, one reached through `..`, a relative one) is some other program and is shown as reported.
 */
const WRAPPER = /^((?:\/bin\/|\/usr\/bin\/|\/usr\/local\/bin\/|\/opt\/homebrew\/bin\/)?(?:sh|bash|zsh))[ \t]+(-l?c)[ \t]+/u
/** Characters an unquoted shell word carries literally; anything else could be expanded, split or end the word. */
const BARE = /[\w@%+=:,./!-]/u
/** The characters a backslash escapes inside double quotes (POSIX); before any other it stays a backslash. */
const DOUBLE_ESCAPES = '\\"$`'

/**
 * The one shell word `text` consists of, with its quoting undone; undefined when it is not exactly one word, or when
 * the shell would have expanded part of it (`$`, a backtick), so its literal reading is not what ran.
 */
function singleWord(text: string): string | undefined {
  let out = ''
  let index = 0
  while (index < text.length) {
    const char = text[index]!
    if (char === "'") {
      const end = text.indexOf("'", index + 1)
      if (end < 0) return undefined
      out += text.slice(index + 1, end)
      index = end + 1
    } else if (char === '"') {
      index++
      for (;;) {
        const inner = text[index]
        if (inner === undefined || inner === '$' || inner === '`') return undefined
        index++
        if (inner === '"') break
        if (inner !== '\\') out += inner
        else {
          const next = text[index]
          if (next === undefined) return undefined
          index++
          // A backslash before a newline joins the lines.
          if (next !== '\n') out += DOUBLE_ESCAPES.includes(next) ? next : `\\${next}`
        }
      }
    } else if (char === '\\') {
      const next = text[index + 1]
      if (next === undefined || next === '\n') return undefined
      out += next
      index += 2
    } else if (BARE.test(char)) {
      out += char
      index++
    } else return undefined
  }
  return out
}

/**
 * The command inside `sh|bash|zsh -c|-lc <one word>`, the three shapes agents wrap a command in. Any other shape (a
 * shell at another path, more arguments, another flag, an expansion in the word, an empty command) is returned as it was
 * reported: a row never
 * shows a command Latch had to guess. Display only: what ran is the reported command, which stays one step away.
 */
export function unwrapShell(reported: string): UnwrappedCommand {
  const wrapper = WRAPPER.exec(reported)
  if (!wrapper) return { command: reported }
  const command = singleWord(reported.slice(wrapper[0].length).trimEnd())
  if (command === undefined || command.trim() === '') return { command: reported }
  return { command, shell: `${wrapper[1]} ${wrapper[2]}` }
}
