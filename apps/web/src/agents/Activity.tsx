import type { AgentActivityItem, AgentActivityPage, AgentLibraryGroup, AgentLibraryPage } from '@latch/protocol'
import { Image } from 'lucide-react'
import { AlarmClock } from 'lucide-react'
import { Button, FileGlyph, Icon, InlineNotice, Loading, StatusWord } from '@latch/ui'
import { VisibleText } from '../components/VisibleText.tsx'
import { activityTarget, activityWords, bucketed, groupTitle } from './activity.ts'
import { LockedAgents } from './parts.tsx'
import { whenWords } from './scheduleModel.ts'
import { usePaged, type PagedRead } from './usePaged.ts'

/** The states a paged list shares: reading, locked to this device, failed, and 加载更多. */
function PagedFrame<T>({
  read,
  empty,
  onMore,
  onRetry,
  children,
}: {
  read: PagedRead<T>
  empty: string
  onMore: () => void
  onRetry: () => void
  children: React.ReactNode
}) {
  if (read.state === 'locked') return <LockedAgents />
  if (read.state === 'loading' && !read.items.length) return <Loading label="正在读取" />
  if (read.state === 'failed' && !read.items.length)
    return (
      <InlineNotice tone="error" title="读取失败" action={<Button onClick={onRetry}>重试</Button>}>
        {read.message}
      </InlineNotice>
    )
  if (!read.items.length && !read.more) return <p className="agent-profile-quiet">{empty}</p>
  return (
    <>
      {children}
      {read.more && (
        <Button variant="ghost" size="sm" className="agent-profile-more" loading={read.loadingMore} onClick={onMore}>
          加载更多
        </Button>
      )}
    </>
  )
}

/**
 * 动态: what happened with this Agent, from the Host's records only, newest first in 今天 / 本周 / 更早. Each row leads
 * where it happened: a topic, a run, or 记忆.
 */
export function ActivityTab({
  owner,
  version,
  onOpenSession,
  onMemory,
}: {
  owner: string
  version: string
  onOpenSession: (id: string) => void
  onMemory: () => void
}) {
  const { read, loadMore, reload } = usePaged<AgentActivityPage, AgentActivityItem>(
    `custom-agents/${encodeURIComponent(owner)}/activity`,
    version,
    page => page.items,
  )
  return (
    <PagedFrame read={read} empty="还没有动态" onMore={loadMore} onRetry={reload}>
      {bucketed(read.items).map(bucket => (
        <section key={bucket.label} className="agent-activity-bucket" aria-label={bucket.label}>
          <h4>{bucket.label}</h4>
          <ul className="agent-recent" aria-label={`${bucket.label}的动态`}>
            {bucket.rows.map(item => (
              <ActivityRow key={item.id} item={item} onOpenSession={onOpenSession} onMemory={onMemory} />
            ))}
          </ul>
        </section>
      ))}
    </PagedFrame>
  )
}

function ActivityRow({
  item,
  onOpenSession,
  onMemory,
}: {
  item: AgentActivityItem
  onOpenSession: (id: string) => void
  onMemory: () => void
}) {
  const words = activityWords(item)
  const target = activityTarget(item)
  const body = (
    <>
      <span className="agent-recent-text">
        <span className="agent-recent-title">
          <span className="agent-activity-lead">{words.lead}</span>
          {words.subject && (
            <>
              {' · '}
              <VisibleText text={words.subject} />
            </>
          )}
        </span>
        <time dateTime={item.at}>{whenWords(item.at)}</time>
      </span>
      {words.state && <StatusWord tone={words.state.tone}>{words.state.word}</StatusWord>}
    </>
  )
  return (
    <li data-kind={item.kind}>
      {target ? (
        <button
          type="button"
          className="agent-recent-row"
          onClick={() => {
            if ('session' in target) onOpenSession(target.session)
            else onMemory()
          }}>
          {body}
        </button>
      ) : (
        <div className="agent-recent-row agent-recent-static">{body}</div>
      )}
    </li>
  )
}

/**
 * 资料库: the files this Agent's sessions changed or produced and the attachments the person gave it, by session,
 * newest first. A file opens in the file preview of its session, under that session's file rules.
 */
export function LibraryTab({
  owner,
  version,
  canOpen,
  onOpenFile,
  onOpenSession,
}: {
  owner: string
  version: string
  /** The file preview exists here and this device may see project files. */
  canOpen: boolean
  onOpenFile: (target: { sessionId: string; reference: string; rootId?: string; attachmentId?: string }) => void
  onOpenSession: (id: string) => void
}) {
  const { read, loadMore, reload } = usePaged<AgentLibraryPage, AgentLibraryGroup>(
    `custom-agents/${encodeURIComponent(owner)}/library`,
    version,
    page => page.groups,
  )
  return (
    <PagedFrame read={read} empty="还没有文件" onMore={loadMore} onRetry={reload}>
      {!canOpen && <p className="agent-profile-quiet">这台设备看不到项目文件</p>}
      <div className="agent-library">
        {read.items.map(group => (
          <section key={group.sessionId} className="agent-library-group" aria-label={groupTitle(group)}>
            <button type="button" className="agent-library-head" onClick={() => onOpenSession(group.sessionId)}>
              {group.automationId && <Icon icon={AlarmClock} size={12} />}
              <span className="agent-recent-title">
                <VisibleText text={groupTitle(group)} />
              </span>
              <time dateTime={group.at}>{whenWords(group.at)}</time>
            </button>
            <ul className="agent-library-files" aria-label={`${groupTitle(group)} 的文件`}>
              {group.items.map(item => {
                const label = item.kind === 'file' ? item.path : item.attachment.name
                const openable = canOpen && !(item.kind === 'file' && item.change === 'deleted')
                return (
                  <li
                    key={item.kind === 'file' ? `${item.root}:${item.path}` : `${item.messageId}:${item.attachment.id}`}
                    data-kind={item.kind}>
                    <Icon icon={item.kind === 'attachment' && item.attachment.kind === 'image' ? Image : FileGlyph} size={14} />
                    {openable ? (
                      <button
                        type="button"
                        className="agent-library-file is-mono"
                        onClick={() =>
                          onOpenFile(
                            item.kind === 'file'
                              ? { sessionId: item.sessionId, reference: item.path, rootId: item.root }
                              : { sessionId: item.sessionId, reference: item.attachment.name, attachmentId: item.attachment.id },
                          )
                        }>
                        <VisibleText text={label} />
                      </button>
                    ) : (
                      <span className="agent-library-file is-mono">
                        <VisibleText text={label} />
                      </span>
                    )}
                    <span className="agent-library-kind">
                      {item.kind === 'attachment'
                        ? '你给的'
                        : item.change === 'created'
                          ? '新增'
                          : item.change === 'deleted'
                            ? '已删除'
                            : '修改'}
                    </span>
                  </li>
                )
              })}
              {group.more ? <li className="agent-profile-quiet">另有 {group.more} 个</li> : null}
            </ul>
          </section>
        ))}
      </div>
    </PagedFrame>
  )
}
