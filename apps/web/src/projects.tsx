import { BookOpen, Database, Folders, PenTool, Server, TestTubeDiagonal, Wrench } from 'lucide-react'
import type { HarnessInfo, ProjectGlyph, TaskSummary, WorkspaceFolder, WorkspaceInfo } from '@latch/protocol'
import { Icon, type IconComponent, CodeGlyph, FolderGlyph, GlobeGlyph, PhoneGlyph } from '@latch/ui'
import type { Brief } from './core/securityCopy.ts'
import { basename } from './format.ts'
import { defineCopy } from './core/i18n.ts'

const COPY = defineCopy(
  {
    folder: '文件夹',
    code: '代码',
    web: '网页',
    service: '服务',
    mobile: '移动应用',
    docs: '文档',
    data: '数据',
    experiment: '实验',
    design: '设计',
    tools: '工具',
    maxFolders: (max: number) => `最多使用 ${max} 个文件夹，不能在这个项目中新建会话`,
    allFolders: (count: number) => `使用全部 ${count} 个文件夹`,
    asks: '只使用主文件夹，访问其他文件夹前会询问你',
    unbounded: '只收到主文件夹；它不限制可以访问的目录',
    primary: '只收到主文件夹',
    primaryUse: (folder: string) => `只用主文件夹「${folder}」`,
    asksDetail: (harness: string) => `${harness} 访问其他文件夹前会询问你。`,
    primaryGiven: (folder: string) => `只收到主文件夹「${folder}」`,
    unboundedDetail: (harness: string) => `${harness} 不限制可以访问的目录。`,
    primaryOnly: (folder: string) => `只能用主文件夹「${folder}」`,
    primaryDetail: (harness: string) => `${harness} 用不了这个项目的其他文件夹。`,
  },
  {
    folder: 'Folder',
    code: 'Code',
    web: 'Web page',
    service: 'Service',
    mobile: 'Mobile app',
    docs: 'Documentation',
    data: 'Data',
    experiment: 'Experiment',
    design: 'Design',
    tools: 'Tools',
    maxFolders: (max: number) => `Can use up to ${max} folders. A new session can’t start in this project.`,
    allFolders: (count: number) => `Uses all ${count} folders`,
    asks: 'Uses the main folder and asks before accessing other folders',
    unbounded: 'Receives only the main folder and can access other directories',
    primary: 'Receives only the main folder',
    primaryUse: (folder: string) => `Uses only the main folder “${folder}”`,
    asksDetail: (harness: string) => `${harness} will ask before accessing other folders.`,
    primaryGiven: (folder: string) => `Receives only the main folder “${folder}”`,
    unboundedDetail: (harness: string) => `${harness} doesn’t restrict which directories can be accessed.`,
    primaryOnly: (folder: string) => `Can use only the main folder “${folder}”`,
    primaryDetail: (harness: string) => `${harness} can’t use the other folders in this project.`,
  },
)

export const PROJECT_ICONS: Record<ProjectGlyph, { label: string; icon: IconComponent }> = {
  folder: {
    get label() {
      return COPY.folder
    },
    icon: FolderGlyph,
  },
  code: {
    get label() {
      return COPY.code
    },
    icon: CodeGlyph,
  },
  globe: {
    get label() {
      return COPY.web
    },
    icon: GlobeGlyph,
  },
  server: {
    get label() {
      return COPY.service
    },
    icon: Server,
  },
  smartphone: {
    get label() {
      return COPY.mobile
    },
    icon: PhoneGlyph,
  },
  'book-open': {
    get label() {
      return COPY.docs
    },
    icon: BookOpen,
  },
  database: {
    get label() {
      return COPY.data
    },
    icon: Database,
  },
  'flask-conical': {
    get label() {
      return COPY.experiment
    },
    icon: TestTubeDiagonal,
  },
  'pen-tool': {
    get label() {
      return COPY.design
    },
    icon: PenTool,
  },
  wrench: {
    get label() {
      return COPY.tools
    },
    icon: Wrench,
  },
}

export const projectFolders = (project: WorkspaceInfo): WorkspaceFolder[] =>
  project.folders?.length ? project.folders : [{ id: 'default', path: project.path }]
export const projectName = (project: WorkspaceInfo) => project.name || basename(project.path)

export function ProjectIcon({
  project,
  size = 16,
  className,
}: {
  project: WorkspaceInfo
  size?: 12 | 14 | 16 | 20 | 24
  className?: string
}) {
  return (
    <Icon
      icon={
        project.glyph ? (PROJECT_ICONS[project.glyph]?.icon ?? FolderGlyph) : projectFolders(project).length > 1 ? Folders : FolderGlyph
      }
      size={size}
      className={className}
    />
  )
}

export function folderAccessText(harness: Pick<HarnessInfo, 'projectFolders'>, count: number): string {
  const support = harness.projectFolders
  if (support?.access === 'all')
    return support.max !== undefined && count > support.max ? COPY.maxFolders(support.max) : COPY.allFolders(count)
  if (support?.access === 'primary-asks') return COPY.asks
  if (support?.access === 'primary-unbounded') return COPY.unbounded
  return COPY.primary
}

/** A count describes membership; it never changes the settings navigation. */
export function projectSessionCount(project: WorkspaceInfo, tasks: readonly TaskSummary[]): number {
  const paths = new Set(projectFolders(project).map(folder => folder.path))
  return tasks.filter(
    task =>
      task.workspaceId === project.id
      || ((task.workspaceId === undefined || task.workspaceId === 'default') && task.cwd !== undefined && paths.has(task.cwd)),
  ).length
}

/**
 * The selected driver's actual multi-folder support before a session starts: the folder it gets, and behind ⓘ what it
 * does past it (a Harness that does not limit itself must not read as limited).
 */
export function projectScopeCaption(project: WorkspaceInfo | undefined, harness: HarnessInfo | undefined): Brief | undefined {
  if (!project || !harness || projectFolders(project).length < 2 || harness.projectFolders?.access === 'all') return undefined
  const primary = basename(project.path)
  const name = harness.capabilities.display.label
  const access = harness.projectFolders?.access
  return access === 'primary-asks'
    ? { label: COPY.primaryUse(primary), detail: COPY.asksDetail(name) }
    : access === 'primary-unbounded'
      ? { label: COPY.primaryGiven(primary), detail: COPY.unboundedDetail(name) }
      : { label: COPY.primaryOnly(primary), detail: COPY.primaryDetail(name) }
}
