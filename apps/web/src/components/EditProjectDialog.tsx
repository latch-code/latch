import { useState } from 'react'
import { FolderPlus } from 'lucide-react'
import {
  escapeSecurityText,
  PROJECT_GLYPHS,
  type AppSnapshot,
  type ProjectGlyph,
  type WorkspaceFolder,
  type WorkspaceInfo,
} from '@latch/protocol'
import {
  Badge,
  Button,
  CloseGlyph,
  ConfirmDialog,
  FolderGlyph,
  Icon,
  IconButton,
  InlineNotice,
  Menu,
  Modal,
  ModalHeader,
  Tooltip,
  UI_COPY,
  type MenuTriggerProps,
} from '@latch/ui'
import { useViewport } from '../breakpoints.ts'
import { api, errorMessage, MessageError } from '../core/api.ts'
import { defineCopy } from '../core/i18n.ts'
import { deviceAccess } from '../core/permissions.ts'
import { describeFailure } from '../core/securityCopy.ts'
import { currentShell, shellFolders } from '../core/shell.ts'
import { DELETION_COPY } from '../deletionCopy.ts'
import {
  folderInUse,
  projectInUse,
  PROJECT_EDIT_COPY,
  PROJECT_ICONS,
  projectFolderLabels,
  projectFolders,
  projectName,
} from '../projects.tsx'
import { VisibleText } from './VisibleText.tsx'

const COPY = defineCopy(
  {
    edit: '编辑项目',
    name: '项目名称',
    sources: '源文件夹',
    immediate: '文件夹的添加和移除立即生效。',
    removeFolder: (name: string) => `移除文件夹：${name}`,
    addOnHost: '添加文件夹请使用项目所在电脑的 Latch 桌面端。',
    changedFolder: '项目的文件夹已变化，请重新选择。',
  },
  {
    edit: 'Edit project',
    name: 'Project name',
    sources: 'Source folders',
    immediate: 'Folder additions and removals take effect immediately.',
    removeFolder: (name: string) => `Remove folder: ${name}`,
    addOnHost: 'Add folders in the Latch desktop app on the project’s computer.',
    changedFolder: 'The project’s folders have changed. Select the folder again.',
  },
)

function projectIconTrigger(glyph: ProjectGlyph, disabled: boolean) {
  return (trigger: MenuTriggerProps) => (
    <IconButton
      {...trigger}
      className="edit-project-icon"
      label={PROJECT_EDIT_COPY.projectIcon}
      icon={PROJECT_ICONS[glyph].icon}
      disabled={disabled}
    />
  )
}

export function EditProjectDialog({
  project,
  snapshot,
  canAddFolders,
  onChanged,
  onClose,
}: {
  project: WorkspaceInfo
  snapshot: AppSnapshot
  canAddFolders: boolean
  onChanged: () => void
  onClose: () => void
}) {
  const phone = useViewport() === 'phone'
  const owner = deviceAccess(snapshot, currentShell()).admin
  const shell = owner && canAddFolders ? shellFolders() : null
  const folders = projectFolders(project)
  const folderLabels = projectFolderLabels(folders)
  const active = projectInUse(project, snapshot)
  // Untouched fields follow other devices' edits and are omitted from the patch.
  const [nameDraft, setName] = useState<string>()
  const [glyphDraft, setGlyph] = useState<ProjectGlyph>()
  const name = nameDraft ?? projectName(project)
  const glyph = glyphDraft ?? project.glyph ?? 'folder'
  const [busy, setBusy] = useState<'pick' | 'save' | null>(null)
  const [problem, setProblem] = useState('')
  const [removing, setRemoving] = useState<(WorkspaceFolder & { label: string }) | 'project' | null>(null)
  const endpoint = `workspaces/${encodeURIComponent(project.id)}`
  const limit = snapshot.catalog?.projectFolders?.max ?? 8
  const removeReason = (folder: WorkspaceFolder) =>
    folders.length === 1
      ? PROJECT_EDIT_COPY.needsFolder
      : folderInUse(project, folder, snapshot)
        ? PROJECT_EDIT_COPY.folderInUse
        : undefined
  const close = () => {
    if (!busy) onClose()
  }

  async function save() {
    const nextName = name.trim()
    if (busy || !owner || !nextName) return
    const patch = {
      ...(nameDraft !== undefined && nextName !== projectName(project) ? { name: nextName } : {}),
      ...(glyphDraft !== undefined && glyphDraft !== (project.glyph ?? 'folder') ? { glyph: glyphDraft } : {}),
    }
    if (!Object.keys(patch).length) return onClose()
    setBusy('save')
    setProblem('')
    try {
      await api(endpoint, { method: 'PATCH', body: patch })
      onChanged()
      onClose()
    } catch (cause) {
      setProblem(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  async function pick() {
    if (!shell || busy || folders.length >= limit) return
    setBusy('pick')
    setProblem('')
    try {
      const result = await shell.pick(project.id)
      if (result.status === 'added') {
        onChanged()
        setProblem(
          result.refused
            .map(item => `${escapeSecurityText(item.path)} · ${describeFailure(item.status, item.code, { host: item.message })}`)
            .join('\n'),
        )
      } else if (result.status === 'busy') setProblem(PROJECT_EDIT_COPY.systemDialog)
      else if (result.status === 'failed') setProblem(describeFailure(0, result.code, { fallback: PROJECT_EDIT_COPY.folderActionFailed }))
    } catch (cause) {
      setProblem(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  async function remove(target: WorkspaceFolder | 'project') {
    if (!owner) return
    if (target === 'project') {
      if (active) throw new MessageError(PROJECT_EDIT_COPY.projectInUse)
      await api(endpoint, { method: 'DELETE' })
      onChanged()
      onClose()
      return
    }
    const folder = folders.find(item => item.id === target.id && item.path === target.path)
    if (!folder) throw new MessageError(COPY.changedFolder)
    const reason = removeReason(folder)
    if (reason) throw new MessageError(reason)
    await api(`${endpoint}/folders/${encodeURIComponent(folder.id)}`, { method: 'DELETE' })
    onChanged()
  }

  if (!owner || project.id === 'default') return null
  return (
    <>
      <Modal
        label={COPY.edit}
        size="lg"
        variant={phone ? 'sheet' : 'dialog'}
        className="edit-project-dialog"
        dismissible={!busy}
        onClose={close}>
        <form
          className="edit-project-form"
          onSubmit={event => {
            event.preventDefault()
            void save()
          }}>
          <ModalHeader title={COPY.edit} onClose={close} />
          <div className="ui-modal-body">
            <div className="edit-project-identity">
              <Menu
                label={PROJECT_EDIT_COPY.projectIcon}
                selection
                trigger={projectIconTrigger(glyph, !!busy)}
                sections={[
                  {
                    id: 'glyphs',
                    items: PROJECT_GLYPHS.map(value => ({
                      id: value,
                      label: PROJECT_ICONS[value].label,
                      media: <Icon icon={PROJECT_ICONS[value].icon} size={16} />,
                      checked: value === glyph,
                      onSelect: () => setGlyph(value),
                    })),
                  },
                ]}
              />
              <input
                className="edit-project-name"
                aria-label={COPY.name}
                data-autofocus=""
                maxLength={80}
                value={name}
                disabled={!!busy}
                autoComplete="off"
                onChange={event => setName(event.target.value)}
              />
            </div>
            <section className="edit-project-folders">
              <h3 className="edit-project-section-heading">{COPY.sources}</h3>
              <ul className="edit-project-folder-list" aria-label={COPY.sources}>
                {folders.map((folder, index) => {
                  const reason = removeReason(folder)
                  const label = folderLabels[index]!
                  return (
                    <li key={folder.id} className="edit-project-folder">
                      <Icon icon={FolderGlyph} size={16} />
                      <Tooltip
                        content={
                          <span className="edit-project-folder-path">
                            <VisibleText text={folder.path} />
                          </span>
                        }>
                        <span className="edit-project-folder-info" tabIndex={0}>
                          <span className="edit-project-folder-name">
                            <VisibleText text={label} />
                          </span>
                          {folder.unavailable && (
                            <small>
                              <VisibleText text={folder.unavailable} />
                            </small>
                          )}
                        </span>
                      </Tooltip>
                      {index === 0 && <Badge>{PROJECT_EDIT_COPY.main}</Badge>}
                      <IconButton
                        size="xs"
                        icon={CloseGlyph}
                        label={COPY.removeFolder(escapeSecurityText(label))}
                        tooltip={reason}
                        disabled={!!busy || !!reason}
                        onClick={() => setRemoving({ ...folder, label })}
                      />
                    </li>
                  )
                })}
              </ul>
              {shell && (
                <div className="edit-project-folder-actions">
                  <Button
                    variant="ghost"
                    icon={FolderPlus}
                    pending={busy === 'pick'}
                    disabled={!!busy || folders.length >= limit}
                    tooltip={folders.length >= limit ? PROJECT_EDIT_COPY.folderLimit : undefined}
                    onClick={() => void pick()}>
                    {PROJECT_EDIT_COPY.addFolder}
                  </Button>
                </div>
              )}
              <p className="edit-project-folder-note">{shell ? COPY.immediate : `${COPY.addOnHost} ${COPY.immediate}`}</p>
            </section>
            {problem && <InlineNotice tone="error">{problem}</InlineNotice>}
          </div>
          <footer className="ui-modal-footer edit-project-footer">
            <Button
              variant="danger"
              disabled={!!busy || active}
              tooltip={active ? PROJECT_EDIT_COPY.projectInUse : undefined}
              onClick={() => setRemoving('project')}>
              {PROJECT_EDIT_COPY.remove}
            </Button>
            <Button variant="ghost" disabled={!!busy} onClick={close}>
              {UI_COPY.cancel}
            </Button>
            <Button variant="primary" type="submit" pending={busy === 'save'} disabled={!!busy || !name.trim()}>
              {UI_COPY.save}
            </Button>
          </footer>
        </form>
      </Modal>
      {removing && (
        <ConfirmDialog
          title={
            removing === 'project'
              ? PROJECT_EDIT_COPY.confirmProject(escapeSecurityText(projectName(project)))
              : PROJECT_EDIT_COPY.confirmFolder(escapeSecurityText(removing.label))
          }
          message={removing === 'project' ? DELETION_COPY.projectRemoval : DELETION_COPY.folderRemoval}
          confirmLabel={removing === 'project' ? PROJECT_EDIT_COPY.remove : PROJECT_EDIT_COPY.removeConfirm}
          danger
          onClose={() => setRemoving(null)}
          onConfirm={() => remove(removing)}
        />
      )}
    </>
  )
}
