import type { AppCapabilities, PluginPackageFindingKind, PluginPackageReview, PluginPackageReviewSource } from '@latch/protocol'
import { canonicalJson, containsSecret, maskKnownSecrets, redactKnownSecrets } from '@latch/core/node-kit'
import { capabilitySet, withinApproved } from './app-capabilities.ts'
import type { PluginAssetRecord } from './plugin-assets.ts'
import { checkedPluginBundle } from './plugin-package-bundle.ts'
import { externalSourceIdentity } from './plugin-external-source.ts'

type Checked = ReturnType<typeof checkedPluginBundle>
type RecordSource = Pick<PluginAssetRecord, 'catalog' | 'npm' | 'external' | 'source' | 'appliedOrigin' | 'appliedRevision' | 'history'>

export function pluginReviewSource(record: RecordSource, revision: string, draft = false): PluginPackageReviewSource {
  const known =
    record.appliedRevision === revision ? record.appliedOrigin : record.history?.find(item => item.revision === revision)?.origin
  if (known && !draft) return known
  if (record.catalog && (draft || record.catalog.revision === revision))
    return {
      kind: 'catalog',
      version: record.catalog.version,
      ...(record.catalog.revision === revision ? {} : { modified: true }),
    }
  if (record.npm && (draft || record.npm.revision === revision)) {
    const { revision: stagedRevision, ...release } = record.npm
    return { kind: 'npm', ...release, ...(stagedRevision === revision ? {} : { modified: true }) }
  }
  if (record.external && (draft || record.external.revision === revision)) {
    const { revision: stagedRevision, ...release } = record.external
    return { kind: 'external', ...release, ...(stagedRevision === revision ? {} : { modified: true }) }
  }
  return { kind: record.source ? 'creator' : 'local' }
}

const codeObservations = [
  ['file-access', /[\x27"](node:)?fs(?:\/promises)?[\x27"]|\b(?:Bun|Deno)\.(?:file|writeFile|readFile)/u],
  ['process-execution', /[\x27"](node:)?(?:child_process|worker_threads)[\x27"]|\b(?:Bun\.spawn|Deno\.Command|process\.execPath)/u],
  ['network-access', /[\x27"](?:node:)?(?:https?|net|tls|dgram)[\x27"]|\b(?:fetch\s*\(|WebSocket\s*\(|XMLHttpRequest\b|sendBeacon\s*\()/u],
  ['environment-access', /\b(?:process\.env|Bun\.env|Deno\.env)\b|[\x27"](?:node:)?process[\x27"]/u],
  ['browser-data-access', /\b(?:localStorage|sessionStorage|indexedDB|document\.cookie|navigator\.clipboard)\b/u],
  ['dynamic-code', /\b(?:eval|(?:new\s+)?Function|import)\s*\(|\bWebAssembly\b/u],
  ['tool-registration', /\bregisterTool\b/u],
] as const satisfies ReadonlyArray<readonly [PluginPackageFindingKind, RegExp]>

function newCapabilities(wanted: AppCapabilities, previous: AppCapabilities | undefined): AppCapabilities {
  const added: AppCapabilities = {}
  for (const name of ['tasks.read', 'tasks.continue', 'tasks.readOwn'] as const) if (wanted[name] && !previous?.[name]) added[name] = true
  const projects = wanted['tasks.start']?.projects,
    before = previous?.['tasks.start']?.projects
  if (projects !== undefined && before !== 'any') {
    if (projects === 'any') added['tasks.start'] = { projects }
    else {
      const addedProjects = projects.filter(id => !before?.includes(id))
      if (addedProjects.length) added['tasks.start'] = { projects: addedProjects }
    }
  }
  const storage = wanted.storage?.filter(scope => !previous?.storage?.includes(scope))
  if (storage?.length) added.storage = storage
  return added
}

export function reviewPluginPackage(
  { bundle, revision, executionHash }: Checked,
  source: PluginPackageReviewSource,
  installed?: RecordSource & Pick<PluginAssetRecord, 'appliedBundle' | 'approvedApps' | 'trusted'>,
  adoptsData?: true,
): PluginPackageReview {
  const { manifest, files } = bundle
  const hostModules = manifest.host ?? []
  const panels = (manifest.panels ?? []).map(({ id, title, entry, harnessIds, context }) => ({
    id,
    title,
    entry,
    ...(harnessIds ? { harnessIds } : {}),
    ...(context ? { context } : {}),
  }))
  const approved = installed?.approvedApps
  const running = installed?.appliedBundle ? capabilitySet(installed.appliedBundle.manifest) : undefined
  const pages = (manifest.apps ?? []).map(({ id, title, capabilities, dataVersion }) => {
    const previous = approved && Object.hasOwn(approved, id) ? approved[id] : undefined
    const added = newCapabilities(capabilities, previous)
    const sinceApplied = running ? newCapabilities(capabilities, Object.hasOwn(running, id) ? running[id] : undefined) : undefined
    return {
      id,
      title,
      capabilities,
      dataVersion,
      ...(previous ? { approved: previous } : {}),
      ...(Object.keys(added).length ? { addedCapabilities: added } : {}),
      ...(sinceApplied && Object.keys(sinceApplied).length ? { addedSinceApplied: sinceApplied } : {}),
    }
  })
  const findings: PluginPackageReview['findings'] = []
  const add = (kind: PluginPackageFindingKind, paths: string[]) => {
    if (paths.length) findings.push({ kind, files: [...new Set(paths.map(path => redactKnownSecrets(path)))].slice(0, 32) })
  }
  add('host-access', hostModules)
  add(
    'workbench-access',
    panels.map(panel => panel.entry),
  )
  add(
    'context-statistics',
    panels.filter(panel => panel.context).map(panel => panel.entry),
  )
  add(
    'agent-instructions',
    (manifest.skills ?? []).map(skill => skill.file),
  )
  const code = files.filter(file => /\.(?:[cm]?[jt]sx?)$/iu.test(file.path))
  for (const [kind, pattern] of codeObservations)
    add(
      kind,
      code.filter(file => pattern.test(file.content)).map(file => file.path),
    )
  add(
    'looks-like-secret',
    files.filter(file => containsSecret(file.content) || maskKnownSecrets(file.content) !== file.content).map(file => file.path),
  )
  const toolNames = new Set<string>()
  if (hostModules.length) {
    for (const file of code) {
      for (const match of file.content.matchAll(/\bregisterTool\s*\(\s*\{\s*name\s*:\s*(['"])([a-zA-Z0-9_-]{1,64})\1/gu)) {
        const name = match[2]!
        if (redactKnownSecrets(name) === name && toolNames.size < 32) toolNames.add(name)
      }
    }
  }
  const scopeFindings = [
    ['starts-sessions', 'tasks.start'],
    ['continues-sessions', 'tasks.continue'],
    ['reads-sessions', 'tasks.read'],
    ['reads-own-replies', 'tasks.readOwn'],
    ['writes-storage', 'storage'],
  ] as const
  for (const [kind, cap] of scopeFindings)
    add(
      kind,
      (manifest.apps ?? []).filter(app => app.capabilities[cap]).map(app => app.entry),
    )

  const old = installed?.appliedBundle && installed.appliedRevision !== revision ? checkedPluginBundle(installed.appliedBundle) : undefined
  const oldSource = old && installed ? pluginReviewSource(installed, old.revision) : undefined
  const set = capabilitySet(manifest)
  const diff = old
    ? {
        revision: old.revision,
        version: old.bundle.manifest.version,
        ...(oldSource ? { source: oldSource } : {}),
        changedSource: oldSource !== undefined && sourceIdentity(oldSource) !== sourceIdentity(source),
        manifestChanged: canonicalJson(manifest) !== canonicalJson(old.bundle.manifest),
        changedFiles: changedFiles(old.bundle.files, files),
        changedExecution: old.executionHash !== executionHash,
        expandedPageCapabilities: !withinApproved(set, running),
      }
    : undefined
  return {
    revision,
    version: manifest.version,
    source,
    baseAppliedRevision: installed?.appliedRevision ?? null,
    ...(executionHash ? { executionHash } : {}),
    hostModules,
    toolNames: [...toolNames],
    panels,
    pages,
    skills: (manifest.skills ?? []).map(({ id, name, file }) => ({ id, name, file })),
    dataPanels: (manifest.dataPanels ?? []).map(({ id, title }) => ({ id, title })),
    findings,
    ...(diff ? { comparison: diff } : {}),
    ...(adoptsData ? { adoptsData } : {}),
    confirmationRequired:
      (executionHash !== undefined && !installed?.trusted.includes(executionHash)) || !!adoptsData || !withinApproved(set, approved),
  }
}

function sourceIdentity(source: PluginPackageReviewSource): string {
  if (source.kind === 'npm') return JSON.stringify([source.kind, source.registry, source.name, source.modified === true])
  if (source.kind === 'catalog') return JSON.stringify([source.kind, source.modified === true])
  if (source.kind === 'external') return JSON.stringify([externalSourceIdentity(source), source.modified === true])
  return source.kind
}

function changedFiles(
  before: Checked['bundle']['files'],
  after: Checked['bundle']['files'],
): NonNullable<PluginPackageReview['comparison']>['changedFiles'] {
  const old = new Map(before.map(file => [file.path, file.content]))
  const current = new Map(after.map(file => [file.path, file.content]))
  const changes: NonNullable<PluginPackageReview['comparison']>['changedFiles'] = []
  for (const path of [...new Set([...old.keys(), ...current.keys()])].toSorted()) {
    if (old.get(path) === current.get(path)) continue
    changes.push({ path: redactKnownSecrets(path), change: !old.has(path) ? 'added' : !current.has(path) ? 'removed' : 'modified' })
  }
  return changes
}
