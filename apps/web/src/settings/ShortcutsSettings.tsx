import { useEffect, useState } from 'react'
import { Button, Hint, IconButton, Kbd, SearchField, StatusWord, UndoGlyph } from '@latch/ui'
import { DEFAULT_SHORTCUTS, formatChord, parseChord, refusalText, shortcutRefusal, type ShortcutAction } from '@latch/protocol'
import { currentShell } from '../core/shell.ts'
import { clientKind, shortcutBindings, useShortcutBindings, type Bindings } from '../core/shortcutBindings.ts'
import { capsText, isRebindable, shortcutCaps, shortcutRows } from '../workbenchShortcuts.ts'
import { SettingsGroup, SettingsRow } from './common.tsx'

/** A shortcut's keys as quiet text: alternatives apart with 「或」, the ends of a range with 「…」. */
export function ShortcutCaps({ keys }: { keys: string }) {
  return (
    <span className="shortcut-caps" data-keys={keys}>
      {shortcutCaps(keys).map(({ join, caps }) => (
        <span key={caps.join(' ')} className="shortcut-alternative">
          {join && <span className="shortcut-or">{join}</span>}
          <Kbd>{capsText(caps)}</Kbd>
        </span>
      ))}
    </span>
  )
}

const MODIFIER_CODES = /^(?:Meta|Control|Alt|Shift|OS|Fn|CapsLock)(?:Left|Right)?$/u

/** The chord a key press is, written as the document writes it; a lone modifier is not one yet. */
export function recordedChord(event: Pick<KeyboardEvent, 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>): string | null {
  if (MODIFIER_CODES.test(event.code)) return null
  return formatChord({ mod: event.metaKey || event.ctrlKey, alt: event.altKey, shift: event.shiftKey, code: event.code })
}

/** What a new chord for `action` does to the bindings: the default drops out, since absent is the default. */
export function rebound(bindings: Bindings, action: ShortcutAction, chord: string | null): Bindings {
  const next = { ...bindings }
  if (chord === null || chord === DEFAULT_SHORTCUTS[action][clientKind()]) delete next[action]
  else next[action] = chord
  return next
}

/**
 * The shortcuts of this kind of client, and no other's. The page's name heads the section; the search stands under it.
 * Where the Host keeps bindings, each action that may move takes new keys here: press them, Esc leaves them as they
 * were. A refusal names what already has them.
 */
export function ShortcutsSettings({
  spaces = true,
  delegate = true,
  editable = false,
}: {
  spaces?: boolean
  delegate?: boolean
  /** The Host keeps this device's bindings (`catalog.features.shortcuts`). */
  editable?: boolean
}) {
  const view = useShortcutBindings()
  const [query, setQuery] = useState('')
  const [recording, setRecording] = useState<ShortcutAction | null>(null)
  const [refusal, setRefusal] = useState<{ action: ShortcutAction; text: string } | null>(null)
  const desktop = currentShell() !== null
  const bindings = shortcutBindings.bindings()
  const needle = query.trim().toLocaleLowerCase()
  const rows = shortcutRows(desktop, undefined, { spaces, delegate }).filter(row =>
    `${row.label} ${row.keys}`.toLocaleLowerCase().includes(needle),
  )
  const busy = view.pending !== undefined

  const save = async (action: ShortcutAction, next: Bindings) => {
    const result = Object.keys(next).length ? await shortcutBindings.apply(next) : await shortcutBindings.reset()
    if (result.kind === 'refused') setRefusal({ action, text: result.text })
  }

  useEffect(() => {
    if (!recording) return undefined
    const action = recording
    // Capturing first, so neither the workbench nor the page's own keys act on what is being recorded.
    const listener = (event: KeyboardEvent) => {
      if (event.isComposing) return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (event.code === 'Escape' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        setRecording(null)
        setRefusal(null)
        return
      }
      const chord = recordedChord(event)
      if (chord === null) return
      const refused = parseChord(chord) ? shortcutRefusal(clientKind(), bindings, action, chord) : { kind: 'invalid' as const }
      if (refused) {
        setRefusal({ action, text: refusalText(refused) })
        return
      }
      setRecording(null)
      setRefusal(null)
      if ((bindings[action] ?? DEFAULT_SHORTCUTS[action][clientKind()]) !== chord) void save(action, rebound(bindings, action, chord))
    }
    window.addEventListener('keydown', listener, true)
    return () => window.removeEventListener('keydown', listener, true)
  }, [recording, bindings])

  return (
    <>
      <SearchField className="shortcuts-search" label="搜索快捷键" value={query} onValueChange={setQuery} />
      <SettingsGroup>
        {rows.map(row => {
          const action = isRebindable(row.id) ? row.id : null
          const own = action !== null && bindings[action] !== undefined
          const here = action !== null && recording === action
          const refused = action !== null && refusal?.action === action ? refusal.text : undefined
          const trailing =
            !editable || action === null ? (
              <span className="shortcut-trailing">
                <ShortcutCaps keys={row.keys} />
                {editable && (
                  <Hint className="shortcut-fixed" label="固定">
                    范围、终端窗格、允许请求、撤销归档与输入框里的按键不能改
                  </Hint>
                )}
              </span>
            ) : (
              <span className="shortcut-trailing">
                {here ? (
                  <span className="shortcut-recording" role="status">
                    按下新的组合键 <Kbd>{desktop ? 'esc' : 'Esc'}</Kbd>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="shortcut-edit"
                    disabled={busy}
                    aria-label={`改「${row.label}」的快捷键`}
                    onClick={() => {
                      setRefusal(null)
                      setRecording(action)
                    }}>
                    <ShortcutCaps keys={row.keys} />
                  </button>
                )}
                {own && !here && (
                  <IconButton
                    size="xs"
                    icon={UndoGlyph}
                    label={`「${row.label}」恢复默认`}
                    disabled={busy}
                    onClick={() => void save(action, rebound(bindings, action, null))}
                  />
                )}
              </span>
            )
          return (
            <SettingsRow
              key={row.id}
              className="shortcut-row"
              title={row.label}
              {...(refused ? { description: <span className="shortcut-refusal">{refused}</span> } : {})}
              trailing={trailing}
            />
          )
        })}
        {!rows.length && <SettingsRow title="没有匹配的快捷键" dim />}
      </SettingsGroup>
      {editable && view.pending?.unknown && (
        <div className="shortcut-unknown" data-lock="">
          <StatusWord tone="warn">结果未知</StatusWord>
          <span className="shortcut-unknown-text">{view.pending.unknown.text}</span>
          <Button variant="ghost" onClick={() => shortcutBindings.abandon()}>
            放弃等待
          </Button>
          {view.pending.unknown.retryable && <Button onClick={() => void shortcutBindings.retry()}>重试</Button>}
        </div>
      )}
      {editable && Object.keys(bindings).length > 0 && !view.pending?.unknown && (
        <div className="shortcut-reset-all">
          <Button variant="ghost" disabled={busy} onClick={() => void shortcutBindings.reset()}>
            全部恢复默认
          </Button>
        </div>
      )}
    </>
  )
}
