import { useEffect, useState, useSyncExternalStore } from 'react'
import { Button, ChoiceList, Dialog } from '@latch/ui'
import { shellEditors, type EditorList, type FileActionResult } from '../core/shell.ts'

/**
 * 在编辑器中打开, in the desktop app's own window only: the editors main found, the one the person chose (in 设置 or the
 * first time they open a file), and the chooser that asks once. Main finds, remembers and starts the editor; the page
 * only names one from main's list.
 */
type View = Pick<EditorList, 'editors' | 'chosen'>

let view: View | undefined
let loading: Promise<View | undefined> | undefined
let asking: { resolve(id: string | null): void } | undefined
const listeners = new Set<() => void>()
const changed = () => {
  for (const listener of listeners) listener()
}
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function accept(answer: Awaited<ReturnType<NonNullable<ReturnType<typeof shellEditors>>['list']>>): View | undefined {
  if (answer.status !== 'ok') return view
  view = { editors: answer.editors, chosen: answer.chosen }
  changed()
  return view
}

/** Reads main's list once (again with `fresh`); undefined outside the desktop app's own window. */
export function loadEditors(fresh = false): Promise<View | undefined> {
  const shell = shellEditors()
  if (!shell) return Promise.resolve(undefined)
  if (!fresh && view) return Promise.resolve(view)
  if (!fresh && loading) return loading
  loading = shell
    .list()
    .then(accept)
    .catch(() => view)
    .finally(() => {
      loading = undefined
    })
  return loading
}

export async function chooseEditor(id: string): Promise<View | undefined> {
  const shell = shellEditors()
  if (!shell) return undefined
  return accept(await shell.choose(id).catch(() => ({ status: 'failed' as const, code: 'shell-failed' })))
}

/** The editors and the choice; undefined while unknown and outside the desktop app's own window. */
export function useEditors(): View | undefined {
  const current = useSyncExternalStore(
    subscribe,
    () => view,
    () => undefined,
  )
  useEffect(() => {
    void loadEditors()
  }, [])
  return current
}

/** What a file's menu calls the action: the chosen editor by name, or a question when none is chosen yet. */
export function editorLabel(current: View | undefined): string | undefined {
  if (!current || current.editors.length === 0) return undefined
  const chosen = current.editors.find(editor => editor.id === current.chosen)
  return chosen ? `在 ${chosen.name} 中打开` : '在编辑器中打开…'
}

/**
 * Opens the file in the chosen editor, asking for one first when none is chosen. `canceled` when the person closed the
 * chooser.
 */
export async function openInEditor(
  context: string | { workspaceId: string; harnessId: string },
  target: string | { handle: string },
  line?: number,
): Promise<FileActionResult | { status: 'canceled' }> {
  const shell = shellEditors()
  if (!shell) return { status: 'failed', code: 'unsupported' }
  const current = await loadEditors()
  if (!current?.editors.length) return { status: 'refused', code: 'no-editor' }
  if (!current.editors.some(editor => editor.id === current.chosen)) {
    const picked = await new Promise<string | null>(resolve => {
      asking?.resolve(null)
      asking = { resolve }
      changed()
    })
    if (!picked) return { status: 'canceled' }
  }
  return shell.open(context, target, line).catch((): FileActionResult => ({ status: 'failed', code: 'shell-failed' }))
}

/** The one-time question 「用哪个编辑器打开？」, mounted once by the app. */
export function EditorChooser() {
  const current = useSyncExternalStore(
    subscribe,
    () => view,
    () => undefined,
  )
  const open = useSyncExternalStore(
    subscribe,
    () => asking !== undefined,
    () => false,
  )
  const [picked, setPicked] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const finish = (id: string | null) => {
    const pending = asking
    asking = undefined
    setPicked(undefined)
    setFailed(false)
    changed()
    pending?.resolve(id)
  }
  const options = (current?.editors ?? []).map(editor => ({ value: editor.id, title: editor.name }))
  const confirm = async () => {
    const id = picked ?? options[0]?.value
    if (!id) return
    setBusy(true)
    const next = await chooseEditor(id)
    setBusy(false)
    if (next?.chosen === id) finish(id)
    else setFailed(true)
  }
  return (
    <Dialog
      open={open}
      title="用哪个编辑器打开？"
      subtitle="之后可在 设置 › 通用 中更换"
      onClose={() => {
        if (!busy) finish(null)
      }}
      note={failed ? <span role="alert">没有保存，请重试</span> : undefined}
      footer={
        <>
          <Button size="md" disabled={busy} onClick={() => finish(null)}>
            取消
          </Button>
          <Button
            size="md"
            variant="primary"
            loading={busy}
            disabled={options.length === 0}
            onClick={() => {
              void confirm()
            }}>
            打开
          </Button>
        </>
      }>
      <ChoiceList label="编辑器" value={picked ?? options[0]?.value} options={options} onValueChange={setPicked} autoFocus />
    </Dialog>
  )
}
