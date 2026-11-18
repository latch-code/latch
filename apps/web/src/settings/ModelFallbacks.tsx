import { useState } from 'react'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { MAX_MODEL_FALLBACKS, type ModelFallback, type ProviderKind, type ProviderSettings } from '@latch/protocol'
import { Button, Dialog, Hint, IconButton, InlineNotice, ValuePicker, TrashGlyph, type PickerGroup } from '@latch/ui'
import { ProviderTile } from '../components/BrandTile.tsx'
import { SettingsRow } from './common.tsx'
import { defineCopy, formatNumber, plural } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    title: '出错时改用',
    beforeReply: '只在回复开始前',
    detail: '按顺序改发给下一个，每次都写进记录。Latch 内置从下一轮起用；其他 Harness 从新开的会话起用。',
    cancel: '取消',
    save: '保存',
    empty: '还没有',
    missing: '已不在',
    moveUp: '上移',
    moveDown: '下移',
    remove: '移除',
    add: '添加模型',
    addEllipsis: '添加模型…',
    noOthers: '没有其他已保存的模型',
    moveUpFor: (label: string) => `上移 ${label}`,
    moveDownFor: (label: string) => `下移 ${label}`,
    removeFor: (label: string) => `移除 ${label}`,
    limit: (count: number) => `最多 ${formatNumber(count)} 个`,
  },
  {
    title: 'Fallback models',
    beforeReply: 'Before a reply starts',
    detail:
      'Latch tries the next model in order and records each switch. The built-in Harness uses this from the next turn. Other Harnesses use it in new sessions.',
    cancel: 'Cancel',
    save: 'Save',
    empty: 'None yet',
    missing: 'No longer available',
    moveUp: 'Move up',
    moveDown: 'Move down',
    remove: 'Remove',
    add: 'Add model',
    addEllipsis: 'Add model…',
    noOthers: 'No other saved models',
    moveUpFor: (label: string) => `Move ${label} up`,
    moveDownFor: (label: string) => `Move ${label} down`,
    removeFor: (label: string) => `Remove ${label}`,
    limit: (count: number) => `Up to ${plural(count, { one: '{n} model', other: '{n} models' })}`,
  },
)

const keyOf = (item: ModelFallback) => `${item.providerId}\u0000${item.model}`
const same = (a: readonly ModelFallback[], b: readonly ModelFallback[]) =>
  a.length === b.length && a.every((item, index) => keyOf(item) === keyOf(b[index]!))

/** 「服务 · 模型」 of one entry; a service that is gone keeps its ID so the entry can still be told apart and removed. */
export function fallbackLabel(item: ModelFallback, providers: readonly Pick<ProviderSettings, 'id' | 'name'>[]): string {
  return `${providers.find(provider => provider.id === item.providerId)?.name ?? item.providerId} · ${item.model}`
}

/**
 * 「出错时改用」 of one model: other saved models in the order they are tried, moved with the arrows. Nothing applies
 * until 保存, and the Host checks every entry again.
 */
export function ModelFallbacksDialog({
  open,
  provider,
  model,
  providers,
  onSubmit,
  onClose,
}: {
  open: boolean
  provider: ProviderSettings & { kind: ProviderKind }
  model: string
  /** Every saved service, this one among them: its other models may be chosen too. */
  /** The services a model may fall back to: only ones Latch can use. */
  providers: readonly (ProviderSettings & { kind: ProviderKind })[]
  /** Saves the whole list; returns the error, '' when it was saved. */
  onSubmit: (fallbacks: ModelFallback[]) => Promise<string>
  onClose: () => void
}) {
  const saved = provider.fallbacks?.[model] ?? []
  const [list, setList] = useState<ModelFallback[]>(saved)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // Each opening starts from what is saved.
  const [wasOpen, setWasOpen] = useState(open)
  if (wasOpen !== open) {
    setWasOpen(open)
    if (open) {
      setList(saved)
      setError('')
    }
  }
  const taken = new Set([keyOf({ providerId: provider.id, model }), ...list.map(keyOf)])
  const groups: Array<PickerGroup<string>> = providers
    .map(service => ({
      id: service.id,
      label: service.name,
      media: <ProviderTile provider={service} size={16} />,
      options: service.models
        .map(name => ({ providerId: service.id, model: name }))
        .filter(item => !taken.has(keyOf(item)))
        .map(item => ({ value: keyOf(item), label: item.model })),
    }))
    .filter(group => group.options.length > 0)
  const full = list.length >= MAX_MODEL_FALLBACKS
  const move = (from: number, to: number) => {
    setList(current => {
      const next = [...current]
      const [item] = next.splice(from, 1)
      next.splice(to, 0, item!)
      return next
    })
  }
  const save = async () => {
    setBusy(true)
    setError('')
    const failure = await onSubmit(list)
    setBusy(false)
    if (failure) setError(failure)
    else onClose()
  }
  return (
    <Dialog
      open={open}
      size="lg"
      title={COPY.title}
      subtitle={<code className="settings-mono">{model}</code>}
      note={<Hint label={COPY.beforeReply}>{COPY.detail}</Hint>}
      onClose={() => {
        if (!busy) onClose()
      }}
      footer={
        <>
          <Button size="md" disabled={busy} onClick={onClose}>
            {COPY.cancel}
          </Button>
          <Button
            size="md"
            variant="primary"
            disabled={same(list, saved)}
            loading={busy}
            onClick={() => {
              void save()
            }}>
            {COPY.save}
          </Button>
        </>
      }>
      <div className="settings-form model-fallbacks">
        {list.length === 0 ? (
          <p className="model-fallbacks-empty">{COPY.empty}</p>
        ) : (
          <ol className="model-fallbacks-list">
            {list.map((item, index) => {
              const service = providers.find(candidate => candidate.id === item.providerId)
              const gone = !service?.models.includes(item.model)
              const label = fallbackLabel(item, providers)
              return (
                <li key={keyOf(item)}>
                  <SettingsRow
                    leading={<ProviderTile provider={service ?? { id: item.providerId }} size={20} />}
                    title={service?.name ?? item.providerId}
                    description={<code className="settings-mono">{item.model}</code>}
                    dim={gone}
                    trailing={
                      <>
                        {gone && <span className="service-status">{COPY.missing}</span>}
                        <IconButton
                          label={COPY.moveUpFor(label)}
                          tooltip={COPY.moveUp}
                          icon={ArrowUp}
                          disabled={busy || index === 0}
                          onClick={() => {
                            move(index, index - 1)
                          }}
                        />
                        <IconButton
                          label={COPY.moveDownFor(label)}
                          tooltip={COPY.moveDown}
                          icon={ArrowDown}
                          disabled={busy || index === list.length - 1}
                          onClick={() => {
                            move(index, index + 1)
                          }}
                        />
                        <IconButton
                          label={COPY.removeFor(label)}
                          tooltip={COPY.remove}
                          icon={TrashGlyph}
                          disabled={busy}
                          onClick={() => {
                            setList(current => current.filter((_, at) => at !== index))
                          }}
                        />
                      </>
                    }
                  />
                </li>
              )
            })}
          </ol>
        )}
        <ValuePicker
          label={COPY.add}
          placeholder={COPY.addEllipsis}
          value={undefined}
          groups={groups}
          searchable={groups.reduce((sum, group) => sum + group.options.length, 0) >= 8}
          width="sm"
          disabled={busy || full || groups.length === 0}
          disabledReason={full ? COPY.limit(MAX_MODEL_FALLBACKS) : groups.length === 0 ? COPY.noOthers : undefined}
          onValueChange={key => {
            const [providerId = '', name = ''] = key.split('\u0000')
            setList(current => (current.length >= MAX_MODEL_FALLBACKS ? current : [...current, { providerId, model: name }]))
          }}
        />
        {error && <InlineNotice tone="error">{error}</InlineNotice>}
      </div>
    </Dialog>
  )
}
