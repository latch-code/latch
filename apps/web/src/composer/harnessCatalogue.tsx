import { useState, useSyncExternalStore } from 'react'
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

const COPY = defineCopy(
  {
    readFailed: '没有读到。',
    readAgain: '重新读取',
    refresh: '刷新模型列表',
    readList: (value1: string) => `读取 ${value1} 的模型列表`,
    readingPrefix: '正在读取 ',
    readingSuffix: ' 的模型列表…',
    notSignedIn: '还没登录',
    failedPrefix: '没有读到：',
    readRisk: (value1: string) => `读取要启动 ${value1}，会加载你的扩展或插件、运行会话钩子，所以点了才读`,
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
    readList: (value1: string) => `Read model list from ${value1}`,
    readingPrefix: 'Reading ',
    readingSuffix: '’s model list…',
    notSignedIn: 'Signed out',
    failedPrefix: 'Could not read: ',
    readRisk: (value1: string) =>
      `Reading starts ${value1} and loads your extensions or plugins and runs session hooks. It happens when you ask to read.`,
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

/**
 * Reads what the Harness offers without a turn; the catalog the Host sends next carries it, or why it failed. `model`:
 * only what it offers for that model of its list, such as thinking.
 */
export async function readHarnessCatalogue(harness: HarnessInfo, auto: boolean, model?: string): Promise<CatalogueRead | undefined> {
  waiting.add(harness.id)
  changed()
  try {
    const answer = await api<{ catalogueRead?: CatalogueRead }>(`agents/${encodeURIComponent(harness.id)}/catalogue`, {
      method: 'POST',
      body: { auto, ...(model !== undefined ? { model } : {}) },
    })
    return answer.catalogueRead
  } finally {
    waiting.delete(harness.id)
    changed()
  }
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
    // A preset without a definition yet is read once its first session saves one: saving it takes Touch ID.
    && harness.offer === undefined
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
 * failed with the Harness's reason, reading it again, and typing an ID it does not list. A preset on offer is read once
 * its definition is saved, which this Mac confirms first: nothing runs a program this Mac has not confirmed.
 */
export function CatalogueRows({
  harness,
  access,
  hasModels,
  ownModels = true,
  onTypeModel,
  onRead,
}: {
  harness: HarnessInfo
  access: Pick<DeviceAccess, 'scopes'>
  /** The draft is on the Harness's own models, so its login is what the draft depends on. */
  ownModels?: boolean
  /** It reported a model option, so a typed ID has something to be set as. */
  hasModels: boolean
  onTypeModel: () => void
  onRead?: (() => void | Promise<void>) | undefined
}) {
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const name = harnessName(harness)
  const read = harness.catalogueRead
  const ready = access.scopes.has('run') && harness.status === 'ready'
  const canRun = ready && harness.offer === undefined
  const running = useReading(harness)
  const catalogue = harness.catalogue
  const run = async () => {
    if (running || saving) return
    setError('')
    try {
      if (harness.offer) {
        setSaving(true)
        try {
          await saveOfferedPreset(harness.offer.presetId)
        } finally {
          setSaving(false)
        }
      }
      await readHarnessCatalogue(harness, false)
      await onRead?.()
    } catch (cause) {
      // A confirmation that did not go through says so on its own card.
      setError(inlineError(cause))
      await onRead?.()
    }
  }
  const failed = error || (read?.last && !read.last.ok ? (read.last.message ?? COPY.readFailed) : '')
  const needsLogin = !error && readNeedsLogin(harness)
  const label = failed ? COPY.readAgain : catalogue ? COPY.refresh : COPY.readList(name)
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
        // Why a read waits for the press is the row's tooltip: it starts the Harness, which loads the person's own code.
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
const modelsAsked = new Set<string>()

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
  const key = `${harness.id}\n${harness.catalogue?.reportedAt ?? ''}\n${model}`
  if (modelsAsked.has(key)) return
  modelsAsked.add(key)
  if (modelsAsked.size > 256) modelsAsked.delete(modelsAsked.values().next().value!)
  void readHarnessCatalogue(harness, true, model).catch(() => {})
}
