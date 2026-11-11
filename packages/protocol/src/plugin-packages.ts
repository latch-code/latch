import type { AppManifestEntry } from './apps.ts'
import type { UiPanelDocument } from './ui.ts'

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
  panels?: Array<{ id: string; title: string; description?: string; harnessIds?: string[]; entry: string }>
  /** Finite text data, without executing a Host or browser module. */
  dataPanels?: Array<{ id: string; title: string; description?: string; harnessIds?: string[]; document: UiPanelDocument }>
  /** Pages (format 2): isolated frames that reach the Host only through the capabilities listed here. */
  apps?: AppManifestEntry[]
}
export interface PluginPackageBundle {
  manifest: PluginPackageManifest
  files: Array<{ path: string; content: string }>
}
export interface PluginPackageSummary {
  id: string
  name: string
  version: string
  description: string
  revision: string
  appliedRevision?: string
  executionHash?: string
  enabled: boolean
  trusted: boolean
  capabilities: string[]
  unavailableReason?: string
  state: 'draft' | 'applied' | 'update-available'
  /** Earlier applied revisions a rollback can return to, newest first (format 2 Hosts). */
  rollbackRevisions?: Array<{ revision: string; version: string }>
}
export interface PluginPackageDetail extends PluginPackageSummary {
  bundle: PluginPackageBundle
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
