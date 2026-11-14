/** A command as a row shows it: the command a shell wrapper carried, and the wrapper it came in. */
export interface UnwrappedCommand {
  command: string
  /** The wrapper as written without its directory: `zsh -lc`. Absent when the command is shown as reported. */
  shell?: string
}

const WRAPPER = /^(?:(?:\/[\w.+-]+)*\/)?(sh|bash|zsh)[ \t]+(-l?c)[ \t]+/u
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
 * The command inside `sh|bash|zsh -c|-lc <one word>`, the three shapes agents wrap a command in. Any other shape (more
 * arguments, another flag, an expansion in the word, an empty command) is returned as it was reported: a row never
 * shows a command Latch had to guess. Display only: what ran is the reported command, which stays one step away.
 */
export function unwrapShell(reported: string): UnwrappedCommand {
  const wrapper = WRAPPER.exec(reported)
  if (!wrapper) return { command: reported }
  const command = singleWord(reported.slice(wrapper[0].length).trimEnd())
  if (command === undefined || command.trim() === '') return { command: reported }
  return { command, shell: `${wrapper[1]} ${wrapper[2]}` }
}

/**
 * The home directory a session's folders lie in, read off their own paths: `/Users/<name>` or `/home/<name>`. The Host
 * reports no home, so nothing is assumed when the folders do not agree or lie elsewhere (a shared folder, a volume).
 */
export function homeOf(folders: readonly (string | undefined)[]): string | undefined {
  let home: string | undefined
  for (const folder of folders) {
    if (!folder) continue
    const found = /^\/(?:Users|home)\/[^/]+(?=\/|$)/u.exec(folder)?.[0]
    if (!found || /^\/Users\/(?:Shared|Guest)$/u.test(found) || (home !== undefined && home !== found)) return undefined
    home = found
  }
  return home
}

/** `home` written `~` where a path begins with it; display only, and never inside another name (`/Users/annabel`). */
export function tildeHome(text: string, home: string | undefined): string {
  if (!home) return text
  let out = ''
  let from = 0
  for (;;) {
    const at = text.indexOf(home, from)
    if (at < 0) return out + text.slice(from)
    const before = text[at - 1]
    const after = text[at + home.length]
    const starts = before === undefined || /[\s'"=:(<>|;&,]/u.test(before)
    const ends = after === undefined || /[/\s'":)<>|;&,]/u.test(after)
    out += text.slice(from, at) + (starts && ends ? '~' : home)
    from = at + home.length
  }
}
