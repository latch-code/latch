import { useEffect, useState, type ReactNode } from 'react'
import type { AppCapabilities, PluginExternalSource, PluginPackageReview } from '@latch/protocol'
import { Button, Dialog, InlineNotice } from '@latch/ui'
import { VisibleText } from '../components/VisibleText.tsx'
import { api, inlineError, newRequestId, type ApiOptions } from '../core/api.ts'
import { defineCopy, formatNumber, listText } from '../core/i18n.ts'
import { Loading, SettingsGroup, SettingsRow } from './common.tsx'

const COPY = defineCopy(
  {
    risk: '运行权限与风险',
    version: '目标版本',
    versionChange: '已应用版本 → 目标版本',
    source: '来源',
    catalog: '随 Latch 附带',
    npm: 'npm 仓库',
    creator: '创作会话',
    local: '本地草稿或导入文件',
    github: 'GitHub 仓库',
    folder: '这台 Mac 上的文件夹',
    bundle: '这台 Mac 上的插件包',
    modified: (version: string) => `从 ${version} 版修改的本地草稿`,
    host: '工作台代码',
    hostWarning: '此插件的代码会获得这台 Mac 上 Latch 工作台进程的权限。',
    panelWarning: '此插件会在能看会话的设备上运行拥有 Latch 页面权限的代码。',
    hostRisk: '可以访问 Latch 工作台进程能读取的文件和凭据，也能启动程序和连接网络。',
    panel: '会话面板代码',
    panelRisk: '可以访问 Latch 页面可见的数据。',
    context: '可读取当前会话的上下文统计',
    tools: '源码中声明的工具',
    page: '隔离应用',
    pageScope: '应用页面在隔离框里运行。Latch 工作台按以下能力处理请求。',
    taskList: '读取会话摘要',
    taskStartAny: '在任意项目开始会话',
    taskStart: '在指定项目开始会话',
    taskContinue: '向应用开始的会话发送消息',
    taskReadOwn: '读取应用开始的会话的最后一条回复和结束状态',
    storage: '读写应用数据',
    scopes: { plugin: '插件', project: '项目', session: '会话' },
    noCapabilities: '未声明工作台能力',
    added: '较已应用版本新增或放宽',
    unapproved: '需要在这台 Mac 确认的能力',
    skills: '技能指令',
    skillsRisk: 'Agent 选用技能时会按其中的文字指令工作。',
    dataPanels: '静态面板',
    dataPanelsInfo: '在会话中展示静态内容。',
    covered: '风险提示基于包声明与有限的源码检查。请核对来源和文件后再决定。',
    changes: '与已应用版本的差异',
    changedFiles: (count: number) => `${formatNumber(count)} 个文件有变化`,
    changedExecution: '可信执行内容已变化',
    manifestChanged: '插件声明有改动',
    previousSource: '已应用版本的来源',
    expanded: '应用页面能力新增或放宽',
    noExpanded: '应用页面能力未扩大',
    onMac: '继续后需在这台 Mac 上完成确认。',
    review: { apply: '审阅并应用插件', rollback: '审阅并回退插件', enable: '审阅并启用插件' },
    confirm: { install: '确认安装', apply: '确认应用', rollback: '确认回退', enable: '确认启用' },
    loading: '正在读取这个版本的审阅信息…',
    retry: '重新读取',
    cancel: '取消',
    changed: '无法读取此版本的完整审阅信息，请刷新后重试。',
    unknownFinding: (kind: string) => `未识别的风险类型 · ${kind}`,
    findings: '需要留意的源码',
    finding: {
      'file-access': '可能读写文件',
      'process-execution': '可能运行其他程序',
      'network-access': '可能连接网络',
      'environment-access': '可能读取环境变量',
      'browser-data-access': '可能访问浏览器存储或页面数据',
      'dynamic-code': '可能动态加载或运行代码',
      'tool-registration': '可能注册 Agent 工具',
      'looks-like-secret': '文件可能含有密钥或令牌',
    },
    fileChange: { added: '新增', modified: '修改', removed: '删除' },
    adoptsData: '应用会接管之前删除的同标识插件保留的数据。',
  },
  {
    risk: 'Access and risks',
    version: 'Target version',
    versionChange: 'Applied version → target version',
    source: 'Source',
    catalog: 'Bundled with Latch',
    npm: 'npm registry',
    creator: 'Creator chat',
    local: 'Local draft or imported file',
    github: 'GitHub repository',
    folder: 'Folder on this Mac',
    bundle: 'Plugin bundle on this Mac',
    modified: (version: string) => `Local draft edited from version ${version}`,
    host: 'Workbench code',
    hostWarning: 'This plugin runs code with the permissions of the Latch workbench process on this Mac.',
    panelWarning: 'This plugin runs code with the Latch page’s permissions on devices that can view sessions.',
    hostRisk: 'Can access files and credentials available to the Latch workbench process, start programs and connect to the network.',
    panel: 'Session panel code',
    panelRisk: 'Can access data visible to the Latch page.',
    context: 'Can read context measurements for the current session',
    tools: 'Tool names declared in source',
    page: 'Isolated app',
    pageScope: 'App pages run in an isolated frame. The Latch workbench grants requests within the capabilities listed here.',
    taskList: 'Read session summaries',
    taskStartAny: 'Start sessions in any project',
    taskStart: 'Start sessions in selected projects',
    taskContinue: 'Send input to sessions started by this app',
    taskReadOwn: 'Read the last reply and end state of sessions started by this app',
    storage: 'Read and write app data',
    scopes: { plugin: 'plugin', project: 'project', session: 'session' },
    noCapabilities: 'No declared workbench capabilities',
    added: 'Added or expanded from the applied version',
    unapproved: 'Capabilities requiring confirmation on this Mac',
    skills: 'Skill instructions',
    skillsRisk: 'Agents use these written instructions when the skill is selected.',
    dataPanels: 'Static panels',
    dataPanelsInfo: 'Display static content in a session.',
    covered: 'These findings use the manifest and limited source checks. Review the source and files before deciding.',
    changes: 'Changes from the applied version',
    changedFiles: (count: number) => `${formatNumber(count)} files changed`,
    changedExecution: 'Trusted executable contents changed',
    manifestChanged: 'The plugin manifest changed',
    previousSource: 'Source of the applied version',
    expanded: 'App page capabilities were added or expanded',
    noExpanded: 'App page capabilities did not expand',
    onMac: 'Continue to confirm on this Mac.',
    review: { apply: 'Review and apply plugin', rollback: 'Review and roll back plugin', enable: 'Review and enable plugin' },
    confirm: { install: 'Confirm installation', apply: 'Confirm application', rollback: 'Confirm rollback', enable: 'Confirm enabling' },
    loading: 'Reading the review for this version…',
    retry: 'Read again',
    cancel: 'Cancel',
    changed: 'Couldn’t read the complete review for this version. Refresh and try again.',
    unknownFinding: (kind: string) => `Unrecognized risk type · ${kind}`,
    findings: 'Source findings',
    finding: {
      'file-access': 'May read or write files',
      'process-execution': 'May run other programs',
      'network-access': 'May connect to the network',
      'environment-access': 'May read environment variables',
      'browser-data-access': 'May access browser storage or page data',
      'dynamic-code': 'May load or execute code dynamically',
      'tool-registration': 'May register Agent tools',
      'looks-like-secret': 'Files may contain keys or tokens',
    },
    fileChange: { added: 'Added', modified: 'Edited', removed: 'Removed' },
    adoptsData: 'Applying this version will take over data retained by a deleted plugin with the same ID.',
  },
)

function Listing({ items }: { items: readonly string[] }) {
  return (
    <span className="plugin-review-list">
      {items.map((item, index) => (
        <span key={index}>
          <VisibleText text={item} />
        </span>
      ))}
    </span>
  )
}

function capabilityLines(capabilities: AppCapabilities): string[] {
  const start = capabilities['tasks.start']?.projects
  return [
    ...(capabilities['tasks.read'] ? [COPY.taskList] : []),
    ...(start === 'any' ? [COPY.taskStartAny] : start?.length ? [COPY.taskStart + ' · ' + listText(start)] : []),
    ...(capabilities['tasks.continue'] ? [COPY.taskContinue] : []),
    ...(capabilities['tasks.readOwn'] ? [COPY.taskReadOwn] : []),
    ...(capabilities.storage?.length ? [COPY.storage + ' · ' + listText(capabilities.storage.map(scope => COPY.scopes[scope]))] : []),
  ]
}

export function PluginSourceText({ source }: { source: PluginPackageReview['source'] }) {
  if (source.kind === 'external') {
    return (
      <Listing items={[...externalSourceLines(source.source, source.path), ...(source.modified ? [COPY.modified(source.version)] : [])]} />
    )
  }
  return (
    <Listing
      items={
        source.kind === 'npm'
          ? [COPY.npm, source.name, source.registry, ...(source.modified ? [COPY.modified(source.version)] : [])]
          : source.kind === 'catalog'
            ? [COPY.catalog, ...(source.modified ? [COPY.modified(source.version)] : [])]
            : [source.kind === 'creator' ? COPY.creator : COPY.local]
      }
    />
  )
}

function externalSourceLines(source: PluginExternalSource, path?: string): string[] {
  const location =
    source.kind === 'github'
      ? [COPY.github, source.repository, source.ref + ' · ' + source.commit]
      : source.kind === 'local-folder'
        ? [COPY.folder, source.directory]
        : [COPY.bundle, source.file]
  return path ? [...location, path] : location
}

export function PluginExternalSourceText({ source }: { source: PluginExternalSource }) {
  return <Listing items={externalSourceLines(source)} />
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const strings = (value: unknown) => Array.isArray(value) && value.every(item => typeof item === 'string')

function validCapabilities(value: unknown): boolean {
  if (!record(value)) return false
  return Object.entries(value).every(([key, capability]) => {
    switch (key) {
      case 'tasks.read':
      case 'tasks.readOwn':
      case 'tasks.continue':
        return capability === true
      case 'tasks.start':
        return record(capability) && (capability.projects === 'any' || strings(capability.projects))
      case 'storage':
        return Array.isArray(capability) && capability.every(scope => scope === 'plugin' || scope === 'project' || scope === 'session')
      default:
        return false
    }
  })
}

function validSource(value: unknown): boolean {
  if (!record(value)) return false
  switch (value.kind) {
    case 'local':
    case 'creator':
      return true
    case 'catalog':
      return typeof value.version === 'string'
    case 'npm':
      return typeof value.version === 'string' && typeof value.name === 'string' && typeof value.registry === 'string'
    case 'external': {
      const origin = value.source
      if (typeof value.version !== 'string' || typeof value.pluginId !== 'string' || typeof value.path !== 'string' || !record(origin))
        return false
      switch (origin.kind) {
        case 'github':
          return typeof origin.repository === 'string' && typeof origin.ref === 'string' && typeof origin.commit === 'string'
        case 'local-folder':
          return typeof origin.directory === 'string'
        case 'local-bundle':
          return typeof origin.file === 'string'
        default:
          return false
      }
    }
    default:
      return false
  }
}

export function isPluginPackageReview(value: unknown, revision?: string): value is PluginPackageReview {
  if (!record(value) || typeof value.revision !== 'string' || (revision !== undefined && value.revision !== revision)) return false
  const base = value.baseAppliedRevision
  if (
    typeof value.version !== 'string'
    || (base !== null && typeof base !== 'string')
    || typeof value.confirmationRequired !== 'boolean'
    || !validSource(value.source)
  )
    return false
  const comparison = value.comparison
  if (base !== null && base !== value.revision && comparison === undefined) return false
  if (
    comparison !== undefined
    && (!record(comparison)
      || comparison.revision !== base
      || typeof comparison.version !== 'string'
      || typeof comparison.expandedPageCapabilities !== 'boolean'
      || typeof comparison.changedExecution !== 'boolean'
      || typeof comparison.manifestChanged !== 'boolean'
      || typeof comparison.changedSource !== 'boolean'
      || (comparison.source !== undefined && !validSource(comparison.source))
      || !Array.isArray(comparison.changedFiles)
      || !comparison.changedFiles.every(
        item =>
          record(item)
          && typeof item.path === 'string'
          && (item.change === 'added' || item.change === 'modified' || item.change === 'removed'),
      ))
  )
    return false
  return (
    strings(value.hostModules)
    && strings(value.toolNames)
    && Array.isArray(value.panels)
    && value.panels.every(item => record(item) && typeof item.title === 'string' && typeof item.entry === 'string')
    && Array.isArray(value.pages)
    && value.pages.every(
      item =>
        record(item)
        && typeof item.id === 'string'
        && typeof item.title === 'string'
        && validCapabilities(item.capabilities)
        && (item.addedCapabilities === undefined || validCapabilities(item.addedCapabilities))
        && (item.addedSinceApplied === undefined || validCapabilities(item.addedSinceApplied)),
    )
    && Array.isArray(value.skills)
    && value.skills.every(item => record(item) && typeof item.name === 'string' && typeof item.file === 'string')
    && Array.isArray(value.dataPanels)
    && value.dataPanels.every(item => record(item) && typeof item.title === 'string')
    && Array.isArray(value.findings)
    && value.findings.every(item => record(item) && typeof item.kind === 'string' && (item.files === undefined || strings(item.files)))
  )
}

function PluginReviewUnavailable() {
  return (
    <InlineNotice tone="error" secure>
      {COPY.changed}
    </InlineNotice>
  )
}

const declarationFindings = new Set([
  'host-access',
  'workbench-access',
  'context-statistics',
  'agent-instructions',
  'starts-sessions',
  'continues-sessions',
  'reads-sessions',
  'reads-own-replies',
  'writes-storage',
])

export function PluginRiskFacts({ review, extra }: { review: PluginPackageReview; extra?: ReactNode }) {
  if (!isPluginPackageReview(review)) return <PluginReviewUnavailable />
  const comparison = review.comparison
  const findings = review.findings.filter(finding => !declarationFindings.has(finding.kind))
  const version = comparison ? `${comparison.version} → ${review.version}` : review.version
  return (
    <div className="plugin-risk-facts" data-secure="">
      <SettingsGroup>
        <SettingsRow title={COPY.source} description={<PluginSourceText source={review.source} />} />
        <SettingsRow title={comparison ? COPY.versionChange : COPY.version} description={<VisibleText text={version} />} />
        {extra}
      </SettingsGroup>
      {review.hostModules.length > 0 && <InlineNotice tone="warn">{COPY.hostWarning}</InlineNotice>}
      {review.panels.length > 0 && <InlineNotice tone="warn">{COPY.panelWarning}</InlineNotice>}
      <SettingsGroup title={COPY.risk}>
        {review.hostModules.length > 0 && (
          <SettingsRow title={COPY.host} description={<Listing items={[COPY.hostRisk, ...review.hostModules]} />} />
        )}
        {review.toolNames.length > 0 && <SettingsRow title={COPY.tools} description={<Listing items={review.toolNames} />} />}
        {review.panels.length > 0 && (
          <SettingsRow
            title={COPY.panel}
            description={
              <Listing
                items={[
                  COPY.panelRisk,
                  ...review.panels.map(panel => [panel.title, panel.entry, ...(panel.context ? [COPY.context] : [])].join(' · ')),
                ]}
              />
            }
          />
        )}
        {review.pages.map(page => {
          const capabilities = capabilityLines(page.capabilities)
          const added = page.addedSinceApplied ? capabilityLines(page.addedSinceApplied) : []
          const unapproved = comparison && page.addedCapabilities ? capabilityLines(page.addedCapabilities) : []
          return (
            <SettingsRow
              key={page.id}
              title={<VisibleText text={`${COPY.page} · ${page.title}`} />}
              description={
                <Listing
                  items={[
                    COPY.pageScope,
                    ...(capabilities.length ? capabilities : [COPY.noCapabilities]),
                    ...added.map(item => COPY.added + ' · ' + item),
                    ...unapproved.map(item => COPY.unapproved + ' · ' + item),
                  ]}
                />
              }
            />
          )
        })}
        {review.skills.length > 0 && (
          <SettingsRow
            title={COPY.skills}
            description={<Listing items={[COPY.skillsRisk, ...review.skills.map(skill => `${skill.name} · ${skill.file}`)]} />}
          />
        )}
        {review.dataPanels.length > 0 && (
          <SettingsRow
            title={COPY.dataPanels}
            description={<Listing items={[COPY.dataPanelsInfo, ...review.dataPanels.map(panel => panel.title)]} />}
          />
        )}
      </SettingsGroup>
      {review.adoptsData && <InlineNotice tone="warn">{COPY.adoptsData}</InlineNotice>}
      {comparison && (
        <SettingsGroup title={COPY.changes}>
          <SettingsRow
            title={comparison.expandedPageCapabilities ? COPY.expanded : COPY.noExpanded}
            description={
              <Listing
                items={[
                  ...(comparison.changedExecution ? [COPY.changedExecution] : []),
                  ...(comparison.manifestChanged ? [COPY.manifestChanged] : []),
                ]}
              />
            }
          />
          {comparison.changedSource && comparison.source && (
            <SettingsRow title={COPY.previousSource} description={<PluginSourceText source={comparison.source} />} />
          )}
          {comparison.changedFiles.length > 0 && (
            <details className="plugin-asset-details">
              <summary>{COPY.changedFiles(comparison.changedFiles.length)}</summary>
              <Listing items={comparison.changedFiles.map(file => COPY.fileChange[file.change] + ' · ' + file.path)} />
            </details>
          )}
        </SettingsGroup>
      )}
      {findings.length > 0 && (
        <SettingsGroup title={COPY.findings}>
          {findings.map(finding => (
            <SettingsRow
              key={finding.kind}
              title={
                <VisibleText
                  text={
                    Object.hasOwn(COPY.finding, finding.kind)
                      ? COPY.finding[finding.kind as keyof typeof COPY.finding]
                      : COPY.unknownFinding(finding.kind)
                  }
                />
              }
              description={finding.files?.length ? <Listing items={finding.files} /> : undefined}
            />
          ))}
        </SettingsGroup>
      )}
      <p className="settings-caption">{COPY.covered}</p>
    </div>
  )
}

export type PluginMutationTarget = {
  id: string
  name: string
  operation: 'apply' | 'rollback' | 'enable'
  revision: string
}

const packagePath = (id: string) => `plugin-packages/${encodeURIComponent(id)}`

type InstalledPluginReview = PluginPackageReview & { installId: string }

function isInstalledPluginReview(value: unknown, revision: string): value is InstalledPluginReview {
  return isPluginPackageReview(value, revision) && typeof value.installId === 'string' && /^[A-Za-z0-9_-]{22}$/u.test(value.installId)
}

export function reviewedPluginMutation(target: PluginMutationTarget, review: InstalledPluginReview): { path: string; options: ApiOptions } {
  return {
    path: `${packagePath(target.id)}/${target.operation === 'enable' ? 'enabled' : target.operation}`,
    options: {
      method: 'POST',
      body: {
        requestId: newRequestId(),
        baseAppliedRevision: review.baseAppliedRevision,
        reviewedInstallId: review.installId,
        ...(target.operation === 'enable' ? { enabled: true } : { revision: review.revision }),
      },
    },
  }
}

/** The only action in the footer waits for the Host to describe the exact requested revision. */
type PluginMutationDialogProps = {
  target: PluginMutationTarget
  onConfirm: (review: InstalledPluginReview) => void
  onClose: () => void
}

export function PluginMutationDialog(props: PluginMutationDialogProps) {
  const { id, operation, revision } = props.target
  return <MutationReview key={JSON.stringify([id, operation, revision])} {...props} />
}

function MutationReview({ target, onConfirm, onClose }: PluginMutationDialogProps) {
  const [result, setResult] = useState<{ review: InstalledPluginReview } | { error: string } | null>(null)
  const [retry, setRetry] = useState(0)
  const { id, operation, revision } = target
  useEffect(() => {
    const controller = new AbortController()
    const query = new URLSearchParams({ operation, revision })
    void api<{ review: unknown }>(`${packagePath(id)}/review?${query}`, { signal: controller.signal }).then(
      ({ review }) => {
        if (!controller.signal.aborted) setResult(isInstalledPluginReview(review, revision) ? { review } : { error: COPY.changed })
      },
      cause => {
        if (!controller.signal.aborted) setResult({ error: inlineError(cause) })
      },
    )
    return () => controller.abort()
  }, [id, operation, revision, retry])
  const review = result && 'review' in result ? result.review : null
  return (
    <Dialog
      open
      size="lg"
      secure
      className="plugin-mutation-dialog"
      title={COPY.review[operation]}
      onClose={onClose}
      footer={
        <>
          <Button size="md" onClick={onClose}>
            {COPY.cancel}
          </Button>
          <Button
            variant="primary"
            size="md"
            disabled={review === null}
            onClick={() => {
              if (review) onConfirm(review)
            }}>
            {COPY.confirm[operation === 'apply' && review?.baseAppliedRevision === null ? 'install' : operation]}
          </Button>
        </>
      }>
      <div className="plugin-risk-facts">
        <p className="plugin-review-name">
          <VisibleText text={target.name} />
        </p>
        {review ? (
          <>
            <PluginRiskFacts review={review} />
            {review.confirmationRequired && <InlineNotice tone="warn">{COPY.onMac}</InlineNotice>}
          </>
        ) : result && 'error' in result ? (
          <InlineNotice
            tone="error"
            action={
              <Button
                onClick={() => {
                  setResult(null)
                  setRetry(count => count + 1)
                }}>
                {COPY.retry}
              </Button>
            }>
            {result.error}
          </InlineNotice>
        ) : (
          <Loading label={COPY.loading} />
        )}
      </div>
    </Dialog>
  )
}
