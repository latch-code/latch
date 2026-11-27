import { useState } from 'react'
import { escapeSecurityText, type PluginPackageBundle, type PluginPackageSummary } from '@latch/protocol'
import { Button, InlineNotice, ValuePicker } from '@latch/ui'
import { VisibleText } from '../components/VisibleText.tsx'
import { handDraft } from '../core/draftHandoff.ts'
import { HighlightedCode } from '../preview/HighlightedCode.tsx'
import { languageForPath } from '../preview/highlight-protocol.ts'
import { defineCopy } from '../core/i18n.ts'
import { SettingsGroup } from './common.tsx'
import { pendingPluginChange } from './pluginAssets.ts'

const COPY = defineCopy(
  {
    title: '插件内容',
    files: '文件与源码',
    installHint: (version: string) => `v${version} 已准备好。确认安装后即可使用。`,
    updateHint: (version: string, enable: boolean) => (enable ? `确认后将更新到 v${version} 并启用插件。` : `确认后将更新到 v${version}。`),
    editHint: (enable: boolean) => (enable ? '确认后将启用修改后的插件。' : '修改已保存，确认后生效。'),
    installed: (version: string) => `当前已安装 v${version}。`,
    file: '审阅文件',
    update: '从创作会话更新',
    return: '返回创作会话',
    repair: '交回 Agent 修改',
    skillReady: '技能已启用。可在「我的 Agent」里为支持 Latch 技能的 Agent 选用。',
    applied: '此版本已安装。',
    repairPrompt: (message: string) => `Latch 应用 latch-plugin/ 草稿时遇到问题。请根据以下诊断修改草稿：\n\n${message}`,
  },
  {
    title: 'Plugin contents',
    files: 'Files and source',
    installHint: (version: string) => `v${version} is ready to install. Confirm the installation to use it.`,
    updateHint: (version: string, enable: boolean) =>
      enable ? `Confirm to update to v${version} and turn the plugin on.` : `Confirm to update to v${version}.`,
    editHint: (enable: boolean) =>
      enable ? 'Confirm to turn on the plugin with your changes.' : 'Your changes are saved. Confirm to put them into effect.',
    installed: (version: string) => `v${version} is currently installed. `,
    file: 'Review file',
    update: 'Update from creator chat',
    return: 'Return to creator chat',
    repair: 'Hand back to Agent',
    skillReady: 'Skill enabled. In My Agents, select it for an Agent that supports Latch skills.',
    applied: 'This version is installed.',
    repairPrompt: (message: string) =>
      `Latch had a problem applying the latch-plugin/ draft. Please fix it using this diagnostic:\n\n${message}`,
  },
)

/**
 * Every shipped file and the manifest, one at a time: the source is text with syntax colours from the shared highlighter
 * (role spans, hidden characters made visible), never markup.
 */
export function PluginFileViewer({ bundle }: { bundle: PluginPackageBundle }) {
  const { manifest, files } = bundle
  const manifestPath = 'latch-plugin.json'
  const paths = [...files.map(file => file.path), manifestPath]
  const [selected, setSelected] = useState(manifest.host?.[0] ?? manifest.panels?.[0]?.entry ?? manifest.skills?.[0]?.file ?? manifestPath)
  const path = paths.includes(selected) ? selected : manifestPath
  const sourceText = path === manifestPath ? JSON.stringify(manifest, null, 2) : (files.find(file => file.path === path)?.content ?? '')
  return (
    <>
      <ValuePicker
        label={COPY.file}
        value={path}
        options={paths.map(file => ({ value: file, label: escapeSecurityText(file) }))}
        onValueChange={setSelected}
      />
      <pre
        className="creator-plugin-source"
        tabIndex={0}
        aria-label={escapeSecurityText(path)}
        dir="ltr"
        data-path={escapeSecurityText(path)}>
        <HighlightedCode key={path} code={sourceText} language={languageForPath(path)} />
      </pre>
    </>
  )
}

export function PluginFileDisclosure({ bundle }: { bundle: PluginPackageBundle }) {
  const [viewed, setViewed] = useState(false)
  return (
    <details
      className="plugin-asset-details"
      onToggle={event => {
        if (event.currentTarget.open) setViewed(true)
      }}>
      <summary>{COPY.files}</summary>
      {viewed && (
        <div className="settings-form">
          <PluginFileViewer bundle={bundle} />
        </div>
      )}
    </details>
  )
}

export function CreatorPluginReview({
  bundle,
  record,
  locked,
  error,
  onApply,
  onUpdate,
  onOpenSession,
}: {
  bundle: PluginPackageBundle
  record: PluginPackageSummary
  locked: boolean
  error: string
  onApply?: (() => void) | undefined
  onUpdate?: () => void
  onOpenSession?: () => void
}) {
  const { manifest } = bundle
  const source = record.source
  const canReturn = source && onOpenSession
  const change = pendingPluginChange(record)
  return (
    <SettingsGroup title={change && onApply ? change.status : COPY.title} bare>
      <div className="creator-plugin-review">
        {change && onApply && (
          <p className="settings-caption">
            <VisibleText
              text={
                change.kind === 'install'
                  ? COPY.installHint(record.version)
                  : (record.appliedVersion ? COPY.installed(record.appliedVersion) : '')
                    + (change.kind === 'edit' ? COPY.editHint(!record.enabled) : COPY.updateHint(record.version, !record.enabled))
              }
            />
          </p>
        )}
        {error && (
          <InlineNotice
            tone="error"
            action={
              canReturn && !locked ? (
                <Button
                  onClick={() => {
                    handDraft(source.sessionId, COPY.repairPrompt(error))
                    onOpenSession()
                  }}>
                  {COPY.repair}
                </Button>
              ) : undefined
            }>
            {error}
          </InlineNotice>
        )}
        {record.state === 'applied' && (
          <p className="settings-caption">{record.enabled && manifest.skills?.length ? COPY.skillReady : COPY.applied}</p>
        )}
        <div className="plugin-asset-actions">
          {change && onApply && (
            <Button variant="primary" aria-haspopup="dialog" disabled={locked} onClick={onApply}>
              {change.review}
            </Button>
          )}
          {canReturn && (
            <Button variant="ghost" onClick={onOpenSession}>
              {COPY.return}
            </Button>
          )}
          {canReturn && onUpdate && (
            <Button disabled={locked} onClick={onUpdate}>
              {COPY.update}
            </Button>
          )}
        </div>
        <PluginFileDisclosure key={record.revision} bundle={bundle} />
      </div>
    </SettingsGroup>
  )
}
