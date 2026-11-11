import { useState, useSyncExternalStore } from 'react'
import { ChevronLeft, RefreshCw, TextCursorInput, X } from 'lucide-react'
import { AGENT_PRESETS, type HarnessInfo } from '@latch/protocol'
import { Button, IconButton, MenuFooterLink, TextField, useLayerClose } from '@latch/ui'
import { api, ApiError, errorMessage } from '../core/api.ts'
import type { DeviceAccess } from '../core/permissions.ts'
import { harnessName } from '../composerChoice.ts'
import { dateTime } from '../format.ts'
import { VisibleText } from '../components/VisibleText.tsx'

/**
 * Harnesses this page is asking to read by selection. Once the read ends, the Host's last read says whether another is
 * due: none for the same definition, one for a changed definition, as opening 权限 then says.
 */
const selected = new Set<string>()
/** Reads this page started and is waiting on, so every control says so before the Host's next catalog does. */
const waiting = new Set<string>()
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

/** Whether a read of this Harness is running, here or on the Host. */
export function useReading(harness: HarnessInfo | undefined): boolean {
  const read = () => (harness ? waiting.has(harness.id) : false)
  const here = useSyncExternalStore(subscribe, read, read)
  return here || harness?.catalogueRead?.running === true
}

/** A preset chosen before it has a definition gets one, as its first session would save it; saving runs nothing. */
async function saveOffered(harness: HarnessInfo): Promise<void> {
  const preset = AGENT_PRESETS.find(item => item.id === harness.offer?.presetId)
  if (!preset) return
  try {
    await api('agents', {
      method: 'POST',
      body: { id: preset.id, name: preset.name, presetId: preset.id, command: preset.command, args: preset.args, env: {}, enabled: true },
    })
  } catch (cause) {
    if (!(cause instanceof ApiError && cause.code === 'agent-exists')) throw cause
  }
}

/** Reads what the Harness offers without a turn; the catalog the Host sends next carries it, or why it failed. */
export async function readHarnessCatalogue(harness: HarnessInfo, auto: boolean): Promise<void> {
  waiting.add(harness.id)
  changed()
  try {
    await saveOffered(harness)
    await api(`agents/${encodeURIComponent(harness.id)}/catalogue`, { method: 'POST', body: { auto } })
  } finally {
    waiting.delete(harness.id)
    changed()
  }
}

/** Whether choosing this Harness in a draft reads its lists by itself: once, while nothing is known of it. */
export function readsOnSelect(harness: HarnessInfo | undefined, access: Pick<DeviceAccess, 'scopes'>): harness is HarnessInfo {
  const read = harness?.catalogueRead
  return (
    harness !== undefined
    && access.scopes.has('run')
    && harness.status === 'ready'
    && read?.when === 'select'
    && !read.running
    && !read.last
    && !harness.catalogue
    && !selected.has(harness.id)
  )
}

/** Whether opening a draft's 权限 reads too: only where the read reports the modes it offers. */
export function readsOnPermission(harness: HarnessInfo | undefined, access: Pick<DeviceAccess, 'scopes'>): harness is HarnessInfo {
  return readsOnSelect(harness, access) && harness.catalogueRead?.modes === true
}

/** The read a selection starts. Its failure is the Host's to keep and show; nothing here waits for it. */
export function readOnSelect(harness: HarnessInfo, onDone?: () => void | Promise<void>): void {
  selected.add(harness.id)
  void readHarnessCatalogue(harness, true)
    .catch(() => {})
    .finally(() => {
      selected.delete(harness.id)
      void onDone?.()
    })
}

/**
 * The model menu's rows about where the list comes from: when it was read and by what, reading it now, a read that
 * failed with the Harness's reason, and typing an ID it does not list.
 */
export function CatalogueRows({
  harness,
  access,
  hasModels,
  onTypeModel,
  onRead,
}: {
  harness: HarnessInfo
  access: Pick<DeviceAccess, 'scopes'>
  /** It reported a model option, so a typed ID has something to be set as. */
  hasModels: boolean
  onTypeModel: () => void
  onRead?: (() => void | Promise<void>) | undefined
}) {
  const [error, setError] = useState('')
  const name = harnessName(harness)
  const read = harness.catalogueRead
  const canRun = access.scopes.has('run') && harness.status === 'ready'
  const running = useReading(harness)
  const catalogue = harness.catalogue
  const run = async () => {
    if (running) return
    setError('')
    try {
      await readHarnessCatalogue(harness, false)
      await onRead?.()
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }
  const failed = error || (read?.last && !read.last.ok ? (read.last.message ?? '没有读到。') : '')
  return (
    <>
      {catalogue && (
        <p className="model-note">
          {catalogue.source === 'session' ? `来自上次会话 · ${dateTime(catalogue.reportedAt)}` : `读取于 ${dateTime(catalogue.reportedAt)}`}
        </p>
      )}
      {running && <p className="model-note">正在读取 {name} 的模型列表…</p>}
      {!running && failed && (
        <p className="model-note" data-tone="error">
          没有读到：
          <VisibleText text={failed} />
        </p>
      )}
      {read && canRun && !running && (
        <MenuFooterLink
          icon={RefreshCw}
          chevron={false}
          onClick={() => {
            void run()
          }}>
          {catalogue || failed ? '重新读取' : `读取 ${name} 的模型列表`}
        </MenuFooterLink>
      )}
      {hasModels && canRun && (
        <MenuFooterLink icon={TextCursorInput} chevron={false} onClick={onTypeModel}>
          填写模型 ID…
        </MenuFooterLink>
      )}
    </>
  )
}

/** Model IDs a person types for a Harness, each sent as it is; the panel lists them to remove one. */
export function TypedModelsPanel({
  harness,
  onBack,
  onChoose,
  onSaved,
}: {
  harness: HarnessInfo
  onBack: () => void
  onChoose: (model: string) => void
  /** Brings the Host's list here, so the new ID can be chosen from it. */
  onSaved?: (() => void | Promise<void>) | undefined
}) {
  const close = useLayerClose()
  const [value, setValue] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const typed = harness.customModels ?? []
  const name = harnessName(harness)
  const save = async (models: string[]): Promise<boolean> => {
    setBusy(true)
    setError('')
    try {
      await api(`agents/${encodeURIComponent(harness.id)}/models`, { method: 'PUT', body: { models } })
      await onSaved?.()
      return true
    } catch (cause) {
      setError(errorMessage(cause))
      return false
    } finally {
      setBusy(false)
    }
  }
  const add = async () => {
    const model = value.trim()
    if (!model || busy) return
    if (await save([...typed.filter(item => item !== model), model])) {
      setValue('')
      onChoose(model)
      close()
    }
  }
  return (
    <div className="permission-list typed-models">
      <header className="permission-list-head">
        <IconButton size="xs" icon={ChevronLeft} label="返回" onClick={onBack} />
        <span>填写模型 ID</span>
      </header>
      {/* Not a form: the composer around it is one, and its submit would reach the composer too. */}
      <div className="typed-models-form">
        <TextField
          label="模型 ID"
          value={value}
          placeholder="例如 provider/model-name"
          autoComplete="off"
          spellCheck={false}
          maxLength={256}
          {...(error ? { error } : {})}
          hint={`开始时原样发给 ${name}`}
          onChange={event => {
            setValue(event.target.value)
          }}
          onKeyDown={event => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
            event.preventDefault()
            event.stopPropagation()
            void add()
          }}
        />
        <Button
          size="sm"
          variant="primary"
          disabled={!value.trim() || busy}
          onClick={() => {
            void add()
          }}>
          添加并选用
        </Button>
      </div>
      {typed.length > 0 && (
        <ul className="typed-models-list" aria-label="已填写的模型 ID">
          {typed.map(model => (
            <li key={model}>
              <VisibleText text={model} />
              <IconButton
                size="xs"
                icon={X}
                label={`移除 ${model}`}
                disabled={busy}
                onClick={() => {
                  void save(typed.filter(item => item !== model))
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
