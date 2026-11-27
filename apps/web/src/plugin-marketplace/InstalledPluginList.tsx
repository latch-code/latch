import { useState, type ReactNode } from 'react'
import type { PluginCatalogUpdateStatus, PluginPackageSummary } from '@latch/protocol'
import { Button, EmptyState } from '@latch/ui'
import type { CatalogEntry } from '../../../../examples/marketplace/bundles.ts'
import { VisibleText } from '../components/VisibleText.tsx'
import { defineCopy } from '../core/i18n.ts'
import { pendingPluginChange } from '../settings/pluginAssets.ts'

const COPY = defineCopy(
  {
    installed: '已安装的插件',
    empty: '还没有已安装的插件',
    installedVersion: (version: string) => `已安装 v${version}`,
    availableVersion: (version: string) => `可更新到 v${version}`,
    current: '已是最新',
    ahead: '已安装较新版本',
    changed: '版本号相同，来源内容有改动',
    modified: '有本地改动',
    check: '检查更新',
    reviewRelease: (version: string) => `审阅 v${version} 更新`,
    reviewUpdate: '审阅更新',
    manage: '管理',
  },
  {
    installed: 'Installed plugins',
    empty: 'No installed plugins yet',
    installedVersion: (version: string) => `Installed v${version}`,
    availableVersion: (version: string) => `Update to v${version} available`,
    current: 'Up to date',
    ahead: 'Newer version installed',
    changed: 'Source contents changed within this version',
    modified: 'Local changes',
    check: 'Check for updates',
    reviewRelease: (version: string) => `Review v${version} update`,
    reviewUpdate: 'Review update',
    manage: 'Manage',
  },
)

interface OfficialRelease {
  entry: CatalogEntry
  version: string
  status: PluginCatalogUpdateStatus | undefined
}

function updateText(release: OfficialRelease | undefined, checked: boolean, hasDraft: boolean) {
  switch (release?.status) {
    case 'available':
      return COPY.availableVersion(release.version)
    case 'current':
      return checked && !hasDraft ? COPY.current : undefined
    case 'older':
      return checked ? COPY.ahead : undefined
    case 'same-version-changed':
      return COPY.changed
    case 'local-changes':
      return COPY.modified
  }
  return undefined
}

export function InstalledPluginList({
  records,
  releases,
  lang,
  connected,
  locked,
  officialStatus,
  failure,
  onCheck,
  updateAction,
  switchControl,
  onReviewUpdate,
  onReviewDraft,
  onManage,
}: {
  records: PluginPackageSummary[]
  releases: OfficialRelease[]
  lang: 'en' | 'zh'
  connected: boolean
  locked: boolean
  officialStatus: 'checking' | 'checked' | 'failed' | undefined
  failure: string
  onCheck: () => void
  updateAction: (record: PluginPackageSummary, disabled: boolean) => ReactNode
  switchControl: (record: PluginPackageSummary, name: string) => ReactNode
  onReviewUpdate: (entry: CatalogEntry) => void
  onReviewDraft: (id: string) => void
  onManage: (id: string) => void
}) {
  const [checkId, setCheckId] = useState<string>()
  const installed = records.filter(record => record.appliedRevision !== undefined)
  if (!installed.length) return <EmptyState title={COPY.empty} />
  return (
    <ul className="plugin-installed-list" role="list" aria-label={COPY.installed}>
      {installed.map(record => {
        const release = record.catalog ? releases.find(item => item.entry.id === record.id) : undefined
        const change = pendingPluginChange(record)
        const applied = record.appliedVersion ?? (change ? undefined : record.version)
        const name = release?.entry[lang].name ?? record.name
        const description = release?.entry[lang].summary ?? record.description
        const status = updateText(release, connected && officialStatus === 'checked', !!change)
        const checking = officialStatus === 'checking' && connected
        const failed = checkId === record.id && officialStatus === 'failed' && connected
        return (
          <li key={record.id} className="plugin-installed-card">
            <header>
              <h3>
                <VisibleText text={name} />
              </h3>
              <Button
                className="plugin-installed-manage"
                data-review-return={record.id}
                size="sm"
                variant="ghost"
                disabled={!connected || locked}
                onClick={() => onManage(record.id)}>
                {COPY.manage}
              </Button>
            </header>
            {(applied || change) && (
              <div className="plugin-installed-version">
                {applied && (
                  <span>
                    <VisibleText text={COPY.installedVersion(applied)} />
                  </span>
                )}
                {change && (
                  <span>
                    <VisibleText text={`${change.status} v${record.version}`} />
                  </span>
                )}
              </div>
            )}
            {description && (
              <p className="plugin-installed-description">
                <VisibleText text={description} />
              </p>
            )}
            {record.unavailableReason && (
              <p className="plugin-market-note">
                <VisibleText text={record.unavailableReason} />
              </p>
            )}
            <footer>
              {switchControl(record, name)}
              <div className="plugin-market-actions">
                {status && (
                  <span className="plugin-installed-status" role="status" data-update={release?.status === 'available' || undefined}>
                    {status}
                  </span>
                )}
                {change && (
                  <Button variant="primary" disabled={!connected || locked} aria-haspopup="dialog" onClick={() => onReviewDraft(record.id)}>
                    {change.review}
                  </Button>
                )}
                {release ? (
                  <>
                    <Button
                      disabled={!connected || checking || locked}
                      loading={checking && checkId === record.id}
                      onClick={() => {
                        setCheckId(record.id)
                        onCheck()
                      }}>
                      {COPY.check}
                    </Button>
                    {release.status === 'available' && (
                      <Button
                        variant={change ? 'outline' : 'primary'}
                        disabled={!connected || checking || locked}
                        aria-haspopup="dialog"
                        onClick={() => onReviewUpdate(release.entry)}>
                        {change ? <VisibleText text={COPY.reviewRelease(release.version)} /> : COPY.reviewUpdate}
                      </Button>
                    )}
                  </>
                ) : (
                  updateAction(record, locked)
                )}
              </div>
            </footer>
            {failed && (
              <p className="plugin-market-note" role="status">
                {failure}
              </p>
            )}
          </li>
        )
      })}
    </ul>
  )
}
