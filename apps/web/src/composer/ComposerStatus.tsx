import { Fragment, useLayoutEffect, useRef, type ReactNode } from 'react'
import { FolderGit2 } from 'lucide-react'
import type { HarnessInfo, HostCatalog, ModelRef, ProviderSummary, TaskSummary } from '@latch/protocol'
import { ICON_STROKE, Meter, Tooltip, FolderGlyph, BranchGlyph } from '@latch/ui'
import { ProviderTile } from '../components/BrandTile.tsx'
import { escapeHiddenCharacters, VisibleText } from '../components/VisibleText.tsx'
import { findProvider, harnessName } from '../composerChoice.ts'
import { exactTokens, formatTokens } from '../format.ts'
import { ROUTE_NOTE, routeService } from './ModelControl.tsx'
import { costClause, type SessionTotals } from './sessionTotals.ts'

/** Which way the model goes, in the words its menu uses: 「OpenAI · 经 Latch」 or 「Codex 自己的模型」. */
export interface StatusRoute {
  text: string
  /** The menu's sentence about it, for the tooltip. */
  note?: string
  provider?: ProviderSummary
}

/**
 * The route of a session, or of a draft by the service it picked. The built-in Harness calls its service itself and
 * the model control already names both, so it has no route segment.
 */
export function statusRoute(
  catalog: HostCatalog | undefined,
  harness: Pick<HarnessInfo, 'capabilities'> | undefined,
  input: { route?: TaskSummary['modelRoute'] | undefined; picked?: ModelRef | undefined },
): StatusRoute | undefined {
  if (!harness || harness.capabilities.models.owner !== 'harness') return undefined
  const name = harnessName(harness)
  if (input.route && catalog) {
    const service = routeService(catalog, input.route)
    const provider = findProvider(catalog, input.route.providerId)
    return {
      text: `${service.name} · ${service.unusable?.words ?? '经 Latch'}`,
      note: service.unusable?.note ?? ROUTE_NOTE(name).detail,
      ...(provider ? { provider } : {}),
    }
  }
  const provider = input.picked ? findProvider(catalog, input.picked.providerId) : undefined
  if (provider) return { text: `${provider.name} · 经 Latch`, note: ROUTE_NOTE(name).detail, provider }
  return { text: `${name} 自己的模型` }
}

/** One segment of the status line, named for the order in which a narrow line lets segments go. */
export function StatusSegment({
  kind,
  children,
}: {
  kind: 'folder' | 'branch' | 'route' | 'context' | 'tokens' | 'cost' | 'time'
  children: ReactNode
}) {
  return (
    <span className="composer-status-seg" data-seg={kind}>
      {children}
    </span>
  )
}

/** The project or folder a session works in; a draft names its project, never a path. */
export function FolderSegment({ name, tip, worktree = false }: { name: string; tip: string; worktree?: boolean }) {
  return (
    <StatusSegment kind="folder">
      <Tooltip content={escapeHiddenCharacters(tip)}>
        <span className="composer-status-cut" tabIndex={0}>
          {worktree ? (
            <FolderGit2 size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
          ) : (
            <FolderGlyph size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
          )}
          <span className="composer-status-value">
            <VisibleText text={name} />
          </span>
        </span>
      </Tooltip>
    </StatusSegment>
  )
}

/**
 * The branch as the Host read it, cut with an ellipsis when the line is full; the tooltip has the whole name, the
 * only place a draft shows it. A session in a worktree says 工作树 · its branch.
 */
export function BranchSegment({
  branch,
  worktree = false,
  base = false,
  removed = false,
}: {
  branch: string
  worktree?: boolean
  base?: boolean
  /** The session's worktree was removed: the session only reads now. */
  removed?: boolean
}) {
  const name = breakable(escapeHiddenCharacters(branch))
  const lead = removed ? '工作树已移除 · ' : '工作树 · '
  const tip = worktree ? (
    <>
      {lead}
      {name}
    </>
  ) : (
    <>
      {base ? '新工作树 · ' : '分支 '}
      {name}
    </>
  )
  return (
    <StatusSegment kind="branch">
      <Tooltip content={tip}>
        <span className="composer-status-cut composer-branch" tabIndex={0}>
          <BranchGlyph size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
          <span className="composer-status-value composer-branch-name" data-worktree={worktree ? '' : undefined}>
            {worktree && lead}
            <VisibleText text={branch} />
          </span>
        </span>
      </Tooltip>
    </StatusSegment>
  )
}

/** A long name in a tooltip may break after a slash, a dash, an underscore or a dot, and nowhere it would not. */
function breakable(text: string): ReactNode {
  return text.split(/(?<=[/\-_.])/u).map((part, index) => (
    <Fragment key={index}>
      {index > 0 && <wbr />}
      {part}
    </Fragment>
  ))
}

/** Least needed first: what a narrow line lets go of, in turn, before anything overflows. */
const DROPS = 4

/**
 * The composer's last row: on the left where the session works and which way its model goes; on the right what it has
 * used, each number only when it was reported, and with who reported it when that is not Latch. A narrow line lets go
 * of 用时, then the tokens, then the cost, then the route; the folder and the branch are cut with an ellipsis, and the
 * context stays. On a phone only the context is there, and only with both numbers.
 */
export function ComposerStatus({
  place,
  route,
  totals,
  phone = false,
}: {
  /** The folder and branch segments. */
  place?: ReactNode
  route?: StatusRoute | undefined
  totals?: SessionTotals | undefined
  phone?: boolean
}) {
  const row = useRef<HTMLDivElement>(null)
  const context = totals?.context
  const show = {
    place: !phone && place !== undefined && place !== null && place !== false,
    route: !phone && route !== undefined,
    context: context !== undefined && (!phone || context.size !== undefined),
    tokens: !phone && totals?.tokens !== undefined,
    cost: !phone && totals?.cost !== undefined,
    time: !phone && totals?.time !== undefined,
  }
  // Fitted after every render and on every resize: drop a level at a time until nothing overflows. The level lives on
  // the element, not in state, so fitting never renders again.
  useLayoutEffect(() => {
    const element = row.current
    if (!element) return undefined
    const fit = () => {
      // Measured with the folder and the branch whole (up to their cap), so segments give way before they are cut;
      // with nothing left to give, they are cut.
      element.dataset.fit = 'whole'
      let level = 0
      element.dataset.drop = '0'
      while (level < DROPS && element.scrollWidth > element.clientWidth + 1) {
        level += 1
        element.dataset.drop = String(level)
      }
      delete element.dataset.fit
    }
    fit()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(fit)
    observer.observe(element)
    return () => {
      observer.disconnect()
    }
  })
  if (!Object.values(show).some(Boolean)) return null
  const tokens = totals?.tokens
  const cost = totals?.cost
  const time = totals?.time
  return (
    <div ref={row} className="composer-status" data-phone={phone ? '' : undefined} aria-label="会话状态" role="group">
      {show.place && place}
      {show.route && route && (
        <StatusSegment kind="route">
          <Tooltip content={route.note}>
            <span className="composer-status-route" tabIndex={route.note ? 0 : undefined}>
              {route.provider && <ProviderTile provider={route.provider} size={14} />}
              <VisibleText text={route.text} />
            </span>
          </Tooltip>
        </StatusSegment>
      )}
      {!phone && <span className="composer-status-gap" aria-hidden="true" />}
      {show.context && context && totals && (
        <StatusSegment kind="context">
          <span className="composer-status-key">上下文</span>
          {context.size === undefined ? (
            <Tooltip content={`由 ${totals.by} 报告：已用 ${exactTokens(context.used)} tokens，没有报告总量`}>
              <span className="composer-status-value" tabIndex={0}>
                {formatTokens(context.used)}
              </span>
            </Tooltip>
          ) : (
            <Tooltip
              content={`上下文已用 ${context.percent}% · ${exactTokens(context.used)} / ${exactTokens(context.size)} tokens，由 ${totals.by} 报告`}>
              <span className="composer-status-meter" tabIndex={0}>
                <span className="composer-status-value">
                  {formatTokens(context.used)} / {formatTokens(context.size)}
                </span>
                <Meter
                  value={context.used}
                  max={context.size}
                  label="上下文"
                  valueText={`${formatTokens(context.used)} / ${formatTokens(context.size)}`}
                />
              </span>
            </Tooltip>
          )}
        </StatusSegment>
      )}
      {show.tokens && tokens && (
        <StatusSegment kind="tokens">
          <Tooltip content={`${tokens.lines[0]}；${tokens.lines[1]}${tokens.reporter ? `，由 ${tokens.reporter} 报告` : ''}`}>
            <span className="composer-status-pair" tabIndex={0}>
              <span className="composer-status-key">输入</span>
              <span className="composer-status-value">{formatTokens(tokens.usage.inputTokens)}</span>
              <span className="composer-status-key">输出</span>
              <span className="composer-status-value">{formatTokens(tokens.usage.outputTokens)}</span>
              {tokens.reporter && <span className="composer-status-by">由 {tokens.reporter} 报告</span>}
            </span>
          </Tooltip>
        </StatusSegment>
      )}
      {show.cost && cost && (
        <StatusSegment kind="cost">
          <span className="composer-status-value">{cost.text}</span>
          <span className="composer-status-by">{costClause(cost.reporter)}</span>
        </StatusSegment>
      )}
      {show.time && time && (
        <StatusSegment kind="time">
          <span className="composer-status-value">{time.text}</span>
        </StatusSegment>
      )}
    </div>
  )
}
