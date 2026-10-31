import { api, errorMessage } from '../core/api.ts'
import { setPreference } from '../preferences.ts'
import { currentShell } from '../core/shell.ts'
import { KeyboardHelp } from '../components/KeyboardHelp.tsx'
import { CommandPalette } from '../components/CommandPalette.tsx'
import { ConfirmDialog, PromptDialog } from '../components/overlays.tsx'
import { toolRowId } from '../conversation.ts'
import { Button, Toast } from '@latch/ui'
import { entrySection, settingsSections } from '../settings/SettingsPage.tsx'
import { PersonalPage } from '../personal/PersonalPage.tsx'
import type { ShellState } from './useShellLayout.tsx'

/** What opens over the shell: settings, personal assistants, the palette, dialogs and toasts. */
export function Overlays({ shell }: { shell: ShellState }) {
  const {
    privateVisible,
    route,
    setRoute,
    canPersonal,
    setPersonalDraft,
    personalGroupId,
    setPersonalGroupId,
    summary,
    composerRef,
    renaming,
    setRenaming,
    deleting,
    setDeleting,
    toast,
    setStopped,
    catalog,
    access,
    reading,
    submission,
    choose,
    approvalToast,
    setApprovalToast,
    nextApproval,
    exportTask,
    copyTask,
    phone,
    drawerMode,
    toggleSidebar,
    setInfoPage,
    setNewSheet,
    keyboardHelp,
    setKeyboardHelp,
    commandMode,
    commandOpen,
    setCommandOpen,
    setFindOpen,
    fileContext,
    fileTabs,
    canBrowseFiles,
    openFile,
    startNew,
    openSettings,
    openPersonal,
    openSearch,
    setColumnOpen,
    toggleInspector,
    selectSearchHit,
    startIn,
    browseFiles,
    searchFiles,
    harness,
    snapshot,
    selectedId,
    refresh,
  } = shell
  const section = entrySection(route, settingsSections(snapshot, access), phone)
  const onPage = route.entry !== 'sessions'
  /** A command for the open session, whose columns a page entry hides: it goes back to them to show its result. */
  const inSession = (run: () => void) => () => {
    setRoute({ entry: 'sessions' })
    run()
  }
  return (
    <>
      {canPersonal && (
        <PersonalPage
          key={privateVisible ? 'private' : 'restricted'}
          open={section === 'assistants' || section === 'routines'}
          area={section === 'routines' ? 'routines' : 'assistants'}
          initialGroupId={personalGroupId}
          canStart={!submission.pending && !submission.sending}
          snapshot={snapshot}
          access={access}
          refreshHint={harness.refreshHints + harness.resyncs}
          onClose={() => {
            setPersonalGroupId(undefined)
            setRoute({ entry: route.entry })
          }}
          onChanged={() => {
            void refresh()
          }}
          onSession={id => {
            setPersonalGroupId(undefined)
            choose(id)
          }}
          onGroupSession={(id, groupId) => {
            setPersonalGroupId(groupId)
            choose(id)
          }}
          onStart={assistant => {
            if (submission.pending || submission.sending) return
            choose(null)
            setPersonalDraft(assistant)
            submission.setFork(null)
            setRoute({ entry: 'sessions' })
            if (phone) setNewSheet(true)
            else requestAnimationFrame(() => composerRef.current?.focus())
          }}
        />
      )}
      {keyboardHelp && <KeyboardHelp onClose={() => setKeyboardHelp(false)} />}
      {commandOpen && (
        <CommandPalette
          snapshot={snapshot}
          mode={commandMode}
          fileContext={fileContext ?? undefined}
          onOpenFile={catalog?.features?.filePreview ? openFile : undefined}
          onSelect={choose}
          onSearchHit={selectSearchHit}
          onProject={startIn}
          onClose={() => setCommandOpen(false)}
          commands={[
            { id: 'new', label: '新建会话', shortcut: currentShell() ? '⌘N' : 'Alt N', run: startNew },
            { id: 'search', label: '搜索会话', run: openSearch },
            { id: 'settings', label: '打开设置', run: () => openSettings() },
            ...(drawerMode && onPage
              ? []
              : [{ id: 'sidebar', label: '展开或收起侧栏', shortcut: currentShell() ? '⌘B' : 'Alt B', run: toggleSidebar }]),
            ...(summary
              ? [
                  { id: 'info', label: '展开或收起会话信息', run: inSession(toggleInspector) },
                  { id: 'copy', label: '复制当前会话为 Markdown', run: () => void copyTask(summary) },
                  {
                    id: 'export',
                    label: '导出当前会话为 Markdown',
                    run: () => {
                      void exportTask(summary)
                    },
                  },
                ]
              : []),
            ...(canBrowseFiles
              ? [
                  { id: 'files', label: '浏览项目文件', shortcut: currentShell() ? '⇧⌘E' : 'Alt Shift E', run: inSession(browseFiles) },
                  ...(catalog?.features?.fileSearch
                    ? [{ id: 'file-search', label: '搜索项目文件', shortcut: currentShell() ? '⌘P' : 'Alt P', run: searchFiles }]
                    : []),
                ]
              : []),
            ...fileTabs.tabs.map(tab => ({
              id: 'file:' + tab.id,
              label: '切换文件：' + (tab.file?.name ?? tab.target.reference),
              run: inSession(() => {
                fileTabs.select(tab.id)
                setInfoPage(true)
                setColumnOpen(true)
              }),
            })),
            ...(['system', 'light', 'dark'] as const).map(theme => ({
              id: 'theme:' + theme,
              label: '外观：' + { system: '跟随系统', light: '浅色', dark: '深色' }[theme],
              run: () => setPreference('theme', theme),
            })),
            ...settingsSections(snapshot, access).map(section => ({
              id: 'settings:' + section,
              label:
                '设置：'
                + {
                  general: '通用',
                  computer: '电脑',
                  providers: '模型服务',
                  agents: 'Agent 成员',
                  workspaces: '项目',
                  plugins: '插件',
                  devices: '设备',
                  about: '关于',
                  assistants: '个人助手',
                  routines: '例行任务',
                }[section],
              run: () => openSettings(section),
            })),
            ...(openPersonal ? [{ id: 'personal', label: '打开个人助手', run: openPersonal }] : []),
            { id: 'keyboard', label: '键盘快捷键', shortcut: currentShell() ? '⌘/' : 'Alt /', run: () => setKeyboardHelp(true) },
            ...(selectedId ? [{ id: 'find', label: '在当前会话中查找', shortcut: '⌘F', run: inSession(() => setFindOpen(true)) }] : []),
            ...(snapshot.approvals.length ? [{ id: 'approval', label: '跳转到下一个待处理请求', run: nextApproval }] : []),
          ]}
        />
      )}
      {renaming && (
        <PromptDialog
          title="重命名会话"
          label="会话名称"
          initial={renaming.title}
          maxLength={120}
          onClose={() => {
            setRenaming(null)
          }}
          onSubmit={async title => {
            try {
              await api<unknown>(`tasks/${encodeURIComponent(renaming.id)}`, { method: 'PATCH', body: { title } })
            } catch (cause) {
              throw new Error(errorMessage(cause))
            }
            await refresh()
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="删除会话"
          danger
          confirmLabel="删除"
          message={`删除「${deleting.title || '未命名会话'}」及其全部记录？此操作无法撤销。`}
          onClose={() => {
            setDeleting(null)
          }}
          onConfirm={async () => {
            try {
              await api<unknown>(`tasks/${encodeURIComponent(deleting.id)}`, { method: 'DELETE' })
            } catch (cause) {
              throw new Error(errorMessage(cause))
            }
            setStopped(previous => {
              if (!previous.has(deleting.id)) return previous
              const next = new Map(previous)
              next.delete(deleting.id)
              return next
            })
            if (deleting.id === selectedId) choose(null)
            await refresh()
          }}
        />
      )}
      {approvalToast && (
        <Toast className="toast" duration={null}>
          <span>另一个会话有请求等你处理。</span>
          <Button
            variant="ghost"
            onClick={() => {
              choose(approvalToast.sessionId)
              const target = snapshot.approvals.find(item => item.id === approvalToast.id)
              if (target) reading.show(target.sessionId, toolRowId(target))
              setApprovalToast(null)
            }}>
            查看
          </Button>
        </Toast>
      )}
      {!approvalToast && toast && (
        <Toast className="toast" tone={toast.tone === 'error' ? 'error' : 'neutral'} duration={null}>
          {toast.text}
        </Toast>
      )}
    </>
  )
}
