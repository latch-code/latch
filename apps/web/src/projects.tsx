import { BookOpen, Database, Folders, PenTool, Server, TestTubeDiagonal, Wrench } from 'lucide-react'
import type { HarnessInfo, ProjectGlyph, TaskSummary, WorkspaceFolder, WorkspaceInfo } from '@latch/protocol'
import { Icon, type IconComponent, CodeGlyph, FolderGlyph, GlobeGlyph, PhoneGlyph } from '@latch/ui'
import type { Brief } from './core/securityCopy.ts'
import { basename } from './format.ts'

export const PROJECT_ICONS: Record<ProjectGlyph, { label: string; icon: IconComponent }> = {
  folder: { label: '文件夹', icon: FolderGlyph },
  code: { label: '代码', icon: CodeGlyph },
  globe: { label: '网页', icon: GlobeGlyph },
  server: { label: '服务', icon: Server },
  smartphone: { label: '移动应用', icon: PhoneGlyph },
  'book-open': { label: '文档', icon: BookOpen },
  database: { label: '数据', icon: Database },
  'flask-conical': { label: '实验', icon: TestTubeDiagonal },
  'pen-tool': { label: '设计', icon: PenTool },
  wrench: { label: '工具', icon: Wrench },
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
    return support.max !== undefined && count > support.max
      ? `最多使用 ${support.max} 个文件夹，不能在这个项目中新建会话`
      : `使用全部 ${count} 个文件夹`
  if (support?.access === 'primary-asks') return '只使用主文件夹，访问其他文件夹前会询问你'
  if (support?.access === 'primary-unbounded') return '只收到主文件夹；它不限制可以访问的目录'
  return '只收到主文件夹'
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
    ? { label: `只用主文件夹「${primary}」`, detail: `${name} 访问其他文件夹前会询问你。` }
    : access === 'primary-unbounded'
      ? { label: `只收到主文件夹「${primary}」`, detail: `${name} 不限制可以访问的目录。` }
      : { label: `只能用主文件夹「${primary}」`, detail: `${name} 用不了这个项目的其他文件夹。` }
}
