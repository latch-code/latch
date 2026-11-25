import { useState } from 'react'
import { escapeSecurityText, type PluginPackageBundle, type PluginPackageSummary } from '@latch/protocol'
import { Button, InlineNotice, ValuePicker } from '@latch/ui'
import { handDraft } from '../core/draftHandoff.ts'
import { HighlightedCode } from '../preview/HighlightedCode.tsx'
import { languageForPath } from '../preview/highlight-protocol.ts'
import { defineCopy } from '../core/i18n.ts'
import { SettingsGroup } from './common.tsx'
import { PluginReachGroup } from './PluginAssetsSettings.tsx'
import { packageReach } from './pluginAssets.ts'

const COPY = defineCopy(
  {
    title: '创作草稿',
    npmTitle: 'npm 插件内容',
    catalogTitle: '精选插件内容',
    externalTitle: { github: 'GitHub 插件内容', 'local-folder': '文件夹中的插件内容', 'local-bundle': '导出包中的插件内容' },
    file: '审阅文件',
    apply: '应用此草稿',
    update: '从创作会话更新',
    return: '返回创作会话',
    repair: '交回 Agent 修改',
    skillReady: '技能已启用。可在「我的 Agent」里为支持 Latch 技能的 Agent 选用。',
    applied: '此版本已应用。',
    repairPrompt: (message: string) => `Latch 应用 latch-plugin/ 草稿时遇到问题。请根据以下诊断修改草稿：\n\n${message}`,
  },
  {
    title: 'Creator draft',
    npmTitle: 'npm plugin contents',
    catalogTitle: 'Catalog plugin contents',
    externalTitle: {
      github: 'GitHub plugin contents',
      'local-folder': 'Plugin folder contents',
      'local-bundle': 'Exported bundle contents',
    },
    file: 'Review file',
    apply: 'Apply this draft',
    update: 'Update from creator chat',
    return: 'Return to creator chat',
    repair: 'Hand back to Agent',
    skillReady: 'Skill enabled. In My Agents, select it for an Agent that supports Latch skills.',
    applied: 'This version is applied.',
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

/** Source is displayed as text. Only the Host can activate this exact revision after the person chooses Apply. */
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
  const title = record.npm
    ? COPY.npmTitle
    : record.catalog
      ? COPY.catalogTitle
      : record.external
        ? COPY.externalTitle[record.external.source.kind]
        : COPY.title
  return (
    <SettingsGroup title={title} bare>
      <div className="creator-plugin-review">
        <PluginReachGroup reach={packageReach(manifest, record)} />
        <PluginFileViewer bundle={bundle} />
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
          {record.state !== 'applied' && onApply && (
            <Button variant="primary" disabled={locked} onClick={onApply}>
              {COPY.apply}
            </Button>
          )}
        </div>
      </div>
    </SettingsGroup>
  )
}
