import { useState } from 'react'
import type { AppSnapshot, McpImportCandidate, McpImportFile, McpImportResponse, McpImportSkip } from '@latch/protocol'
import { Button, Dialog, GlobeGlyph, InlineNotice, TerminalGlyph } from '@latch/ui'
import { api, inlineError } from '../core/api.ts'
import { IconTile, Loading, MiddleEllipsis, ObjectRow, SettingsGroup, SettingsRow } from './common.tsx'
import { defineCopy } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    fromProject: '从项目导入',
    changeProject: '换一个项目',
    cancel: '取消',
    noProjects: '还没有项目',
    projectNoManifest: '这个项目没有 .mcp.json',
    missingManifest: '没有 .mcp.json',
    noServers: '没有 MCP 服务器',
    limit: '只列出前 32 个',
    from: (project: string) => `从 ${project} 导入`,
    read: (project: string) => `读取 ${project} 的 .mcp.json`,
    import: (name: string) => `导入 ${name}`,
  },
  {
    fromProject: 'Import from project',
    changeProject: 'Change project',
    cancel: 'Cancel',
    noProjects: 'No projects yet',
    projectNoManifest: 'This project has no .mcp.json',
    missingManifest: 'No .mcp.json',
    noServers: 'No MCP servers',
    limit: 'Showing the first 32',
    from: (project: string) => `Import from ${project}`,
    read: (project: string) => `Read .mcp.json from ${project}`,
    import: (name: string) => `Import ${name}`,
  },
)

/** What 添加 is filled with from one server of a project's `.mcp.json`: secret values left for the person to type. */
export interface ImportedForm {
  transport: 'stdio' | 'http'
  name: string
  command: string
  /** One per line, as the form keeps them. */
  args: string
  env: Array<{ key: string; value: string; secret: boolean }>
  url: string
  headers: Array<{ key: string; value: string }>
}

export function importedForm(candidate: McpImportCandidate): ImportedForm {
  return {
    transport: candidate.transport,
    name: candidate.name,
    command: candidate.command ?? '',
    args: (candidate.args ?? []).join('\n'),
    env: (candidate.env ?? []).map(item => ({ key: item.name, value: item.secret ? '' : (item.value ?? ''), secret: item.secret })),
    url: candidate.url ?? '',
    headers: (candidate.headers ?? []).map(key => ({ key, value: '' })),
  }
}

const FLAG_TEXT = defineCopy<Record<McpImportCandidate['flags'][number], string>>(
  {
    expansion: '含 ${…}：按原样显示，不展开',
    'repository-command': '命令在项目里：不能添加',
    'repository-path': '参数指向项目里的文件：测试会拒绝',
    secret: '像秘密的值已留空：请作为秘密变量填写',
  },
  {
    expansion: 'Contains ${…}. Shown as written without expansion.',
    'repository-command': 'This command is in the project and cannot be added.',
    'repository-path': 'Arguments refer to files in the project. The test will refuse them.',
    secret: 'Likely secrets are blank. Enter them as secret variables.',
  },
)
const SKIP_TEXT = defineCopy<Record<McpImportSkip, string>>(
  {
    'legacy-sse': '旧的 HTTP+SSE 传输尚未实现',
    unsupported: '不支持的类型',
    invalid: '格式不对',
  },
  {
    'legacy-sse': 'Legacy HTTP+SSE transport is not implemented yet',
    unsupported: 'Unsupported type',
    invalid: 'Invalid format',
  },
)
const FILE_TEXT = defineCopy<Record<NonNullable<McpImportFile['reason']>, string>>(
  {
    'not-file': '.mcp.json 不是普通文件',
    'too-large': '.mcp.json 超过 64 KiB',
    'not-json': '.mcp.json 不是 JSON',
    invalid: '.mcp.json 的格式不对',
  },
  {
    'not-file': '.mcp.json is not a regular file',
    'too-large': '.mcp.json exceeds 64 KiB',
    'not-json': '.mcp.json is not valid JSON',
    invalid: '.mcp.json has an invalid structure',
  },
)

export function candidateLine(candidate: McpImportCandidate): string {
  return candidate.transport === 'http' ? (candidate.url ?? '') : [candidate.command ?? '', ...(candidate.args ?? [])].join(' ')
}

const folderName = (path: string) => path.split('/').filter(Boolean).at(-1) ?? path

/** 从项目导入…: a project, then one server of its `.mcp.json`. Reading runs nothing. */
export function ImportDialog({
  open,
  snapshot,
  onPick,
  onClose,
}: {
  open: boolean
  snapshot: Pick<AppSnapshot, 'catalog'>
  onPick: (candidate: McpImportCandidate, workspaceId: string) => void
  onClose: () => void
}) {
  const [project, setProject] = useState<string | null>(null)
  const [read, setRead] = useState<McpImportResponse | null>(null)
  const [error, setError] = useState('')
  const projects = (snapshot.catalog?.workspaces ?? []).filter(item => item.id !== 'default')
  const close = () => {
    setProject(null)
    setRead(null)
    setError('')
    onClose()
  }
  const choose = async (id: string) => {
    setProject(id)
    setRead(null)
    setError('')
    try {
      setRead(await api<McpImportResponse>(`mcp/import?project=${encodeURIComponent(id)}`))
    } catch (cause) {
      setError(inlineError(cause))
    }
  }
  const chosen = projects.find(item => item.id === project)
  const several = (chosen?.folders?.length ?? 0) > 1
  const found = read?.files.some(file => file.servers.length > 0 || file.skipped.length > 0) ?? false
  return (
    <Dialog
      open={open}
      size="lg"
      title={chosen ? COPY.from(chosen.name) : COPY.fromProject}
      onClose={close}
      footer={
        <>
          {project !== null && (
            <Button
              size="md"
              onClick={() => {
                setProject(null)
                setRead(null)
                setError('')
              }}>
              {COPY.changeProject}
            </Button>
          )}
          <Button size="md" onClick={close}>
            {COPY.cancel}
          </Button>
        </>
      }>
      <div className="settings-form mcp-import">
        {project === null && (
          <SettingsGroup>
            {projects.length === 0 && <SettingsRow title={COPY.noProjects} />}
            {projects.map(item => (
              <ObjectRow
                key={item.id}
                title={item.name}
                description={<MiddleEllipsis text={item.path} className="settings-mono" />}
                label={COPY.read(item.name)}
                onOpen={() => {
                  void choose(item.id)
                }}
              />
            ))}
          </SettingsGroup>
        )}
        {project !== null && error && <InlineNotice tone="error">{error}</InlineNotice>}
        {project !== null && !error && !read && <Loading />}
        {read && !found && read.files.every(file => file.status === 'missing') && (
          <SettingsGroup>
            <SettingsRow title={COPY.projectNoManifest} />
          </SettingsGroup>
        )}
        {read?.files.map(file => {
          const folder = chosen?.folders?.find(item => item.id === file.folderId)
          if (file.status === 'missing' && !several) return null
          return (
            <SettingsGroup key={file.folderId} title={several && folder ? folderName(folder.path) : undefined}>
              {file.status === 'missing' && <SettingsRow dim title={COPY.missingManifest} />}
              {file.status === 'refused' && file.reason && <InlineNotice tone="error">{FILE_TEXT[file.reason]}</InlineNotice>}
              {file.status === 'ok' && file.servers.length === 0 && file.skipped.length === 0 && <SettingsRow title={COPY.noServers} />}
              {file.servers.map(candidate => {
                const blocked = candidate.flags.includes('repository-command')
                return (
                  <div key={candidate.key} data-mcp-import={candidate.key}>
                    <ObjectRow
                      leading={<IconTile icon={candidate.transport === 'http' ? GlobeGlyph : TerminalGlyph} />}
                      title={candidate.key}
                      description={<MiddleEllipsis text={candidateLine(candidate)} className="settings-mono" />}
                      dim={blocked}
                      label={COPY.import(candidate.key)}
                      {...(blocked
                        ? {}
                        : {
                            onOpen: () => {
                              onPick(candidate, project!)
                              close()
                            },
                          })}
                    />
                    {candidate.flags.map(flag => (
                      <InlineNotice key={flag} tone="warn">
                        {FLAG_TEXT[flag]}
                      </InlineNotice>
                    ))}
                  </div>
                )
              })}
              {file.skipped.map(skip => (
                <SettingsRow key={`skip:${skip.key}`} dim title={skip.key} description={SKIP_TEXT[skip.reason]} />
              ))}
              {file.truncated && <SettingsRow dim title={COPY.limit} />}
            </SettingsGroup>
          )
        })}
      </div>
    </Dialog>
  )
}
