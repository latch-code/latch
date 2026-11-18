import { useEffect, useMemo, useState } from 'react'
import {
  DEFAULT_CUSTOMIZATION,
  accentAt,
  allowedAccentHues,
  customizationIssues,
  isDefaultCustomization,
  type Appearance,
  type AppearanceRadius,
  type AppearanceTextSize,
  type CustomizationDocument,
  type CustomizationRevision,
} from '@latch/protocol'
import { Button, SegmentedControl, StatusWord } from '@latch/ui'
import { CustomizationRecovery } from '../components/CustomizationRecovery.tsx'
import { customization } from '../core/customBoot.ts'
import { readCustomization, useCustomizationStatus, type CustomizationActions, type CustomizationChange } from '../core/customization.ts'
import { dateTime } from '../format.ts'
import { SettingsGroup, SettingsRow } from './common.tsx'
import { defineCopy, formatNumber, useLocale } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    cyan: '青',
    lake: '湖蓝',
    sky: '天蓝',
    indigo: '靛',
    purple: '紫',
    magenta: '洋红',
    apply: '应用',
    restore: '回退',
    reset: '恢复默认',
    accent: '主色',
    default: '默认',
    customize: '自定义',
    allDevices: '所有设备',
    changedElsewhere: '外观已在别处修改，放弃草稿后重新编辑。',
    corners: '圆角',
    sharp: '方',
    round: '圆',
    textSize: '字号',
    small: '小',
    large: '大',
    preview: '预览中',
    discard: '放弃',
    current: '当前',
    hue: (value: number) => `色相 ${formatNumber(value)}`,
    cliSuffix: ' · 命令行',
  },
  {
    cyan: 'Cyan',
    lake: 'Lake blue',
    sky: 'Sky blue',
    indigo: 'Indigo',
    purple: 'Purple',
    magenta: 'Magenta',
    apply: 'Apply',
    restore: 'Restore',
    reset: 'Reset to defaults',
    accent: 'Accent',
    default: 'Default',
    customize: 'Customize',
    allDevices: 'All devices',
    changedElsewhere: 'Appearance changed elsewhere. Discard your draft and edit again.',
    corners: 'Corners',
    sharp: 'Square',
    round: 'Rounded',
    textSize: 'Text size',
    small: 'Small',
    large: 'Large',
    preview: 'Previewing',
    discard: 'Discard',
    current: 'Current',
    hue: (value: number) => `Hue ${formatNumber(value)}`,
    cliSuffix: ' · Command line',
  },
)

/** The hues offered for 主色, round the wheel; the ones a rule refuses (too near amber, red or green) are left out. */
const HUE_CHOICES = [195, 215, 240, 285, 305, 325]
const HUE_NAMES: Partial<Record<number, 'cyan' | 'lake' | 'sky' | 'indigo' | 'purple' | 'magenta'>> = {
  195: 'cyan',
  215: 'lake',
  240: 'sky',
  285: 'indigo',
  305: 'purple',
  325: 'magenta',
}

/** The document a set of choices makes: a default choice is left out, so the default is the empty appearance. */
export function documentOf(appearance: Appearance): CustomizationDocument {
  const kept: Appearance = {}
  if (appearance.accentHue !== undefined) kept.accentHue = appearance.accentHue
  if (appearance.radius && appearance.radius !== 'default') kept.radius = appearance.radius
  if (appearance.textSize && appearance.textSize !== 'default') kept.textSize = appearance.textSize
  return { schema: 1, appearance: kept }
}

const sameDocument = (a: CustomizationDocument, b: CustomizationDocument) =>
  JSON.stringify(documentOf(a.appearance)) === JSON.stringify(documentOf(b.appearance))

function HueChoice({
  value,
  disabled,
  onValueChange,
}: {
  value: number | undefined
  disabled: boolean
  onValueChange: (hue: number | undefined) => void
}) {
  const hues = useMemo(() => {
    const allowed = new Set(allowedAccentHues())
    const offered = HUE_CHOICES.filter(hue => allowed.has(hue))
    // A hue applied from elsewhere that is not among the offered ones still shows as the chosen one.
    return value !== undefined && !offered.includes(value) ? [...offered, value] : offered
  }, [value])
  const options: Array<number | undefined> = [undefined, ...hues]
  return (
    <div
      className="custom-hues"
      role="radiogroup"
      aria-label={COPY.accent}
      onKeyDown={event => {
        const step =
          event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
        if (step === 0 || disabled) return
        event.preventDefault()
        const next = options[(options.indexOf(value) + step + options.length) % options.length]
        onValueChange(next)
        event.currentTarget.querySelector<HTMLButtonElement>(`[data-hue="${next ?? 'default'}"]`)?.focus()
      }}>
      {options.map(hue => {
        const [r, g, b] = hue === undefined ? [0, 0, 0] : accentAt('light', hue).accent
        const label = hue === undefined ? 'default' : HUE_NAMES[hue]
        const words = label ? COPY[label] : COPY.hue(hue!)
        return (
          <button
            key={hue ?? 'default'}
            type="button"
            role="radio"
            className="custom-hue"
            data-hue={hue ?? 'default'}
            data-default={hue === undefined ? '' : undefined}
            aria-checked={value === hue}
            aria-label={words}
            title={words}
            aria-disabled={disabled || undefined}
            tabIndex={value === hue ? 0 : -1}
            // The swatch is the colour the document would give, computed by the same expansion.
            style={hue === undefined ? undefined : { backgroundColor: `rgb(${r}, ${g}, ${b})` }}
            onClick={() => {
              if (!disabled) onValueChange(hue)
            }}
          />
        )
      })}
    </div>
  )
}

/**
 * 设置 › 通用 › 自定义: the Host's 外观, the same on every device that connects to it. A choice shows on this page at once
 * and is saved only by 应用; 放弃, leaving the section or reloading puts the Host's back. Each saved revision can be
 * returned to, and 恢复默认 writes the default as a new one. Only a device with 管理此 Host sees the section.
 */
export function CustomizationSettings({
  admin,
  writer,
  onChanged,
}: {
  admin: boolean
  writer: CustomizationActions
  onChanged: () => void
}) {
  useLocale()
  if (admin) return <EditableCustomizationSettings writer={writer} onChanged={onChanged} />
  return (
    <SettingsGroup title={COPY.customize} meta={COPY.allDevices}>
      <div className="custom-foot" data-secure="">
        <CustomizationRecovery writer={writer} admin={false} onDone={onChanged} size="sm" />
      </div>
    </SettingsGroup>
  )
}

function EditableCustomizationSettings({ writer, onChanged }: { writer: CustomizationActions; onChanged: () => void }) {
  const status = useCustomizationStatus()
  const host = status.host ?? { revision: 0, doc: DEFAULT_CUSTOMIZATION }
  const [draft, setDraft] = useState<{ doc: CustomizationDocument; baseRevision: number } | null>(null)
  const [revisions, setRevisions] = useState<CustomizationRevision[]>([])
  const [error, setError] = useState('')
  const safe = status.safe !== null
  const shown = (draft?.doc ?? host.doc).appearance
  const draftDoc = draft?.doc ?? null
  const changed = draftDoc !== null && !sameDocument(draftDoc, host.doc)
  const issue = draftDoc ? customizationIssues(draftDoc)[0] : undefined

  useEffect(() => {
    const controller = new AbortController()
    readCustomization(controller.signal).then(
      view => {
        setRevisions(view.revisions)
      },
      () => {},
    )
    return () => {
      controller.abort()
    }
  }, [host.revision])
  // Leaving the section puts the Host's document back: a preview is never left on the page.
  useEffect(
    () => () => {
      customization().setPreview(null)
    },
    [],
  )

  const choose = (change: Partial<Appearance>) => {
    const doc = documentOf({ ...shown, ...change })
    const preview = sameDocument(doc, host.doc) ? null : doc
    setDraft(preview ? { doc: preview, baseRevision: draft?.baseRevision ?? host.revision } : null)
    customization().setPreview(preview)
  }
  const discard = () => {
    setError('')
    setDraft(null)
    customization().setPreview(null)
  }
  const finish = () => {
    discard()
    onChanged()
  }
  const run = async (change: CustomizationChange, baseRevision = host.revision) => {
    setError('')
    const outcome = await writer.submit(change, baseRevision)
    if (outcome.kind === 'done') finish()
    if (outcome.kind === 'conflict') onChanged()
    if (outcome.kind === 'conflict') setError(change.kind === 'apply' ? COPY.changedElsewhere : outcome.text)
    if (outcome.kind === 'refused') setError(outcome.text)
  }
  const disabled = safe || writer.pending !== undefined

  return (
    <SettingsGroup title={COPY.customize} meta={COPY.allDevices}>
      <SettingsRow
        title={COPY.accent}
        trailing={<HueChoice value={shown.accentHue} disabled={disabled} onValueChange={accentHue => choose({ accentHue })} />}
      />
      <SettingsRow
        title={COPY.corners}
        trailing={
          <SegmentedControl<AppearanceRadius>
            label={COPY.corners}
            value={shown.radius ?? 'default'}
            disabled={disabled}
            options={[
              { value: 'sharp', label: COPY.sharp },
              { value: 'default', label: COPY.default },
              { value: 'round', label: COPY.round },
            ]}
            onValueChange={radius => choose({ radius })}
          />
        }
      />
      <SettingsRow
        title={COPY.textSize}
        trailing={
          <SegmentedControl<AppearanceTextSize>
            label={COPY.textSize}
            value={shown.textSize ?? 'default'}
            disabled={disabled}
            options={[
              { value: 'small', label: COPY.small },
              { value: 'default', label: COPY.default },
              { value: 'large', label: COPY.large },
            ]}
            onValueChange={textSize => choose({ textSize })}
          />
        }
      />
      {/* 恢复默认 and 应用 are drawn as a security surface: no customisation changes how the way back looks. */}
      <div className="custom-foot" data-secure="">
        {writer.pending ? (
          <CustomizationRecovery writer={writer} admin onDone={finish} size="sm" />
        ) : (
          <>
            {issue ? (
              <StatusWord tone="failed">{issue.message}</StatusWord>
            ) : error ? (
              <StatusWord tone="failed">{error}</StatusWord>
            ) : changed ? (
              <StatusWord tone="neutral">{COPY.preview}</StatusWord>
            ) : null}
            {changed && (
              <Button size="sm" variant="ghost" onClick={discard}>
                {COPY.discard}
              </Button>
            )}
            <Button
              size="sm"
              variant="secondary"
              disabled={disabled || (isDefaultCustomization(host.doc) && !changed)}
              onClick={() => {
                void run({ kind: 'reset' })
              }}>
              {COPY.reset}
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={disabled || !changed || issue !== undefined}
              onClick={() => {
                if (draft) void run({ kind: 'apply', doc: draft.doc }, draft.baseRevision)
              }}>
              {COPY.apply}
            </Button>
          </>
        )}
      </div>
      {revisions.map(item => (
        <SettingsRow
          key={item.revision}
          title={`${COPY[item.source]}${item.by === 'cli' ? COPY.cliSuffix : ''}`}
          description={
            <time className="custom-history-when" dateTime={item.at}>
              {dateTime(item.at)}
            </time>
          }
          trailing={
            item.revision === host.revision ? (
              <StatusWord tone="neutral">{COPY.current}</StatusWord>
            ) : (
              <Button
                size="xs"
                disabled={disabled}
                onClick={() => {
                  void run({ kind: 'restore', revision: item.revision })
                }}>
                {COPY.restore}
              </Button>
            )
          }
        />
      ))}
    </SettingsGroup>
  )
}
