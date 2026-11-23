import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { TextCursorInput } from 'lucide-react'
import type { CatalogueRead, HarnessInfo } from '@latch/protocol'
import {
  Button,
  Tooltip,
  Icon,
  IconButton,
  MenuFooterLink,
  TextField,
  useLayerClose,
  useLayerOpen,
  AlertGlyph,
  ChevronLeftGlyph,
  RefreshGlyph,
  CloseGlyph,
} from '@latch/ui'
import { api, errorMessage, inlineError } from '../core/api.ts'
import { saveOfferedPreset } from '../core/offeredHarness.ts'
import type { DeviceAccess } from '../core/permissions.ts'
import { harnessName } from '../composerChoice.ts'
import { VisibleText } from '../components/VisibleText.tsx'
import { defineCopy } from '../core/i18n.ts'
import { useStableCallback } from '../hooks/useStableCallback.ts'

const COPY = defineCopy(
  {
    readFailed: '没有读到。',
    readAgain: '重新读取',
    refresh: '刷新模型列表',
    readLevels: '读取思考档位',
    retryLevels: '重新读取思考档位',
    readList: (value1: string) => `读取 ${value1} 的模型列表`,
    readingPrefix: '正在读取 ',
    readingSuffix: ' 的模型列表…',
    notSignedIn: '还没登录',
    failedPrefix: '没有读到：',
    readRisk: (value1: string) => `读取会启动 ${value1}，可能加载你的扩展或插件、运行会话钩子`,
    enterMenu: '填写模型 ID…',
    back: '返回',
    enterTitle: '填写模型 ID',
    modelId: '模型 ID',
    example: '例如 provider/model-name',
    sendUntouched: (value1: string) => `开始时原样发给 ${value1}`,
    addUse: '添加并选用',
    entered: '已填写的模型 ID',
    remove: (value1: string) => `移除 ${value1}`,
  },
  {
    readFailed: 'Could not read the list.',
    readAgain: 'Read again',
    refresh: 'Refresh model list',
    readLevels: 'Read thinking levels',
    retryLevels: 'Retry reading thinking levels',
    readList: (value1: string) => `Read model list from ${value1}`,
    readingPrefix: 'Reading ',
    readingSuffix: '’s model list…',
    notSignedIn: 'Signed out',
    failedPrefix: 'Could not read: ',
    readRisk: (value1: string) => `Reading starts ${value1} and may load your extensions or plugins and run session hooks.`,
    enterMenu: 'Enter model ID…',
    back: 'Back',
    enterTitle: 'Enter model ID',
    modelId: 'Model ID',
    example: 'For example, provider/model-name',
    sendUntouched: (value1: string) => `Sent as entered to ${value1} when the session starts`,
    addUse: 'Add and use',
    entered: 'Entered model IDs',
    remove: (value1: string) => `Remove ${value1}`,
  },
)

/**
 * Harnesses this page is asking to read by selection. Once the read ends, the Host's last read says whether another is
 * due: none for the same definition, one for a changed definition, as opening 权限 then says.
 */
const selected = new Set<string>()
/** Reads this page started and is waiting on, so every control says so before the Host's next catalog does. */
const waiting = new Map<string, Map<string | undefined, Promise<CatalogueRead | undefined>>>()
/** A failed transport or model read has no Host last-read entry. Closing the phone sheet must not silently try it again. */
const failures = new Map<string, { observation: string; offered: boolean; cause: unknown }>()
const failureKey = (harness: HarnessInfo, model?: string) => JSON.stringify([harness.id, model])
const observation = (harness: HarnessInfo) =>
  JSON.stringify([harness.commandCatalogue?.generation, harness.bound?.id, harness.catalogue?.reportedAt, harness.catalogueRead?.last?.at])
function failedRead(harness: HarnessInfo, model?: string) {
  const failed = failures.get(failureKey(harness, model))
  if (failed && (failed.observation === observation(harness) || (failed.offered && !harness.catalogue && !harness.catalogueRead?.last)))
    return failed
  return undefined
}
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

/**
 * Reads what the Harness offers without a turn; the catalog the Host sends next carries it, or why it failed. `model`:
 * only what it offers for that model of its list, such as thinking.
 */
export function readHarnessCatalogue(harness: HarnessInfo, auto: boolean, model?: string): Promise<CatalogueRead | undefined> {
  const requests = waiting.get(harness.id) ?? new Map<string | undefined, Promise<CatalogueRead | undefined>>()
  const key = model && modelReadKey(harness, model)
  const pending = requests.get(key)
  if (pending) return pending
  const failed = failureKey(harness, model)
  failures.delete(failed)
  const read = async () => {
    // Saving an offered preset can publish the definition before this read starts. Both steps share the same flight.
    if (harness.offer) await saveOfferedPreset(harness.offer.presetId)
    const answer = await api<{ ran: boolean; catalogueRead?: CatalogueRead }>(`agents/${encodeURIComponent(harness.id)}/catalogue`, {
      method: 'POST',
      body: { auto, ...(model !== undefined ? { model } : {}) },
    })
    if (model !== undefined && answer.ran) noteModelRead(modelReadKey(harness, model), 'read')
    return answer.catalogueRead
  }
  const request = read()
    .catch((cause: unknown) => {
      failures.set(failed, { observation: observation(harness), offered: !!harness.offer, cause })
      if (failures.size > 256) failures.delete(failures.keys().next().value!)
      throw cause
    })
    .finally(() => {
      requests.delete(key)
      if (!requests.size) waiting.delete(harness.id)
      changed()
    })
  requests.set(key, request)
  waiting.set(harness.id, requests)
  changed()
  return request
}

/**
 * The last read was refused for want of a login, by the Harness's own error code, and nothing newer says otherwise: no
 * running process of it reports a login, and no session has started with its lists since.
 */
export function readNeedsLogin(harness: Pick<HarnessInfo, 'catalogueRead' | 'catalogue' | 'login'> | undefined): boolean {
  const last = harness?.catalogueRead?.last
  if (!harness || !last || last.ok || !last.loginRequired) return false
  if (harness.login?.reported?.status === 'authenticated') return false
  const reportedAt = harness.catalogue?.reportedAt
  return !(reportedAt !== undefined && Date.parse(reportedAt) > Date.parse(last.at))
}

/** Whether choosing this Harness in a draft reads its lists by itself: once, while nothing is known of it. */
export function readsOnSelect(harness: HarnessInfo | undefined, access: Pick<DeviceAccess, 'scopes'>): harness is HarnessInfo {
  const read = harness?.catalogueRead
  return (
    harness !== undefined
    // Selecting an offered preset alone does not save it. Opening its model panel or starting its first session does.
    && harness.offer === undefined
    && access.scopes.has('run')
    && harness.status === 'ready'
    && read?.when === 'select'
    && !read.running
    && !read.last
    && !harness.catalogue
    && !selected.has(harness.id)
    && !failedRead(harness)
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

/** A deliberate visit to a draft's model panel asks for missing choices for this definition, never a timed refresh. */
export function panelCatalogueTarget(
  harness: HarnessInfo,
  access: Pick<DeviceAccess, 'scopes' | 'local' | 'admin'>,
  unknownModel?: string,
): { model?: string } | undefined {
  const read = harness.catalogueRead
  if (!access.scopes.has('run') || harness.status !== 'ready' || read?.running) return undefined
  if (harness.offer) return access.local && access.admin && !failedRead(harness) ? {} : undefined
  if (!read) return undefined
  if (!harness.catalogue && !read.last && !failedRead(harness)) return {}
  if (
    unknownModel
    && readsModel(harness, access)
    && modelsAsked.get(modelReadKey(harness, unknownModel)) !== 'read'
    && !failedRead(harness, unknownModel)
  )
    return { model: unknownModel }
  return undefined
}

/**
 * The model menu's rows about where the list comes from: when it was read and by what, reading it now, a read that
 * failed with the Harness's reason, reading it again, and typing an ID it does not list. A preset on offer is read once
 * its definition is saved, which this Mac confirms first: nothing runs a program this Mac has not confirmed.
 */
export function CatalogueRows({
  harness,
  access,
  hasModels,
  ownModels = true,
  disabled,
  unknownModel,
  onTypeModel,
  onRead,
}: {
  harness: HarnessInfo
  access: Pick<DeviceAccess, 'scopes' | 'local' | 'admin'>
  /** The draft is on the Harness's own models, so its login is what the draft depends on. */
  ownModels?: boolean
  disabled: boolean
  unknownModel?: string | undefined
  /** It reported a model option, so a typed ID has something to be set as. */
  hasModels: boolean
  onTypeModel: () => void
  onRead?: (() => void | Promise<void>) | undefined
}) {
  const open = useLayerOpen()
  const attempted = useRef(new Set<string>())
  const name = harnessName(harness)
  const read = harness.catalogueRead
  const ready = !disabled && access.scopes.has('run') && harness.status === 'ready' && (!harness.offer || (access.local && access.admin))
  const canRun = ready && harness.offer === undefined
  const running = useReading(harness)
  const catalogue = harness.catalogue
  const keyFor = (model?: string) => (model === undefined ? harness.id : modelReadKey(harness, model))
  const currentFailure = () => (unknownModel === undefined ? undefined : failedRead(harness, unknownModel)) ?? failedRead(harness)
  const failure = useSyncExternalStore(subscribe, currentFailure, currentFailure)
  const modelFailed = failure && unknownModel !== undefined && failure === failedRead(harness, unknownModel)
  const error = failure ? inlineError(failure.cause) : ''
  const run = useStableCallback(async (model?: string) => {
    if (!ready || running) return
    try {
      await readHarnessCatalogue(harness, false, model)
    } catch {
      // The read retains its error for every opener, including a sheet that has since closed.
    }
    await onRead?.()
  })
  const target = ready && !running ? panelCatalogueTarget(harness, access, unknownModel) : undefined
  const targetKey = target && keyFor(target.model)
  const targetModel = target?.model
  const listKey = keyFor()
  useEffect(() => {
    // A saved list (or a recorded refusal) rearms a future definition whose old evidence the Host discards.
    if (catalogue || read?.last) attempted.current.delete(listKey)
    if (!open || targetKey === undefined || attempted.current.has(targetKey)) return
    attempted.current.add(targetKey)
    void run(targetModel)
  }, [open, targetKey, targetModel, read?.last, catalogue, listKey, run])
  const failed = error || (read?.last && !read.last.ok ? (read.last.message ?? COPY.readFailed) : '')
  const needsLogin = !error && readNeedsLogin(harness)
  const label = (failure || failed) && !modelFailed ? COPY.readAgain : catalogue ? COPY.refresh : COPY.readList(name)
  return (
    <>
      {running && (
        <p className="model-note">
          {COPY.readingPrefix}
          {name}
          {COPY.readingSuffix}
        </p>
      )}
      {/* A missing login is a state, said above the composer with the way to log in; on a service's model it is not in the way. */}
      {!running && needsLogin && ownModels && (
        <p className="model-note" data-tone="warn">
          <Icon icon={AlertGlyph} size={12} />
          {COPY.notSignedIn}
        </p>
      )}
      {!running && failed && !needsLogin && (
        <p className="model-note" data-tone="error">
          {COPY.failedPrefix}
          <VisibleText text={failed} />
        </p>
      )}
      {((read && canRun) || (harness.offer && ready)) && !running && (
        <Tooltip content={read?.when === 'request' && !catalogue ? COPY.readRisk(name) : undefined}>
          <MenuFooterLink
            icon={RefreshGlyph}
            chevron={false}
            onClick={() => {
              void run()
            }}>
            {label}
          </MenuFooterLink>
        </Tooltip>
      )}
      {hasModels && canRun && (
        <MenuFooterLink icon={TextCursorInput} chevron={false} onClick={onTypeModel}>
          {COPY.enterMenu}
        </MenuFooterLink>
      )}
      {unknownModel && !running && readsModel(harness, access) && !disabled && (
        <MenuFooterLink icon={RefreshGlyph} chevron={false} onClick={() => void run(unknownModel)}>
          {modelFailed ? COPY.retryLevels : COPY.readLevels}
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
        <IconButton size="xs" icon={ChevronLeftGlyph} label={COPY.back} onClick={onBack} />
        <span>{COPY.enterTitle}</span>
      </header>
      {/* Not a form: the composer around it is one, and its submit would reach the composer too. */}
      <div className="typed-models-form">
        <TextField
          label={COPY.modelId}
          value={value}
          placeholder={COPY.example}
          autoComplete="off"
          spellCheck={false}
          maxLength={256}
          {...(error ? { error } : {})}
          hint={COPY.sendUntouched(name)}
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
          {COPY.addUse}
        </Button>
      </div>
      {typed.length > 0 && (
        <ul className="typed-models-list" aria-label={COPY.entered}>
          {typed.map(model => (
            <li key={model}>
              <VisibleText text={model} />
              <IconButton
                size="xs"
                icon={CloseGlyph}
                label={COPY.remove(model)}
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

/** Models a draft here asked the Host about, by Harness: each once, as the Host reads each once. */
const modelsAsked = new Map<string, 'asked' | 'read'>()

function noteModelRead(key: string, state: 'asked' | 'read'): void {
  modelsAsked.set(key, state)
  if (modelsAsked.size > 256) modelsAsked.delete(modelsAsked.keys().next().value!)
}

function modelReadKey(harness: HarnessInfo, model: string): string {
  return JSON.stringify([harness.id, harness.commandCatalogue?.generation, harness.catalogue?.reportedAt, model])
}

/**
 * Whether a draft that picked a model nothing is known of can read what that model offers, such as thinking: in the
 * empty session a read opens, with no turn. `select` Harnesses read it by themselves; the others only when asked.
 */
export function readsModel(harness: HarnessInfo | undefined, access: Pick<DeviceAccess, 'scopes'>): harness is HarnessInfo {
  const read = harness?.catalogueRead
  return (
    harness !== undefined
    && harness.offer === undefined
    && access.scopes.has('run')
    && harness.status === 'ready'
    && harness.catalogue !== undefined
    && read !== undefined
    && !read.running
    && read.modes === true
  )
}

/** The read a draft's model pick starts on a `select` Harness, once per model. */
export function readModelOnSelect(harness: HarnessInfo, model: string): void {
  const key = modelReadKey(harness, model)
  if (modelsAsked.has(key)) return
  noteModelRead(key, 'asked')
  void readHarnessCatalogue(harness, true, model).catch(() => {})
}
