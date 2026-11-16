import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AnsiText, ShellLine } from '../src/conversation/CommandText.tsx'
import { VisibleText } from '../src/components/VisibleText.tsx'
import { hasAnsi, parseAnsi, stripAnsi } from '../src/conversation/ansi.ts'
import { shellTokens } from '../src/conversation/shellTokens.ts'
import { commandFolder } from '../src/conversation/commandView.ts'
import { unwrapShell } from '../src/core/shellUnwrap.ts'
import { DIAGRAM_THEMES, mermaidThemeVariables } from '../src/preview/diagramTheme.ts'

const ESC = '\u001b'
const roles = (line: string) => shellTokens(line).map(token => `${token.role}:${token.text}`)

describe('a command line in parts', () => {
  it('joins back to the line exactly, whatever it holds', () => {
    for (const line of [
      "pwd; rg --files -g 'AGENTS.md' -g '!node_modules' /Users/me/work 2>/dev/null | head -50",
      'FOO=1 pnpm exec vitest run "tests/a b.test.ts" && echo $HOME # done',
      'echo "unterminated',
      "printf '%s\\n' a\\ b",
      '',
    ])
      expect(
        shellTokens(line)
          .map(token => token.text)
          .join(''),
      ).toBe(line)
  })

  it('names the program after each operator, flags, quoted strings, paths and redirect targets', () => {
    expect(roles("pwd; rg --files -g 'AGENTS.md' /Users/me 2>/dev/null | head -50")).toEqual([
      'command:pwd',
      'operator:;',
      'plain: ',
      'command:rg',
      'plain: ',
      'flag:--files',
      'plain: ',
      'flag:-g',
      'plain: ',
      "string:'AGENTS.md'",
      'plain: ',
      'path:/Users/me',
      'plain: ',
      'operator:2>',
      'path:/dev/null',
      'plain: ',
      'operator:|',
      'plain: ',
      'command:head',
      'plain: ',
      'flag:-50',
    ])
    expect(roles('FOO=1 cat src/app.ts $HOME # why')).toEqual([
      'variable:FOO=1',
      'plain: ',
      'command:cat',
      'plain: ',
      'path:src/app.ts',
      'plain: ',
      'variable:$HOME',
      'plain: ',
      'comment:# why',
    ])
  })

  it('shows the owner’s wrapped command as the command it carried, quoting undone', () => {
    const meant = "pwd; rg --files -g 'AGENTS.md' -g '!node_modules' /Users/me/work 2>/dev/null | head -50"
    for (const reported of [`/bin/zsh -lc "${meant}"`, `/bin/zsh -lc '${meant.replaceAll("'", `'"'"'`)}'`])
      expect(unwrapShell(reported), reported).toEqual({ command: meant, shell: '/bin/zsh -lc' })
    expect(unwrapShell(`bash -lc 'git status --short'`)).toEqual({ command: 'git status --short', shell: 'bash -lc' })
  })
})

describe('terminal colours in output', () => {
  it('keeps the basic colours, bold and dim, and resets', () => {
    expect(parseAnsi(`${ESC}[32m✓${ESC}[39m passes ${ESC}[1;31mFAIL${ESC}[0m end`)).toEqual([
      { text: '✓', colour: 'green' },
      { text: ' passes ' },
      { text: 'FAIL', colour: 'red', bold: true },
      { text: ' end' },
    ])
    expect(parseAnsi(`${ESC}[2mdim${ESC}[22m ${ESC}[90mgrey${ESC}[m`)).toEqual([
      { text: 'dim', dim: true },
      { text: ' ' },
      { text: 'grey', colour: 'grey' },
    ])
  })

  it('drops cursor moves, window titles, links and colours the palette has no role for, and keeps every character', () => {
    const text = `${ESC}]0;title${ESC}\\${ESC}[2K${ESC}[1Ga${ESC}[38;2;255;0;0mb${ESC}[38;5;2mc${ESC}[38;5;200md${ESC}[48;5;1me${ESC}]8;;https://x.test${ESC}\\f${ESC}]8;;${ESC}\\`
    expect(stripAnsi(text)).toBe('abcdef')
    expect(
      parseAnsi(text)
        .map(segment => segment.text)
        .join(''),
    ).toBe('abcdef')
    expect(parseAnsi(text).find(segment => segment.text.includes('c'))?.colour).toBe('green')
    expect(parseAnsi(text).find(segment => segment.text.includes('d'))?.colour).toBeUndefined()
  })

  it('drops a character-set switch and a saved cursor, which `tput sgr0` and progress bars write', () => {
    expect(stripAnsi(`${ESC}[1mbold${ESC}(B${ESC}[m and ${ESC}7saved${ESC}8`)).toBe('bold and saved')
    expect(parseAnsi(`${ESC}[31mred${ESC}(B${ESC}[m`)).toEqual([{ text: 'red', colour: 'red' }])
  })

  it('never splits hidden characters with a colour: a line or an output that holds any is one marked run', () => {
    const hidden = 'echo a\u202Eb --flag'
    expect(renderToStaticMarkup(createElement(ShellLine, { command: hidden }))).toBe(
      renderToStaticMarkup(createElement(VisibleText, { text: hidden })),
    )
    const output = `${ESC}[32mok\u200B${ESC}[39m done`
    expect(renderToStaticMarkup(createElement(AnsiText, { text: output }))).toBe(
      renderToStaticMarkup(createElement(VisibleText, { text: 'ok\u200B done' })),
    )
    // Without hidden characters the parts are coloured.
    expect(renderToStaticMarkup(createElement(ShellLine, { command: 'git status' }))).toContain('<span class="sh-command">git</span>')
    expect(renderToStaticMarkup(createElement(AnsiText, { text: `${ESC}[31mx${ESC}[0m` }))).toContain('class="ansi-red"')
  })

  it('shows what a carriage return overwrote last, as a terminal does', () => {
    expect(stripAnsi('progress 10%\rprogress 100%\r\nnext')).toBe('progress 100%\nnext')
    expect(hasAnsi('plain')).toBe(false)
    expect(stripAnsi('plain')).toBe('plain')
  })
})

describe('the folder a command ran in', () => {
  it('says nothing when it ran in the project, and the shortest honest form otherwise', () => {
    const roots = ['/Users/me/Latch/workspace/20261113-5699']
    expect(commandFolder('/Users/me/Latch/workspace/20261113-5699', roots)).toBeUndefined()
    expect(commandFolder('/Users/me/Latch/workspace/20261113-5699/', roots)).toBeUndefined()
    expect(commandFolder(undefined, roots)).toBeUndefined()
    expect(commandFolder('/Users/me/Latch/workspace/20261113-5699/apps/web', roots)).toBe('apps/web')
    expect(commandFolder('/Users/me/Desktop', roots)).toBe('/Users/me/Desktop')
    expect(commandFolder('/Users/me/a/very/deep/folder/that/goes/on', roots)).toBe('…/folder/that/goes/on')
  })
})

describe('a diagram in the page’s theme', () => {
  const tokens = readFileSync('packages/ui/src/tokens.css', 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '')
  const block = (selector: string) => {
    const start = tokens.indexOf(`${selector} {`)
    const body = tokens.slice(tokens.indexOf('{', start) + 1, tokens.indexOf('}', start))
    return new Map([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/gu)].map(match => [match[1], match[2]!.trim()]))
  }
  it('takes its surfaces and inks from the tokens, light and dark', () => {
    const light = block(':root')
    const dark = new Map([...light, ...block(":root[data-theme='dark']")])
    for (const [theme, values] of [
      ['light', light],
      ['dark', dark],
    ] as const) {
      const colours = DIAGRAM_THEMES[theme]
      expect([colours.background, colours.node, colours.group, colours.ink, colours.edge], theme).toEqual(
        (theme === 'light' ? ['--canvas', '--sunken', '--canvas'] : ['--canvas', '--card', '--sunken'])
          .concat(['--ink', '--muted'])
          .map(name => values.get(name)),
      )
    }
    expect(mermaidThemeVariables('dark')).toMatchObject({ darkMode: true, primaryTextColor: '#ececef', lineColor: '#a3a3ad' })
  })
})
