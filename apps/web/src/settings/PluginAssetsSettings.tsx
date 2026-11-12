import { useEffect, useRef, useState } from 'react'
import { Cpu, Download, FileText, Info, Lock, MonitorSmartphone, Shield, Upload } from 'lucide-react'
import { createPluginPackageTemplate, type PluginPackageBundle, type PluginPackageDetail, type PluginPackageSummary } from '@latch/protocol'
import { Button, ConfirmDialog, Dialog, Hint, Icon, InlineNotice, StatusPill, Switch, Tabs, TextAreaField, TextField } from '@latch/ui'
import { api, inlineError, isUncertain, newRequestId, type ApiOptions } from '../core/api.ts'
import { withConfirmation } from '../core/confirmations.ts'
import { InlineConfirm } from '../components/InlineConfirm.tsx'
import { PLUGIN_REACH_COPY } from '../core/securityCopy.ts'
import { IconTile, NoteLine, SettingsGroup, SettingsRow } from './common.tsx'
import { addPluginSource, editPluginSource, manifestReach, readPluginBundle, typedManifest, type PluginReach } from './pluginAssets.ts'

interface PendingChange {
  path: string
  options: ApiOptions
  thenApply?: { requestId: string }
}
interface Editor {
  bundle: PluginPackageBundle
  record?: PluginPackageDetail
}
const route = (id: string) => 'plugin-packages/' + encodeURIComponent(id)
export const packageState = (record: PluginPackageSummary) =>
  record.unavailableReason
    ? '需要处理'
    : record.state === 'draft'
      ? '草稿'
      : record.state === 'update-available'
        ? '有未应用修改'
        : record.enabled
          ? '已开启'
          : '未开启'

const REACH_ICONS = { page: MonitorSmartphone, host: Cpu, text: FileText } as const

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
            <Hint lead={<Icon icon={item.id === 'text' ? Info : Shield} size={12} />} label={item.label}>
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

/**
 * The custom plugins this device may edit, and the sheets that do it: 添加插件… (a new tool, or a file to import) and the
 * editor. Edits
 * are inert until the exact saved revision is applied.
 */
export function usePluginAssets({ canEdit, onChanged }: { canEdit: boolean; onChanged: () => void }) {
  const [records, setRecords] = useState<PluginPackageSummary[] | null>(null)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<PendingChange | null>(null)
  const [error, setError] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [tab, setTab] = useState<'content' | 'files' | 'manifest'>('content')
  const [file, setFile] = useState('')
  const [newFile, setNewFile] = useState('')
  const [dirty, setDirty] = useState(false)
  const [manifestText, setManifestText] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const alive = useRef(true)
  const reloading = useRef(false)
  const changed = useRef(onChanged)
  changed.current = onChanged
  async function load() {
    const value = await api<{ packages: PluginPackageSummary[] }>('plugin-packages')
    if (alive.current) setRecords(value.packages)
  }
  useEffect(() => {
    alive.current = canEdit
    if (!canEdit) {
      setRecords(null)
      setEditor(null)
      setAdding(false)
      setPending(null)
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
    if (busy) return
    setBusy(true)
    setError('')
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
      if (current.thenApply && result.package) {
        current = {
          path: route(result.package.id) + '/apply',
          options: { method: 'POST', body: { requestId: current.thenApply.requestId, revision: result.package.revision } },
        }
        if (alive.current) setPending(current)
        result = await send(current)
        const applied = result.package
        if (applied && alive.current) setEditor(editing => (editing ? { bundle: applied.bundle, record: applied } : null))
      }
      if (alive.current) {
        setPending(null)
        if (result.removed) {
          setEditor(null)
          setDeleting(false)
        }
        await refresh()
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
        if (bundle.manifest.id !== editor.bundle.manifest.id) throw new Error('插件标识不能在高级编辑中更改。')
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '插件声明格式无效。')
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
      ...(apply ? { thenApply: { requestId: newRequestId() } } : {}),
    })
  }
  const exportBundle = async () => {
    if (!editor?.record) return
    try {
      const result = await api<{ bundle: PluginPackageBundle }>(route(editor.record.id) + '/export')
      const url = URL.createObjectURL(new Blob([JSON.stringify(result.bundle, null, 2)], { type: 'application/json' }))
      const link = document.createElement('a')
      link.href = url
      link.download = editor.record.id + '.latch-plugin.json'
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (cause) {
      setError(inlineError(cause))
    }
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
  const locked = busy || pending !== null
  const skillFiles = new Set(editor?.bundle.manifest.skills?.map(skill => skill.file) ?? [])
  const shownFiles = editor?.bundle.files.filter(item => (tab === 'content' ? skillFiles.has(item.path) : true)) ?? []
  const selectedFile = shownFiles.find(item => item.path === file) ?? shownFiles[0]
  const record = editor?.record
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
          if (!selected || locked) return
          if (selected.size > 8 * 1024 * 1024) {
            setError('插件文件不能超过 8 MiB。')
            return
          }
          void selected
            .text()
            .then(text => {
              const bundle = readPluginBundle(text)
              if (alive.current) {
                setAdding(false)
                open({ bundle })
              }
            })
            .catch((cause: unknown) => {
              if (alive.current) setError(cause instanceof Error ? cause.message : '无法读取插件文件。')
            })
        }}
      />
      <Dialog
        open={adding}
        title="添加插件"
        size="sheet"
        onClose={() => setAdding(false)}
        footer={
          <>
            <Button icon={Upload} disabled={locked} onClick={() => input.current?.click()}>
              导入文件…
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                open({ bundle: createPluginPackageTemplate('tool', 'my-plugin-' + newRequestId().slice(0, 8)) })
                setAdding(false)
              }}>
              新建工具
            </Button>
          </>
        }>
        <NoteLine icon={Shield} brief={{ label: PLUGIN_REACH_COPY.host.label, detail: PLUGIN_REACH_COPY.host.body }} />
      </Dialog>
      <Dialog
        open={editor !== null}
        title={record ? record.name : '新建插件'}
        size="wide"
        subtitle="应用前不会运行编辑中的代码"
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
                删除
              </Button>
            )}
            <span className="plugin-asset-spacer" />
            <Button disabled={locked} onClick={() => save(false)}>
              保存草稿
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={pending !== null || !editor?.bundle.manifest.name.trim()}
              onClick={() => save(true)}>
              保存并应用
            </Button>
          </>
        }>
        {editor && (
          <div className="settings-form plugin-editor">
            <div className="plugin-asset-toolbar">
              <StatusPill>{dirty ? '未保存修改' : record ? packageState(record) : '未保存'}</StatusPill>
              <span className="plugin-asset-spacer" />
              {record?.appliedRevision && (
                <Switch
                  label="启用插件"
                  checked={record.enabled}
                  disabled={locked || dirty}
                  onCheckedChange={enabled => {
                    void perform({
                      path: route(record.id) + '/enabled',
                      options: { method: 'POST', body: { requestId: newRequestId(), enabled } },
                    })
                  }}
                />
              )}
              {record && (
                <Button
                  icon={Download}
                  disabled={locked || dirty}
                  onClick={() => {
                    void exportBundle()
                  }}>
                  导出
                </Button>
              )}
            </div>
            {record?.unavailableReason && <InlineNotice tone="error">{record.unavailableReason}</InlineNotice>}
            <PluginReachGroup
              reach={manifestReach(tab === 'manifest' ? typedManifest(manifestText, editor.bundle.manifest) : editor.bundle.manifest)}
            />
            <fieldset disabled={locked} className="plugin-asset-fields">
              <div className="form-grid">
                <TextField
                  label="插件名称"
                  disabled={tab === 'manifest'}
                  maxLength={80}
                  value={editor.bundle.manifest.name}
                  onChange={event => editBundle({ ...editor.bundle, manifest: { ...editor.bundle.manifest, name: event.target.value } })}
                />
                <TextField
                  label="版本"
                  disabled={tab === 'manifest'}
                  maxLength={64}
                  value={editor.bundle.manifest.version}
                  onChange={event => editBundle({ ...editor.bundle, manifest: { ...editor.bundle.manifest, version: event.target.value } })}
                />
              </div>
              <TextField
                label="说明"
                disabled={tab === 'manifest'}
                maxLength={1000}
                value={editor.bundle.manifest.description}
                onChange={event =>
                  editBundle({ ...editor.bundle, manifest: { ...editor.bundle.manifest, description: event.target.value } })
                }
              />
              <Tabs
                label="插件编辑方式"
                value={tab}
                options={[
                  ...(skillFiles.size ? [{ value: 'content' as const, label: '技能正文' }] : []),
                  { value: 'files' as const, label: '文件' },
                  { value: 'manifest' as const, label: '高级声明' },
                ]}
                onValueChange={value => {
                  if (tab === 'manifest') {
                    try {
                      const next = readPluginBundle(JSON.stringify({ manifest: JSON.parse(manifestText), files: editor.bundle.files }))
                      if (next.manifest.id !== editor.bundle.manifest.id) throw new Error('插件标识不能更改。')
                      editBundle(next)
                    } catch (cause) {
                      setError(cause instanceof Error ? cause.message : '声明格式无效。')
                      return
                    }
                  } else if (value === 'manifest') setManifestText(JSON.stringify(editor.bundle.manifest, null, 2))
                  setError('')
                  setTab(value)
                }}
              />
              {tab === 'manifest' ? (
                <TextAreaField
                  label="插件声明"
                  value={manifestText}
                  rows={16}
                  spellCheck={false}
                  className="plugin-source"
                  onChange={event => {
                    setManifestText(event.target.value)
                    setDirty(true)
                  }}
                  hint="可组合技能、在 Mac 上运行的模块、React 面板和静态数据面板；执行入口使用 .mjs。"
                />
              ) : (
                <div className="plugin-file-editor">
                  <div className="plugin-file-list" role="group" aria-label="插件文件">
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
                  {selectedFile ? (
                    <TextAreaField
                      label={tab === 'content' ? '工作方法' : selectedFile.path}
                      rows={14}
                      className={tab === 'files' ? 'plugin-source' : undefined}
                      spellCheck={tab === 'content'}
                      value={selectedFile.content}
                      onChange={event => editBundle(editPluginSource(editor.bundle, selectedFile.path, event.target.value))}
                    />
                  ) : (
                    <p className="settings-empty">没有文本文件</p>
                  )}
                </div>
              )}
              {tab === 'files' && (
                <div className="settings-form-row plugin-asset-actions">
                  <TextField
                    label="新增文件路径"
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
                        setError(cause instanceof Error ? cause.message : '无法添加文件。')
                      }
                    }}>
                    添加文件
                  </Button>
                </div>
              )}
              <details className="plugin-asset-details">
                <summary>插件标识与执行方式</summary>
                <TextField
                  label="插件标识"
                  value={editor.bundle.manifest.id}
                  readOnly={record !== undefined}
                  maxLength={64}
                  onChange={event => editBundle({ ...editor.bundle, manifest: { ...editor.bundle.manifest, id: event.target.value } })}
                />
                <NoteLine icon={Lock} brief={{ label: '含代码的插件要在这台 Mac 上确认' }} />
              </details>
            </fieldset>
            {error && <InlineNotice tone="error">{error}</InlineNotice>}
            {pending && !busy && (
              <InlineNotice tone="warn">
                结果尚未确认，编辑内容已保留。
                <Button
                  onClick={() => {
                    void perform(pending)
                  }}>
                  重试同一请求
                </Button>
              </InlineNotice>
            )}
            <InlineConfirm active={busy} rank={1} />
          </div>
        )}
      </Dialog>
      {deleting && (
        <ConfirmDialog
          title="删除这个插件？"
          message="新的会话将不再使用它；正在运行的工作会保留已经取得的能力。"
          confirmLabel="删除插件"
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
    locked,
    dialogs,
    add: () => {
      setAdding(true)
      setError('')
    },
    open: (record: PluginPackageSummary) => {
      void selectRecord(record)
    },
    /** Turns an applied package on or off from its page. */
    setEnabled: (record: PluginPackageSummary, enabled: boolean) => {
      void perform({ path: route(record.id) + '/enabled', options: { method: 'POST', body: { requestId: newRequestId(), enabled } } })
    },
    /** A change from the page, with no editor open to show its confirmation or an unknown result. */
    pageStatus:
      editor === null && (busy || pending) ? (
        <>
          <InlineConfirm active={busy} rank={1} />
          {pending && !busy && (
            <InlineNotice tone="warn">
              结果尚未确认。
              <Button
                onClick={() => {
                  void perform(pending)
                }}>
                重试同一请求
              </Button>
            </InlineNotice>
          )}
        </>
      ) : null,
    /** A package's whole content, for what its page says about it. */
    read: async (record: PluginPackageSummary) => (await api<{ package: PluginPackageDetail }>(route(record.id))).package,
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
    rollback: (record: PluginPackageSummary, revision: string) => {
      void perform({ path: route(record.id) + '/rollback', options: { method: 'POST', body: { requestId: newRequestId(), revision } } })
    },
  }
}
