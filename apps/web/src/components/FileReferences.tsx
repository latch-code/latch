import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { FileOpenContext } from '../preview/fileContext.ts'
import { api } from '../core/api.ts'
import type { Message } from '@latch/protocol'
import { shellFiles, type FileKnownResult, type ShellFiles } from '../core/shell.ts'
import { argumentView } from '../format.ts'
import { toolKind } from '../icons.tsx'

// References that are not links (inline code such as `deck.pptx` or `src/app.ts:12`, and the files a tool read or
// wrote) become path chips in the desktop app once the Host says they name a file it would act on. Main asks the Host
// about a whole batch at once; everything else stays as it was written.

/** What one question to main carries: what one resolve request takes. */
const BATCH = 64
/** References one session's view keeps track of. */
const TRACKED_LIMIT = 512
/** How long the view gathers references before it asks. */
const GATHER_MS = 120
const BUSY_RETRY_MS = 500
const BUSY_RETRIES = 5

type Known = (sessionId: string, paths: string[], rootId?: string) => ReturnType<NonNullable<ShellFiles['known']>>
const apiKnown: Known = async (sessionId, paths, rootId) => {
  const result = await api<{ files: Array<{ input: string; status: string }> }>(`tasks/${encodeURIComponent(sessionId)}/files/resolve`, {
    method: 'POST',
    body: { paths, ...(rootId ? { rootId } : {}) },
  })
  return { status: 'ok', known: result.files.filter(file => file.status === 'ok').map(file => file.input) }
}

/** The answers for one session: which references are files, asked in batches. */
export class KnownFiles {
  private readonly answers = new Map<string, boolean>()
  private readonly queued = new Set<string>()
  private readonly asking = new Set<string>()
  private readonly listeners = new Set<() => void>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private busy = 0
  private closed = false
  version = 0

  constructor(
    private readonly sessionId: string,
    private readonly known: Known,
  ) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  isFile(path: string, rootId?: string): boolean {
    return this.answers.get(rootId ? `${rootId}\0${path}` : path) === true
  }

  /** Asks about a reference once, with the others gathered at the same time. */
  want(path: string, rootId?: string): void {
    path = rootId ? `${rootId}\0${path}` : path
    if (this.closed || this.answers.has(path) || this.asking.has(path) || this.queued.has(path)) return
    if (this.answers.size + this.asking.size + this.queued.size >= TRACKED_LIMIT) return
    this.queued.add(path)
    this.schedule(GATHER_MS)
  }

  /** A turn settled: a reference that named no file before may name one now (the agent wrote it later). */
  recheck(): void {
    for (const [path, isFile] of this.answers)
      if (!isFile) {
        this.answers.delete(path)
        this.queued.add(path)
      }
    if (this.queued.size > 0) this.schedule(GATHER_MS)
  }

  close(): void {
    this.closed = true
    clearTimeout(this.timer)
    this.listeners.clear()
  }

  private schedule(delay: number): void {
    if (this.timer !== undefined || this.closed) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.ask()
    }, delay)
  }

  private async ask(): Promise<void> {
    const first = [...this.queued][0] ?? ''
    const rootId = first.includes('\0') ? first.slice(0, first.indexOf('\0')) : undefined
    const batch = [...this.queued].filter(path => (rootId ? path.startsWith(`${rootId}\0`) : !path.includes('\0'))).slice(0, BATCH)
    const paths = batch.map(path => (rootId ? path.slice(rootId.length + 1) : path))
    for (const path of batch) {
      this.queued.delete(path)
      this.asking.add(path)
    }
    const result = await this.known(this.sessionId, paths, rootId).catch((): FileKnownResult => ({
      status: 'failed',
      code: 'shell-failed',
    }))
    for (const path of batch) this.asking.delete(path)
    if (this.closed) return
    if (result.status === 'busy' && this.busy < BUSY_RETRIES) {
      this.busy++
      for (const path of batch) this.queued.add(path)
      this.schedule(BUSY_RETRY_MS)
      return
    }
    this.busy = 0
    const found = new Set(result.status === 'ok' ? result.known : [])
    let changed = false
    for (const path of batch) {
      const isFile = found.has(rootId ? path.slice(rootId.length + 1) : path)
      changed ||= isFile
      this.answers.set(path, isFile)
    }
    if (changed) {
      this.version++
      for (const listener of this.listeners) listener()
    }
    if (this.queued.size > 0) this.schedule(GATHER_MS)
  }
}

export const KnownFilesContext = createContext<KnownFiles | null>(null)

/**
 * Gives a session's view its answers about references, in the desktop app with a shell that can ask (elsewhere
 * nothing is asked and every reference stays as written). `active`: the session is running; when it settles,
 * references that named no file are asked about again.
 */
export function FileReferences({ sessionId, active, children }: { sessionId: string; active: boolean; children: ReactNode }) {
  const preview = useContext(FileOpenContext)
  const known = preview ? apiKnown : shellFiles()?.known
  const [store, setStore] = useState<KnownFiles | null>(null)
  useEffect(() => {
    if (typeof known !== 'function') return undefined
    const next = new KnownFiles(sessionId, known)
    setStore(next)
    return () => {
      next.close()
      setStore(null)
    }
  }, [sessionId, known])
  const wasActive = useRef(active)
  useEffect(() => {
    if (wasActive.current && !active) store?.recheck()
    wasActive.current = active
  }, [active, store])
  return <KnownFilesContext.Provider value={store}>{children}</KnownFilesContext.Provider>
}

/**
 * The references among `paths` the Host says are files. `ask`: whether they may be asked about now (a reply that
 * stopped streaming, a tool that finished); until then nothing is sent.
 */
export function useKnownFiles(paths: readonly string[], ask: boolean, rootId?: string): string[] {
  const store = useContext(KnownFilesContext)
  const subscribe = useCallback((listener: () => void) => store?.subscribe(listener) ?? (() => {}), [store])
  useSyncExternalStore(
    subscribe,
    () => store?.version ?? 0,
    () => 0,
  )
  const key = paths.join('\n')
  useEffect(() => {
    if (!store || !ask) return
    for (const path of key ? key.split('\n') : []) store.want(path, rootId)
  }, [store, ask, key, rootId])
  return store ? paths.filter(path => store.isFile(path, rootId)) : []
}

const PATH_ARGUMENTS = ['path', 'file', 'file_path', 'filePath']
const FILE_KINDS = new Set(['read', 'edit', 'move'])

/** The files a tool read or wrote, as it named them: its locations, its path argument and its diffs; at most 8. */
export function toolFileTargets(message: Pick<Message, 'tool' | 'toolName'>): string[] {
  if (!FILE_KINDS.has(toolKind(message))) return []
  const tool = message.tool
  const targets = new Set<string>()
  const add = (value: string | undefined) => {
    const path = value?.trim()
    if (path && !path.includes('\n') && path.length <= 4096) targets.add(path)
  }
  for (const location of tool?.locations ?? []) add(location)
  const view = argumentView(tool?.input)
  if (view.kind === 'entries') for (const [key, value] of view.entries) if (PATH_ARGUMENTS.includes(key)) add(value)
  for (const diff of tool?.diffs ?? []) add(diff.path)
  return [...targets].slice(0, 8)
}
