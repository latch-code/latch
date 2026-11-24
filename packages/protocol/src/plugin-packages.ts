import type { AppCapabilities, AppManifestEntry } from './apps.ts'
import type { UiPanelDocument } from './ui.ts'

/** A Host-owned reminder delivered only in a session explicitly started for plugin creation. */
export const PLUGIN_CREATION_GUIDE =
  'Latch 创造模式。先用文件工具读取 latch-authoring/SKILL.md，按用户需求和本地示例做出可审阅的草稿。技能或工具包交付到 latch-plugin/，隔离页面交付到 latch-app/。编辑同一作品时保留其标识。应用或运行由用户确认。'

export type PluginJson = null | boolean | number | string | PluginJson[] | { [key: string]: PluginJson }
export interface PluginPackageManifest {
  /** 2 adds `apps`; 1 loads unchanged. */
  formatVersion: 1 | 2
  id: string
  name: string
  version: string
  description: string
  host?: string[]
  config?: Record<string, PluginJson>
  skills?: Array<{ id: string; name: string; description: string; file: string }>
  panels?: Array<{
    id: string
    title: string
    description?: string
    harnessIds?: string[]
    entry: string
    /** Opt in to read-only measurements of the current session in place of the usual panel props. */
    context?: true
  }>
  /** Finite text data, without executing a Host or browser module. */
  dataPanels?: Array<{ id: string; title: string; description?: string; harnessIds?: string[]; document: UiPanelDocument }>
  /** Pages (format 2): isolated frames that reach the Host only through the capabilities listed here. */
  apps?: AppManifestEntry[]
}
export interface PluginPackageBundle {
  manifest: PluginPackageManifest
  files: Array<{ path: string; content: string }>
}

export interface PluginNpmRelease {
  registry: string
  name: string
  version: string
  /** SHA-512 SRI of the compressed npm archive. */
  integrity: string
}

export interface PluginNpmRegistrySettings {
  registry: string | null
  revision: string
}

export interface PluginNpmRegistryUpdate {
  registry: string | null
  baseRegistry: string | null
  baseRevision: string
  requestId: string
}

export interface PluginNpmPreview {
  release: PluginNpmRelease
  revision: string
  bundle: PluginPackageBundle
  review: PluginPackageReview
  installed?: PluginMarketplaceInstallation
  updateAvailable?: boolean
}

export interface PluginNpmStage {
  requestId: string
  release: PluginNpmRelease
  revision: string
  update?: { pluginId: string; installId: string; baseRevision: string; replaceLocalDraft?: true }
}

export interface PluginMarketplaceInstallation {
  id: string
  installId: string
  revision: string
  version?: string
  modified: boolean
}

export type PluginCatalogUpdateStatus = 'available' | 'current' | 'older' | 'local-changes' | 'different-source' | 'same-version-changed'

export interface PluginCatalogPreview {
  bundle: PluginPackageBundle
  review: PluginPackageReview
  installed?: PluginMarketplaceInstallation
  updateAvailable?: boolean
  updateStatus?: PluginCatalogUpdateStatus
}

export interface PluginCatalogStage {
  requestId: string
  pluginId: string
  revision: string
  update?: { installId: string; baseRevision: string }
}

export type PluginExternalSource =
  | { kind: 'github'; repository: string; ref: string; commit: string }
  | { kind: 'local-folder'; directory: string }
  | { kind: 'local-bundle'; file: string }

export interface PluginExternalEntry {
  /** Package path within the source, empty for a single root package. */
  path: string
  id: string
  name: string
  version: string
  description: string
}

export interface PluginExternalRelease {
  source: PluginExternalSource
  pluginId: string
  path: string
  version: string
}

export interface PluginExternalFind {
  token: string
  source: PluginExternalSource
  packages: PluginExternalEntry[]
}

export interface PluginExternalPreview {
  token: string
  source: PluginExternalSource
  entry: PluginExternalEntry
  revision: string
  bundle: PluginPackageBundle
  review: PluginPackageReview
  installed?: PluginMarketplaceInstallation
  updateAvailable?: boolean
  updateStatus?: PluginCatalogUpdateStatus
}

export interface PluginExternalStage {
  requestId: string
  token: string
  revision: string
  update?: { installId: string; baseRevision: string }
}

export type PluginPackageReviewSource =
  | { kind: 'local' | 'creator' }
  | { kind: 'catalog'; version: string; modified?: true }
  | ({ kind: 'npm'; modified?: true } & PluginNpmRelease)
  | ({ kind: 'external'; modified?: true } & PluginExternalRelease)

export type PluginPackageFindingKind =
  | 'host-access'
  | 'workbench-access'
  | 'context-statistics'
  | 'file-access'
  | 'process-execution'
  | 'network-access'
  | 'environment-access'
  | 'browser-data-access'
  | 'dynamic-code'
  | 'tool-registration'
  | 'agent-instructions'
  | 'looks-like-secret'
  | 'starts-sessions'
  | 'continues-sessions'
  | 'reads-sessions'
  | 'reads-own-replies'
  | 'writes-storage'

/** A Host review of one canonical snapshot. Source observations are textual indicators of possible behavior. */
export interface PluginPackageReview {
  revision: string
  version: string
  source: PluginPackageReviewSource
  baseAppliedRevision: string | null
  /** The identity of the existing installation this review is about. */
  installId?: string
  executionHash?: string
  hostModules: string[]
  toolNames: string[]
  panels: Array<Pick<NonNullable<PluginPackageManifest['panels']>[number], 'id' | 'title' | 'entry' | 'harnessIds' | 'context'>>
  pages: Array<
    Pick<AppManifestEntry, 'id' | 'title' | 'capabilities' | 'dataVersion'> & {
      approved?: AppCapabilities
      addedCapabilities?: AppCapabilities
      addedSinceApplied?: AppCapabilities
    }
  >
  skills: Array<Pick<NonNullable<PluginPackageManifest['skills']>[number], 'id' | 'name' | 'file'>>
  dataPanels: Array<Pick<NonNullable<PluginPackageManifest['dataPanels']>[number], 'id' | 'title'>>
  findings: Array<{ kind: PluginPackageFindingKind; files?: string[] }>
  comparison?: {
    revision: string
    version: string
    source?: PluginPackageReviewSource
    changedSource: boolean
    manifestChanged: boolean
    changedFiles: Array<{ path: string; change: 'added' | 'modified' | 'removed' }>
    changedExecution: boolean
    expandedPageCapabilities: boolean
  }
  adoptsData?: true
  confirmationRequired: boolean
}

export interface PluginPackageSummary {
  id: string
  name: string
  version: string
  description: string
  revision: string
  appliedRevision?: string
  appliedVersion?: string
  executionHash?: string
  enabled: boolean
  trusted: boolean
  capabilities: string[]
  unavailableReason?: string
  state: 'draft' | 'applied' | 'update-available'
  /** Earlier applied revisions a rollback can return to, newest first (format 2 Hosts). */
  rollbackRevisions?: Array<{ revision: string; version: string }>
  /** The session the draft was imported from (`POST /plugin-packages/import`); `dev`: imported and built again after its turns. */
  source?: { sessionId: string; dev: boolean; kind?: 'plugin' }
  /** Where the last staged npm release came from, even if the draft was edited or an earlier release was applied. */
  npm?: PluginNpmRelease & { revision: string }
  /** The most recent exact release from the directory embedded in this Host build. */
  catalog?: { revision: string; version: string }
  /** The last staged GitHub or local release; later edits keep its original provenance. */
  external?: PluginExternalRelease & { revision: string }
  catalogUpdate?: { version: string; status: PluginCatalogUpdateStatus }
  /** The pages the draft declares. */
  pages?: number
  /** The latest build of the draft revision, without its diagnostics' text (`GET /plugin-packages/:id/build`). */
  build?: Omit<PluginBuild, 'diagnostics'> & { diagnostics: number }
  /** The newest successful build of the draft, which its preview loads (`GET /plugin-packages/:id/builds/:bundleHash.js`). */
  preview?: { revision: string; modules: PluginBuild['modules'] }
}

/** One message of a build: `esbuild` bundling (syntax, imports), `tsc` the type check, `build` the build itself. */
export interface PluginBuildDiagnostic {
  tool: 'esbuild' | 'tsc' | 'build'
  file?: string
  line?: number
  column?: number
  message: string
}

/** A page draft's build with the Host's fixed tools; `modules` are the pages' bundles of a successful one. */
export interface PluginBuild {
  id: string
  revision: string
  status: 'ok' | 'failed' | 'timeout'
  at: string
  durationMs: number
  /** Whether the TypeScript check ran. */
  typeChecked: boolean
  diagnostics: PluginBuildDiagnostic[]
  modules: Array<{ appId: string; bundleHash: string; bytes: number }>
}
export interface PluginPackageDetail extends PluginPackageSummary {
  bundle: PluginPackageBundle
  review: PluginPackageReview
}

/** Ready-to-use local examples. All execution stays behind explicit application and its trust decision. */
export function createPluginPackageTemplate(kind: 'skill' | 'tool' | 'react-ui', id = 'my-plugin', name = '我的插件'): PluginPackageBundle {
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(id) || !name.trim() || name.length > 80) throw new TypeError('Invalid plugin identity')
  const manifest: PluginPackageManifest = {
    formatVersion: 1,
    id,
    name,
    version: '1.0.0',
    description: '为自己的工作组合技能、工具与界面。',
  }
  if (kind === 'skill')
    return {
      manifest: {
        ...manifest,
        skills: [{ id: 'guide', name: '工作方法', description: '按自己的方法整理输入并给出下一步。', file: 'SKILL.md' }],
        dataPanels: [
          {
            id: 'overview',
            title: '工作方法',
            document: { blocks: [{ type: 'text', text: '先说明目标、约束和可用资料，再让 Agent 按技能完成工作。' }] },
          },
        ],
      },
      files: [{ path: 'SKILL.md', content: '# 工作方法\n\n先理解用户的目标和约束。按可核对的事实给出建议，缺少依据时明确说明。\n' }],
    }
  if (kind === 'tool')
    return {
      manifest: { ...manifest, host: ['host.mjs'] },
      files: [
        {
          path: 'host.mjs',
          content: `export default {
  activate(ctx) {
    ctx.registerTool({
      name: '${id.slice(0, 48).replaceAll('-', '_')}_uppercase', title: '转换为大写', description: 'Convert supplied text to uppercase.',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
      requiresApproval: true,
      async execute(input, { signal }) {
        signal.throwIfAborted()
        if (typeof input.text !== 'string' || input.text.length > 65536 || Object.keys(input).some(key => key !== 'text')) throw new Error('Invalid input')
        return { text: input.text.toUpperCase() }
      },
    })
  },
}\n`,
        },
      ],
    }
  return {
    manifest: { ...manifest, panels: [{ id: 'notes', title: '工作笔记', entry: 'panel.mjs' }] },
    files: [
      {
        path: 'panel.mjs',
        content: `export default function Notes({ react, ui, compose, canCompose }) {
  const [text, setText] = react.useState('')
  return react.createElement('div', null,
    react.createElement(ui.TextAreaField, { label: '工作笔记', value: text, onChange: event => setText(event.target.value) }),
    react.createElement(ui.Button, { disabled: !canCompose || !text.trim(), onClick: () => compose(text) }, '添加到输入框'))
}\n`,
      },
    ],
  }
}
