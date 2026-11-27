import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Cpu } from 'lucide-react'
import { createPluginPackageTemplate, type PluginPackageBundle, type PluginPackageDetail, type PluginPackageSummary } from '@latch/protocol'
import {
  Button,
  ConfirmDialog,
  Dialog,
  Hint,
  Icon,
  InlineNotice,
  StatusPill,
  Switch,
  Tabs,
  TextAreaField,
  TextField,
  DownloadGlyph,
  FileGlyph,
  InfoGlyph,
  LockGlyph,
  DevicesGlyph,
  ShieldGlyph,
} from '@latch/ui'
import { api, inlineError, isUncertain, newRequestId, type ApiOptions, MessageError } from '../core/api.ts'
import { withConfirmation } from '../core/confirmations.ts'
import { InlineConfirm } from '../components/InlineConfirm.tsx'
import { PLUGIN_REACH_COPY } from '../core/securityCopy.ts'
import { languageForPath } from '../preview/highlight-protocol.ts'
import { IconTile, NoteLine, SettingsGroup, SettingsRow } from './common.tsx'
import { PluginSourceField } from './PluginSourceField.tsx'
import {
  pluginEnabledBody,
  PluginMutationDialog,
  PluginWriteFeedback,
  reviewedPluginChange,
  reviewedPluginMutation,
  type PluginMutationTarget,
} from './PluginMutationReview.tsx'
import {
  addPluginSource,
  downloadPluginBundle,
  editPluginSource,
  manifestReach,
  needsPageBuild,
  pendingPluginChange,
  readPluginBundle,
  typedManifest,
  type PluginReach,
} from './pluginAssets.ts'
import { defineCopy } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    needsAttention: '需要处理',
    on: '已开启',
    off: '未开启',
    idChangeAdvanced: '插件标识不能在高级编辑中更改。',
    invalidPluginManifest: '插件声明格式无效。',
    fileTooLarge: '插件文件不能超过 8 MiB。',
    couldNotRead: '无法读取插件文件。',
    newPlugin: '新建插件',
    buildPreview: '构建并预览',
    appScope: '独立页面在隔离框里运行。首次应用或扩大页面能力时，在这台 Mac 上确认。',
    codePreview: '应用前不会运行编辑中的代码',
    delete: '删除',
    saveDraft: '保存草稿',
    apply: '保存并审阅',
    unsavedChanges: '未保存修改',
    notSaved: '未保存',
    turnOn: '启用插件',
    export: '导出',
    name: '插件名称',
    version: '版本',
    description: '说明',
    editor: '插件编辑方式',
    skillText: '技能正文',
    files: '文件',
    manifest: '高级声明',
    idChange: '插件标识不能更改。',
    badManifest: '声明格式无效。',
    pluginManifest: '插件声明',
    manifestDetails: '可组合技能、在 Mac 上运行的模块、React 面板和静态数据面板；执行入口使用 .mjs。',
    pluginFiles: '插件文件',
    instructions: '工作方法',
    noTextFiles: '没有文本文件',
    newFilePath: '新增文件路径',
    couldNotAdd: '无法添加文件。',
    addFile: '添加文件',
    idAndExecution: '插件标识与执行方式',
    pluginId: '插件标识',
    codeConfirmation: '含代码的插件要在这台 Mac 上确认',
    unknownKept: '结果尚未确认，编辑内容已保留。',
    retrySame: '重试同一请求',
    deleteTitle: '删除这个插件？',
    deleteDetails: '新的会话将不再使用它；正在运行的工作会保留已经取得的能力。',
    deletePlugin: '删除插件',
    unknown: '结果尚未确认。',
  },
  {
    needsAttention: 'Needs attention',
    on: 'On',
    off: 'Off',
    idChangeAdvanced: 'The plugin ID can’t be changed in the manifest.',
    invalidPluginManifest: 'The plugin manifest isn’t valid.',
    fileTooLarge: 'The plugin file must be 8 MiB or less.',
    couldNotRead: 'Couldn’t read the plugin file.',
    newPlugin: 'New plugin',
    buildPreview: 'Build and preview',
    appScope: 'Pages run in an isolated frame. Confirm on this Mac the first time you apply a page or expand its capabilities.',
    codePreview: 'Edited code runs only after you apply it',
    delete: 'Delete',
    saveDraft: 'Save draft',
    apply: 'Save and review',
    unsavedChanges: 'Unsaved changes',
    notSaved: 'Not saved',
    turnOn: 'Turn on plugin',
    export: 'Export',
    name: 'Plugin name',
    version: 'Version',
    description: 'Description',
    editor: 'How to edit the plugin',
    skillText: 'Skill text',
    files: 'Files',
    manifest: 'Manifest',
    idChange: 'The plugin ID can’t be changed.',
    badManifest: 'The manifest isn’t valid.',
    pluginManifest: 'Plugin manifest',
    manifestDetails: 'Combine skills, modules that run on the Mac, React panels and static data panels. Entry points use .mjs.',
    pluginFiles: 'Plugin files',
    instructions: 'Instructions',
    noTextFiles: 'No text files',
    newFilePath: 'New file path',
    couldNotAdd: 'Couldn’t add the file.',
    addFile: 'Add file',
    idAndExecution: 'Plugin ID and how it runs',
    pluginId: 'Plugin ID',
    codeConfirmation: 'Plugins with code are confirmed on this Mac',
    unknownKept: 'Result unknown. Your edits are kept.',
    retrySame: 'Retry same request',
    deleteTitle: 'Delete this plugin?',
    deleteDetails: 'New sessions won’t use it. Work already running keeps what it has loaded.',
    deletePlugin: 'Delete plugin',
    unknown: 'Result unknown.',
  },
)

interface PendingChange {
  path: string
  options: ApiOptions
  afterSave?: { operation: 'review' } | { operation: 'build'; requestId: string }
  previewId?: string
  reviewId?: string
  completedReview?: PluginMutationTarget
}
interface Editor {
  bundle: PluginPackageBundle
  record?: PluginPackageDetail
}
const route = (id: string) => 'plugin-packages/' + encodeURIComponent(id)
export const packageState = (record: PluginPackageSummary) =>
  record.unavailableReason ? COPY.needsAttention : (pendingPluginChange(record)?.status ?? (record.enabled ? COPY.on : COPY.off))

const REACH_ICONS = { page: DevicesGlyph, host: Cpu, text: FileGlyph } as const

/**
 * Where a plugin's parts run and which devices receive them: each part's glyph, its name and where it runs (with 不隔离
 * where it is code), the full sentence behind ⓘ.
 */
export function PluginReachGroup({ reach, onRetryRead }: { reach: PluginReach[]; onRetryRead?: () => void }) {
  if (reach.length === 0 && !onRetryRead) return null
  return (
    <SettingsGroup title={PLUGIN_REACH_COPY.title}>
      {reach.map(item => (
        <SettingsRow
          key={item.id}
          className="plugin-reach"
          leading={<IconTile icon={REACH_ICONS[item.id]} />}
          title={item.title}
          description={
            <Hint lead={<Icon icon={item.id === 'text' ? InfoGlyph : ShieldGlyph} size={12} />} label={item.label}>
              {item.body}
            </Hint>
          }
        />
      ))}
      {onRetryRead && (
        <SettingsRow
          title={PLUGIN_REACH_COPY.unread.title}
          description={PLUGIN_REACH_COPY.unread.body}
          trailing={<Button onClick={onRetryRead}>{PLUGIN_REACH_COPY.unread.retry}</Button>}
        />
      )}
    </SettingsGroup>
  )
}

/** Manages local plugin packages. Edits take effect when the exact saved revision is applied. */
export function usePluginAssets({
  canEdit,
  onChanged,
  onPreview,
  initialBundle,
}: {
  canEdit: boolean
  onChanged: () => void
  onPreview: (id: string) => void
  initialBundle?: PluginPackageBundle | undefined
}) {
  const bundleToReview = canEdit ? initialBundle : undefined
  const [records, setRecords] = useState<PluginPackageSummary[] | null>(null)
  const [editor, setEditor] = useState<Editor | null>(() => (bundleToReview ? { bundle: bundleToReview } : null))
  const [busy, setBusy] = useState(false)
  const [readingFile, setReadingFile] = useState(false)
  const [pending, setPending] = useState<PendingChange | null>(null)
  const [error, setError] = useState('')
  const [reviewErrorId, setReviewErrorId] = useState<string | undefined>()
  const [reviewTarget, setReviewTarget] = useState<PluginMutationTarget | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [tab, setTab] = useState<'content' | 'files' | 'manifest'>(() =>
    bundleToReview && !bundleToReview.manifest.skills?.length ? 'files' : 'content',
  )
  const [file, setFile] = useState(() => bundleToReview?.files[0]?.path ?? '')
  const [newFile, setNewFile] = useState('')
  const [dirty, setDirty] = useState(false)
  const [manifestText, setManifestText] = useState(() => (bundleToReview ? JSON.stringify(bundleToReview.manifest, null, 2) : ''))
  const input = useRef<HTMLInputElement>(null)
  const fileReadToken = useRef<symbol | null>(null)
  const alive = useRef(true)
  const reloading = useRef(false)
  const changed = useRef(onChanged)
  changed.current = onChanged
  async function load() {
    const value = await api<{ packages: PluginPackageSummary[] }>('plugin-packages')
    if (alive.current) setRecords(value.packages)
  }
  useLayoutEffect(() => {
    if (!canEdit) setReadingFile(false)
    return () => {
      fileReadToken.current = null
    }
  }, [canEdit])
  useEffect(() => {
    alive.current = canEdit
    if (!canEdit) {
      setRecords(null)
      setEditor(null)
      setPending(null)
      setReviewTarget(null)
      setError('')
      setDeleting(false)
    } else
      void load().catch(cause => {
        if (alive.current) setError(inlineError(cause))
      })
    return () => {
      alive.current = false
    }
  }, [canEdit])
  const open = (next: Editor) => {
    setEditor(next)
    setDirty(false)
    setNewFile('')
    setTab(next.bundle.manifest.skills?.length ? 'content' : 'files')
    setFile(next.bundle.files[0]?.path ?? '')
    setManifestText(JSON.stringify(next.bundle.manifest, null, 2))
    setError('')
  }
  const editBundle = (bundle: PluginPackageBundle) => {
    setEditor(current => (current ? { ...current, bundle } : null))
    setDirty(true)
  }
  const refresh = async () => {
    await load()
    changed.current()
  }
  // Preserve the full immutable body and requestId when the result is unknown.
  const perform = async (change: PendingChange) => {
    if (busy || (pending && pending !== change)) return
    setBusy(true)
    setError('')
    setReviewErrorId(change.reviewId)
    let current = change
    setPending(current)
    try {
      const send = (request: PendingChange) =>
        withConfirmation(confirmation =>
          api<{ package?: PluginPackageDetail; removed?: true }>(request.path, {
            ...request.options,
            ...(confirmation ? { confirmation } : {}),
          }),
        )
      let result = await send(current)
      // The switch on a plugin's page changes a package with no editor open, and must not open one.
      const shown = result.package
      if (shown && alive.current) {
        setEditor(current => (current ? { bundle: shown.bundle, record: shown } : null))
        setDirty(false)
        setManifestText(JSON.stringify(shown.bundle.manifest, null, 2))
      }
      if (current.afterSave?.operation === 'build' && shown) {
        current = {
          path: `${route(shown.id)}/build`,
          options: {
            method: 'POST',
            timeoutMs: 90_000,
            body: { requestId: current.afterSave.requestId, revision: shown.revision },
          },
          previewId: shown.id,
        }
        if (alive.current) setPending(current)
        result = await send(current)
      }
      if (alive.current) {
        setPending(null)
        if (current.reviewId) setReviewTarget(current.completedReview ?? null)
        if (result.removed) {
          setEditor(null)
          setDeleting(false)
        }
        await refresh()
        if (alive.current && current.afterSave?.operation === 'review' && shown) {
          setReviewTarget({ operation: 'apply', id: shown.id, name: shown.name, revision: shown.revision })
        }
        if (alive.current && current.previewId) {
          setEditor(null)
          onPreview(current.previewId)
        }
        return result.package
      }
    } catch (cause) {
      if (alive.current) {
        if (!isUncertain(cause)) setPending(null)
        setError(inlineError(cause))
      }
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  const save = (apply: boolean) => {
    if (!editor || pending || busy) return
    let bundle = editor.bundle
    if (tab === 'manifest') {
      try {
        bundle = readPluginBundle(JSON.stringify({ manifest: JSON.parse(manifestText), files: bundle.files }))
        if (bundle.manifest.id !== editor.bundle.manifest.id) throw new MessageError(COPY.idChangeAdvanced)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : COPY.invalidPluginManifest)
        return
      }
    }
    const record = editor.record
    void perform({
      path: record ? route(record.id) : 'plugin-packages',
      options: {
        method: record ? 'PUT' : 'POST',
        body: { requestId: newRequestId(), bundle: structuredClone(bundle), ...(record ? { baseRevision: record.revision } : {}) },
      },
      ...(apply
        ? { afterSave: needsPageBuild(bundle.manifest) ? { operation: 'build', requestId: newRequestId() } : { operation: 'review' } }
        : {}),
    })
  }
  const exportBundle = async (id: string) => {
    const result = await api<{ bundle: PluginPackageBundle }>(route(id) + '/export')
    if (!alive.current) return
    downloadPluginBundle(id, result.bundle)
  }
  const selectRecord = async (record: PluginPackageSummary) => {
    if (busy || pending) return
    setBusy(true)
    setError('')
    try {
      const value = await api<{ package: PluginPackageDetail }>(route(record.id))
      if (alive.current) open({ bundle: value.package.bundle, record: value.package })
    } catch (cause) {
      if (alive.current) setError(inlineError(cause))
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  const locked = busy || readingFile || pending !== null || reviewTarget !== null
  const review = (record: PluginPackageSummary, operation: PluginMutationTarget['operation'], revision: string) => {
    if (!canEdit || locked) return
    setError('')
    setReviewTarget({ id: record.id, name: record.name, operation, revision })
  }
  const setEnabled = (record: PluginPackageSummary, enabled: boolean) => {
    if (locked || !canEdit) return
    if (enabled && record.appliedRevision) {
      review(record, 'enable', record.appliedRevision)
    } else if (!enabled) {
      void perform({ path: route(record.id) + '/enabled', options: { method: 'POST', body: pluginEnabledBody(false) } })
    }
  }
  const skillFiles = new Set(editor?.bundle.manifest.skills?.map(skill => skill.file) ?? [])
  const shownFiles = editor?.bundle.files.filter(item => (tab === 'content' ? skillFiles.has(item.path) : true)) ?? []
  const selectedFile = shownFiles.find(item => item.path === file) ?? shownFiles[0]
  const record = editor?.record
  const formManifest = editor && (tab === 'manifest' ? typedManifest(manifestText, editor.bundle.manifest) : editor.bundle.manifest)
  const reach = formManifest ? manifestReach(formManifest) : []
  const executable = reach.some(item => item.id === 'host' || item.id === 'page')
  const dialogs = (
    <>
      <input
        ref={input}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={event => {
          const selected = event.target.files?.[0]
          event.target.value = ''
          if (!selected || !canEdit || locked || fileReadToken.current !== null) return
          if (selected.size > 8 * 1024 * 1024) {
            setError(COPY.fileTooLarge)
            return
          }
          const token = Symbol()
          fileReadToken.current = token
          setReadingFile(true)
          void selected
            .text()
            .then(text => {
              if (fileReadToken.current === token) open({ bundle: readPluginBundle(text) })
            })
            .catch((cause: unknown) => {
              if (fileReadToken.current === token) setError(cause instanceof Error ? cause.message : COPY.couldNotRead)
            })
            .finally(() => {
              if (fileReadToken.current === token) {
                fileReadToken.current = null
                setReadingFile(false)
              }
            })
        }}
      />
      <Dialog
        open={editor !== null}
        title={record ? record.name : COPY.newPlugin}
        size="xl"
        {...(executable ? { subtitle: COPY.codePreview } : {})}
        onClose={() => {
          if (!locked) {
            setEditor(null)
            setError('')
          }
        }}
        footer={
          <>
            {record && (
              <Button variant="ghost" disabled={locked} onClick={() => setDeleting(true)}>
                {COPY.delete}
              </Button>
            )}
            <span className="plugin-asset-spacer" />
            <Button disabled={locked} onClick={() => save(false)}>
              {COPY.saveDraft}
            </Button>
            <Button variant="primary" loading={busy} disabled={locked || !editor?.bundle.manifest.name.trim()} onClick={() => save(true)}>
              {formManifest && needsPageBuild(formManifest) ? COPY.buildPreview : COPY.apply}
            </Button>
          </>
        }>
        {editor && (
          <div className="settings-form plugin-editor">
            <div className="plugin-asset-toolbar">
              <StatusPill>{dirty ? COPY.unsavedChanges : record ? packageState(record) : COPY.notSaved}</StatusPill>
              <span className="plugin-asset-spacer" />
              {record?.appliedRevision && (
                <Switch
                  label={COPY.turnOn}
                  checked={record.enabled}
                  disabled={locked || dirty}
                  onCheckedChange={enabled => setEnabled(record, enabled)}
                />
              )}
              {record && (
                <Button
                  icon={DownloadGlyph}
                  disabled={locked || dirty}
                  onClick={() => {
                    void exportBundle(record.id).catch(cause => setError(inlineError(cause)))
                  }}>
                  {COPY.export}
                </Button>
              )}
            </div>
            {record?.unavailableReason && <InlineNotice tone="error">{record.unavailableReason}</InlineNotice>}
            <PluginReachGroup reach={reach} />
            {!!formManifest?.apps?.length && <NoteLine icon={LockGlyph} brief={{ label: COPY.appScope }} />}
            <fieldset disabled={locked} className="plugin-asset-fields">
              <div className="form-grid">
                <TextField
                  label={COPY.name}
                  disabled={tab === 'manifest'}
                  maxLength={80}
                  value={editor.bundle.manifest.name}
                  onChange={event => editBundle({ ...editor.bundle, manifest: { ...editor.bundle.manifest, name: event.target.value } })}
                />
                <TextField
                  label={COPY.version}
                  disabled={tab === 'manifest'}
                  maxLength={64}
                  value={editor.bundle.manifest.version}
                  onChange={event => editBundle({ ...editor.bundle, manifest: { ...editor.bundle.manifest, version: event.target.value } })}
                />
              </div>
              <TextField
                label={COPY.description}
                disabled={tab === 'manifest'}
                maxLength={1000}
                value={editor.bundle.manifest.description}
                onChange={event =>
                  editBundle({ ...editor.bundle, manifest: { ...editor.bundle.manifest, description: event.target.value } })
                }
              />
              <Tabs
                className="plugin-editor-tabs"
                label={COPY.editor}
                value={tab}
                options={[
                  ...(skillFiles.size ? [{ value: 'content' as const, label: COPY.skillText }] : []),
                  { value: 'files' as const, label: COPY.files },
                  { value: 'manifest' as const, label: COPY.manifest },
                ]}
                onValueChange={value => {
                  if (tab === 'manifest') {
                    try {
                      const next = readPluginBundle(JSON.stringify({ manifest: JSON.parse(manifestText), files: editor.bundle.files }))
                      if (next.manifest.id !== editor.bundle.manifest.id) throw new MessageError(COPY.idChange)
                      editBundle(next)
                    } catch (cause) {
                      setError(cause instanceof Error ? cause.message : COPY.badManifest)
                      return
                    }
                  } else if (value === 'manifest') setManifestText(JSON.stringify(editor.bundle.manifest, null, 2))
                  setError('')
                  setTab(value)
                }}
              />
              {tab === 'manifest' ? (
                <PluginSourceField
                  label={COPY.pluginManifest}
                  value={manifestText}
                  language="json"
                  rows={16}
                  onValueChange={value => {
                    setManifestText(value)
                    setDirty(true)
                  }}
                  hint={COPY.manifestDetails}
                />
              ) : (
                <div className="plugin-file-editor">
                  <div className="plugin-file-list" role="group" aria-label={COPY.pluginFiles}>
                    {shownFiles.map(item => (
                      <Button
                        key={item.path}
                        variant="ghost"
                        aria-pressed={item.path === selectedFile?.path}
                        onClick={() => setFile(item.path)}>
                        {item.path}
                      </Button>
                    ))}
                  </div>
                  {!selectedFile ? (
                    <p className="settings-empty">{COPY.noTextFiles}</p>
                  ) : tab === 'files' ? (
                    <PluginSourceField
                      key={selectedFile.path}
                      label={selectedFile.path}
                      language={languageForPath(selectedFile.path)}
                      rows={14}
                      value={selectedFile.content}
                      onValueChange={value => editBundle(editPluginSource(editor.bundle, selectedFile.path, value))}
                    />
                  ) : (
                    <TextAreaField
                      label={COPY.instructions}
                      rows={14}
                      spellCheck
                      value={selectedFile.content}
                      onChange={event => editBundle(editPluginSource(editor.bundle, selectedFile.path, event.target.value))}
                    />
                  )}
                </div>
              )}
              {tab === 'files' && (
                <div className="settings-form-row plugin-asset-actions">
                  <TextField
                    label={COPY.newFilePath}
                    value={newFile}
                    maxLength={256}
                    placeholder="helpers/format.mjs"
                    disabled={locked}
                    onChange={event => setNewFile(event.target.value)}
                  />
                  <Button
                    disabled={locked || !newFile.trim()}
                    onClick={() => {
                      try {
                        editBundle(addPluginSource(editor.bundle, newFile.trim()))
                        setFile(newFile.trim())
                        setNewFile('')
                        setError('')
                      } catch (cause) {
                        setError(cause instanceof Error ? cause.message : COPY.couldNotAdd)
                      }
                    }}>
                    {COPY.addFile}
                  </Button>
                </div>
              )}
              <details className="plugin-asset-details">
                <summary>{COPY.idAndExecution}</summary>
                <TextField
                  label={COPY.pluginId}
                  value={editor.bundle.manifest.id}
                  readOnly={record !== undefined}
                  maxLength={64}
                  onChange={event => editBundle({ ...editor.bundle, manifest: { ...editor.bundle.manifest, id: event.target.value } })}
                />
                {executable && <NoteLine icon={LockGlyph} brief={{ label: COPY.codeConfirmation }} />}
              </details>
            </fieldset>
            {error && <InlineNotice tone="error">{error}</InlineNotice>}
            {pending && !busy && (
              <InlineNotice tone="warn">
                {COPY.unknownKept}
                <Button
                  onClick={() => {
                    void perform(pending)
                  }}>
                  {COPY.retrySame}
                </Button>
              </InlineNotice>
            )}
            <InlineConfirm active={busy} rank={1} />
          </div>
        )}
      </Dialog>
      {canEdit && reviewTarget && (
        <PluginMutationDialog
          target={reviewTarget}
          busy={busy}
          failure={error}
          retryRequest={pending?.reviewId === reviewTarget.id ? () => void perform(pending) : undefined}
          onClose={() => setReviewTarget(null)}
          onConfirm={result => {
            const request = reviewedPluginMutation(reviewTarget, result)
            const completedReview =
              reviewTarget.operation === 'apply'
                ? { ...reviewTarget, done: { name: reviewTarget.name, version: result.version, kind: reviewedPluginChange(result).kind } }
                : undefined
            void perform({ ...request, reviewId: reviewTarget.id, ...(completedReview && { completedReview }) })
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={COPY.deleteTitle}
          message={COPY.deleteDetails}
          confirmLabel={COPY.deletePlugin}
          danger
          onConfirm={async () => {
            if (!record) return
            await perform({
              path: route(record.id),
              options: { method: 'DELETE', body: { requestId: newRequestId(), baseRevision: record.revision } },
            })
          }}
          onClose={() => {
            if (!busy) setDeleting(false)
          }}
        />
      )}
    </>
  )
  return {
    records,
    error,
    reviewErrorId,
    exportBundle,
    locked,
    dialogs,
    importFile: () => {
      if (!canEdit || locked) return
      setError('')
      input.current?.click()
    },
    newTool: () => {
      if (canEdit && !locked) open({ bundle: createPluginPackageTemplate('tool', 'my-plugin-' + newRequestId().slice(0, 8)) })
    },
    open: (record: PluginPackageSummary) => {
      void selectRecord(record)
    },
    /** Turns an applied package on or off from its page. */
    setEnabled,
    /** A change from the page, with no editor open to show its confirmation or an unknown result. */
    pageStatus:
      canEdit && editor === null && reviewTarget === null ? (
        <>
          <PluginWriteFeedback busy={busy} uncertain={false} />
          {pending && !busy && (
            <InlineNotice tone="warn">
              {COPY.unknown}
              <Button
                onClick={() => {
                  void perform(pending)
                }}>
                {COPY.retrySame}
              </Button>
            </InlineNotice>
          )}
        </>
      ) : null,
    /** A package's whole content, for what its page says about it. */
    read: async (record: PluginPackageSummary) => (await api<{ package: PluginPackageDetail }>(route(record.id))).package,
    applyingId: busy ? pending?.completedReview?.id : undefined,
    applyDraft: (record: PluginPackageSummary) => review(record, 'apply', record.revision),
    updateCreatorDraft: (id: string, sessionId: string) =>
      perform({
        reviewId: id,
        path: 'plugin-packages/import',
        options: { method: 'POST', body: { requestId: newRequestId(), sessionId, kind: 'plugin' } },
      }),
    retry: () => {
      setError('')
      void load().catch((cause: unknown) => {
        setError(inlineError(cause))
      })
    },
    /** Reads the list again quietly: a build or an automatic import finished elsewhere. */
    reload: () => {
      if (!alive.current || reloading.current) return
      reloading.current = true
      void load()
        .catch(() => {})
        .finally(() => {
          reloading.current = false
        })
    },
    /** Applies an earlier applied revision again (回退), with its confirmation when its pages ask for more. */
    rollback: (record: PluginPackageSummary, revision: string) => review(record, 'rollback', revision),
  }
}
