import { useRef, useState, type ReactNode } from 'react'

import {
  AGENT_FILE_BYTES,
  type AgentExportPreview,
  type AgentImportPreview,
  type AgentImportResult,
  type CustomAgent,
} from '@latch/protocol'
import { Button, DownloadGlyph, Hint, InlineNotice, Loading, StatusWord } from '@latch/ui'
import { VisibleText } from '../components/VisibleText.tsx'
import { api, ApiError } from '../core/api.ts'
import { AgentAvatar } from './AgentAvatar.tsx'
import { WriteNotice } from './AgentForm.tsx'
import { scheduleWords } from './model.ts'
import { exportFileName, fileMemoryWords, readAgentFileText } from './transfer.ts'
import { writeFor, type AgentWrites, type WriteState } from './useAgentWrites.ts'
import { CONNECTION_COPY } from '../core/hostState.ts'
import { defineCopy, formatNumber, plural } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    confirmExport: '导出前确认',
    memory: '记忆',
    scheduledSummary: '· 定时',
    redacted: (memories: number, schedules: number) =>
      `像密钥的不导出：记忆 ${formatNumber(memories)} 条，定时 ${formatNumber(schedules)} 个`,
    download: '下载',
    cancel: '取消',
    exportReadFailed: '没有读到要导出的内容，请重试。',
    exportFailed: '没有导出，请重试。',
    export: '导出',
    exportDetail: '一个文件：名称、职责、指令、头像样式、已保存的记忆和定时。不含模型、项目、技能、密钥和话题。',
    exported: '已导出',
    notExported: '没有导出',
    notHere: '这台电脑上没有',
    readFailed: '读不了这个文件，请重试。',
    chooseExport: '选择 Agent 导出文件',
    chooseAnother: '换一个文件',
    chooseFile: '选择文件',
    importTitle: '导入 Agent',
    newFromFile: '从导出的文件新建一个 Agent',
    importPreview: '先看到文件里有什么，再决定导入。不会改动已有的 Agent。',
    reading: '正在读取',
    cannotImport: '不能导入',
    sameName: '已有同名，会新建一个',
    file: '文件',
    instructions: '指令',
    noInstructions: '没有指令',
    memoryCount: '记忆 ·',
    markedAsImport: '标为「导入」',
    importedReference: '导入的记忆作为资料带给 Agent，不算你说的话；之后在「记忆」里点「设为我说的」，它才算你的。',
    redactedMemories: (count: number) => `${formatNumber(count)} 条像密钥的记忆没有随文件导出`,
    harnessUnavailable: (name: string) => `${name} 现在不可用`,
    external: '来自外部内容',
    scheduled: '定时',
    scheduleCount: '定时 ·',
    startsOff: '导入后是关的',
    noScheduleSupport: '这个 Harness 不能定时，不会导入',
    import: '导入',
  },
  {
    confirmExport: 'Confirm export',
    memory: 'Memory',
    scheduledSummary: '· Schedules',
    redacted: (memories: number, schedules: number) =>
      `Skipped possible secrets in ${plural(memories, { one: '{n} memory', other: '{n} memories' })} and ${plural(schedules, { one: '{n} schedule', other: '{n} schedules' })}`,
    download: 'Download',
    cancel: 'Cancel',
    exportReadFailed: 'Couldn’t load the export. Try again.',
    exportFailed: 'Couldn’t export. Try again.',
    export: 'Export',
    exportDetail:
      'One file with the name, role, instructions, avatar style, saved memories, and schedules. Models, projects, skills, keys, and topics are excluded.',
    exported: 'Exported',
    notExported: 'Export failed',
    notHere: 'Unavailable on this computer',
    readFailed: 'Couldn’t read this file. Try again.',
    chooseExport: 'Choose an Agent export file',
    chooseAnother: 'Choose another file',
    chooseFile: 'Choose file',
    importTitle: 'Import Agent',
    newFromFile: 'Create an Agent from an export',
    importPreview: 'Review the file before importing it as a new Agent. Existing Agents are kept.',
    reading: 'Reading',
    cannotImport: 'Can’t import',
    sameName: 'An Agent has this name. Importing creates a new one.',
    file: 'File',
    instructions: 'Instructions',
    noInstructions: 'No instructions',
    memoryCount: 'Memories ·',
    markedAsImport: 'Marked as imported',
    importedReference:
      'Imported memories reach the Agent as reference material. In Memory, choose Mark as my words to attribute them to you.',
    redactedMemories: (count: number) =>
      plural(count, {
        one: 'Skipped {n} memory that appeared to contain a key',
        other: 'Skipped {n} memories that appeared to contain keys',
      }),
    harnessUnavailable: (name: string) => `${name} is unavailable right now`,
    external: 'From external content',
    scheduled: 'Schedules',
    scheduleCount: 'Schedules ·',
    startsOff: 'Disabled on import',
    noScheduleSupport: 'This Harness cannot schedule tasks, so those entries are skipped',
    import: 'Import',
  },
)

const failure = (error: unknown, fallback: string) => (error instanceof ApiError ? error.message : fallback)

type ExportState =
  | { phase: 'idle' }
  | { phase: 'reading' }
  | { phase: 'shown'; preview: AgentExportPreview }
  | { phase: 'working'; preview: AgentExportPreview }
  | { phase: 'done' }
  | { phase: 'failed'; message: string }

/** What the file would hold and leave out, before anything is downloaded. */
export function ExportPreview({
  preview,
  working,
  offline,
  onDownload,
  onCancel,
}: {
  preview: AgentExportPreview
  working: boolean
  offline: boolean
  onDownload: () => void
  onCancel: () => void
}) {
  const { omitted } = preview
  return (
    <div className="agent-export-preview" role="group" aria-label={COPY.confirmExport}>
      <span>
        {COPY.memory} {formatNumber(preview.memories)} {COPY.scheduledSummary} {formatNumber(preview.schedules)}
      </span>
      {omitted.secretMemories + omitted.secretSchedules > 0 && (
        <StatusWord tone="warn">{COPY.redacted(omitted.secretMemories, omitted.secretSchedules)}</StatusWord>
      )}
      <div className="agent-form-actions">
        <Button variant="primary" icon={DownloadGlyph} loading={working} disabled={offline || working} onClick={onDownload}>
          {COPY.download}
        </Button>
        <Button variant="ghost" disabled={working} onClick={onCancel}>
          {COPY.cancel}
        </Button>
      </div>
    </div>
  )
}

/**
 * 导出, in an Agent's 设置: first what the file would hold and what it leaves out; then, if the person goes on, the Host
 * writes the file and this device saves it. Nothing is shown as exported until the Host answered with the file.
 */
export function AgentExport({ agent, offline }: { agent: Pick<CustomAgent, 'id' | 'name'>; offline: boolean }) {
  const [state, setState] = useState<ExportState>({ phase: 'idle' })
  const look = async () => {
    setState({ phase: 'reading' })
    try {
      setState({ phase: 'shown', preview: await api<AgentExportPreview>(`custom-agents/${agent.id}/export/preview`) })
    } catch (error) {
      setState({ phase: 'failed', message: failure(error, COPY.exportReadFailed) })
    }
  }
  const download = async (preview: AgentExportPreview) => {
    setState({ phase: 'working', preview })
    try {
      const bytes = await api<ArrayBuffer>(`custom-agents/${agent.id}/export`, { response: 'bytes' })
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/json' }))
      const link = document.createElement('a')
      link.href = url
      link.download = exportFileName(agent.name)
      link.click()
      setTimeout(() => {
        URL.revokeObjectURL(url)
      }, 1000)
      setState({ phase: 'done' })
    } catch (error) {
      setState({ phase: 'failed', message: failure(error, COPY.exportFailed) })
    }
  }
  const open = state.phase === 'shown' || state.phase === 'working'
  return (
    <section className="agent-form-section agent-export" aria-label={COPY.export}>
      <header>
        <Hint label={COPY.export}>{COPY.exportDetail}</Hint>
        {!open && (
          <Button
            icon={DownloadGlyph}
            loading={state.phase === 'reading'}
            disabled={offline || state.phase === 'reading'}
            title={offline ? CONNECTION_COPY.offline : undefined}
            onClick={() => void look()}>
            {COPY.export}
          </Button>
        )}
      </header>
      {open && (
        <ExportPreview
          preview={state.preview}
          working={state.phase === 'working'}
          offline={offline}
          onDownload={() => void download(state.preview)}
          onCancel={() => {
            setState({ phase: 'idle' })
          }}
        />
      )}
      {state.phase === 'done' && (
        <StatusWord tone="done" role="status">
          {COPY.exported}
        </StatusWord>
      )}
      {state.phase === 'failed' && (
        <InlineNotice tone="error" title={COPY.notExported}>
          {state.message}
        </InlineNotice>
      )}
    </section>
  )
}

type Chosen =
  | { phase: 'choose'; problem?: string }
  | { phase: 'reading'; name: string }
  | { phase: 'shown'; name: string; file: unknown; preview: AgentImportPreview }

/** Why this file cannot become an Agent here, when it cannot. */
function harnessProblem(harness: AgentImportPreview['harness']) {
  if (harness.ready) return null
  return (
    <StatusWord tone="failed">
      {harness.label ? (
        COPY.harnessUnavailable(harness.label)
      ) : (
        <>
          {COPY.notHere} <VisibleText text={harness.id} />
        </>
      )}
    </StatusWord>
  )
}

/**
 * 导入: choose a file, see exactly what the Host read from it, then create. Always a new Agent; its memories are marked
 * 导入 and its schedules arrive switched off. The create is one write: a result that stays unknown is retried as the
 * same request.
 */
export function AgentImport({
  writes,
  offline,
  onImported,
  onCancel,
}: {
  writes: AgentWrites
  offline: boolean
  onImported: (agent: CustomAgent) => void
  onCancel: () => void
}) {
  const [chosen, setChosen] = useState<Chosen>({ phase: 'choose' })
  const input = useRef<HTMLInputElement>(null)
  const write = writeFor(writes.state, 'agent:import')
  const saving = write !== null && 'phase' in write && write.phase === 'saving'
  const pick = async (picked: File | undefined) => {
    if (!picked) return
    writes.clear()
    const read = readAgentFileText(picked.size > AGENT_FILE_BYTES ? '' : await picked.text().catch(() => ''), picked.size)
    if ('problem' in read) {
      setChosen({ phase: 'choose', problem: read.problem })
      return
    }
    setChosen({ phase: 'reading', name: picked.name })
    try {
      const preview = await api<AgentImportPreview>('custom-agents/import/preview', { method: 'POST', body: { file: read.file } })
      setChosen({ phase: 'shown', name: picked.name, file: read.file, preview })
    } catch (error) {
      setChosen({ phase: 'choose', problem: failure(error, COPY.readFailed) })
    }
  }
  const create = async (file: unknown) => {
    const result = await writes.run<AgentImportResult>('agent:import', 'custom-agents/import', 'POST', { file })
    if (result) onImported(result.agent)
  }
  const retry = async () => {
    const result = await writes.retry<AgentImportResult>()
    if (result) onImported(result.agent)
  }
  const chooser = (
    <>
      <input
        ref={input}
        type="file"
        accept=".json,application/json"
        hidden
        aria-label={COPY.chooseExport}
        onChange={event => {
          const picked = event.target.files?.[0]
          event.target.value = ''
          void pick(picked)
        }}
      />
      <Button
        variant={chosen.phase === 'shown' ? 'secondary' : 'primary'}
        disabled={offline || chosen.phase === 'reading' || saving || writes.held}
        title={offline ? CONNECTION_COPY.offline : undefined}
        onClick={() => input.current?.click()}>
        {chosen.phase === 'shown' ? COPY.chooseAnother : COPY.chooseFile}
      </Button>
    </>
  )
  if (chosen.phase !== 'shown')
    return (
      <div className="agent-page agent-import">
        <h1 className="settings-title">{COPY.importTitle}</h1>
        <Hint label={COPY.newFromFile}>{COPY.importPreview}</Hint>
        {chosen.phase === 'reading' && <Loading label={COPY.reading} />}
        {chosen.phase === 'choose' && chosen.problem && (
          <InlineNotice tone="error" title={COPY.cannotImport}>
            {chosen.problem}
          </InlineNotice>
        )}
        <div className="agent-form-actions">
          {chooser}
          <Button variant="ghost" onClick={onCancel}>
            {COPY.cancel}
          </Button>
        </div>
      </div>
    )
  return (
    <ImportPreview
      fileName={chosen.name}
      preview={chosen.preview}
      write={write}
      blocked={offline || writes.held}
      offline={offline}
      chooser={chooser}
      onImport={() => void create(chosen.file)}
      onRetry={() => void retry()}
      onCancel={onCancel}
    />
  )
}

/** What the Host read from the chosen file, and the one write that creates it. */
export function ImportPreview({
  fileName,
  preview,
  write,
  blocked,
  offline,
  chooser,
  onImport,
  onRetry,
  onCancel,
}: {
  fileName: string
  preview: AgentImportPreview
  write: WriteState | null
  /** Offline, or another write's result is still unknown. */
  blocked: boolean
  offline: boolean
  chooser?: ReactNode
  onImport: () => void
  onRetry: () => void
  onCancel: () => void
}) {
  const saving = write !== null && 'phase' in write && write.phase === 'saving'
  const { agent, memories, schedules } = preview.file
  const problem = harnessProblem(preview.harness)
  return (
    <div className="agent-page agent-import" aria-busy={saving || undefined}>
      <h1 className="settings-title">{COPY.importTitle}</h1>
      <div className="agent-import-head">
        <AgentAvatar avatar={{ kind: 'face', ...agent.avatar }} size={40} />
        <div className="agent-import-name">
          <strong>
            <VisibleText text={agent.name} />
          </strong>
          {agent.description && (
            <span>
              <VisibleText text={agent.description} />
            </span>
          )}
        </div>
        {preview.nameTaken && <StatusWord tone="neutral">{COPY.sameName}</StatusWord>}
      </div>
      <dl className="agent-import-facts">
        <div>
          <dt>{COPY.file}</dt>
          <dd>
            <VisibleText text={fileName} />
          </dd>
        </div>
        <div>
          <dt>Harness</dt>
          <dd>{problem ?? preview.harness.label ?? preview.harness.id}</dd>
        </div>
      </dl>
      <section className="agent-form-section" aria-label={COPY.instructions}>
        <header>
          <h3>{COPY.instructions}</h3>
        </header>
        {agent.instructions ? (
          <pre className="agent-import-text">
            <VisibleText text={agent.instructions} />
          </pre>
        ) : (
          <p className="agent-form-empty">{COPY.noInstructions}</p>
        )}
      </section>
      <section className="agent-form-section" aria-label={COPY.memory}>
        <header>
          <h3>
            {COPY.memoryCount} {formatNumber(memories.length)}
          </h3>
          {memories.length > 0 && <Hint label={COPY.markedAsImport}>{COPY.importedReference}</Hint>}
        </header>
        {preview.file.omitted?.secretMemories ? (
          <StatusWord tone="neutral">{COPY.redactedMemories(preview.file.omitted.secretMemories)}</StatusWord>
        ) : null}
        {memories.length > 0 && (
          <ul className="agent-memory-list">
            {memories.map((memory, index) => (
              <li key={index} className="agent-memory-row">
                <div className="agent-memory-text">
                  <p>
                    <VisibleText text={memory.content} />
                  </p>
                  <span className="agent-memory-meta agent-memory-source">
                    <span>{fileMemoryWords(memory)}</span>
                    {memory.external && <StatusWord tone="warn">{COPY.external}</StatusWord>}
                    <time dateTime={memory.savedAt}>{memory.savedAt.slice(0, 10)}</time>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="agent-form-section" aria-label={COPY.scheduled}>
        <header>
          <h3>
            {COPY.scheduleCount} {formatNumber(schedules.length)}
          </h3>
          {schedules.length > 0
            && (preview.canSchedule ? (
              <StatusWord tone="neutral">{COPY.startsOff}</StatusWord>
            ) : (
              <StatusWord tone="warn">{COPY.noScheduleSupport}</StatusWord>
            ))}
        </header>
        {schedules.length > 0 && (
          <ul className="agent-memory-list">
            {schedules.map((schedule, index) => (
              <li key={index} className="agent-memory-row">
                <div className="agent-memory-text">
                  <p>
                    <VisibleText text={schedule.name} /> · {scheduleWords(schedule.schedule)}
                  </p>
                  <span className="agent-memory-meta agent-import-prompt">
                    <VisibleText text={schedule.prompt} />
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <WriteNotice state={write} onRetry={onRetry} />
      <div className="agent-form-actions">
        <Button
          variant="primary"
          loading={saving}
          disabled={blocked || saving || !preview.harness.ready}
          title={offline ? CONNECTION_COPY.offline : undefined}
          onClick={onImport}>
          {COPY.import}
        </Button>
        {chooser}
        <span className="agent-form-spacer" />
        <Button variant="ghost" disabled={saving || (write !== null && 'kind' in write && write.kind === 'unknown')} onClick={onCancel}>
          {COPY.cancel}
        </Button>
      </div>
    </div>
  )
}
