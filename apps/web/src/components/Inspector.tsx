import type { ReactNode } from 'react'
import type { AppSnapshot, TaskDetail, TaskSummary } from '@latch/protocol'
import { findProvider, sessionHarness, usesDemoModel } from '../composerChoice.ts'
import { basename, formatTokens, isActive, statusLabels, usageTitle } from '../format.ts'
import { ICON_STROKE, Spinner, toolKind, toolKindIcons } from '../icons.tsx'
import { LEVEL_LABELS } from '../core/permissions.ts'
import { PlanList, planProgress } from './PlanCard.tsx'
import { Badge, CopyButton } from './ui.tsx'

const toolStates = {
  queued: '等待执行',
  'awaiting-approval': '待批准',
  running: '执行中',
  completed: '完成',
  failed: '失败',
  cancelled: '已取消',
} as const

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="inspector-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

/** Session facts, the full plan and the tool timeline; clicking a tool reveals it in the transcript. */
export function Inspector({
  snapshot,
  summary,
  detail,
  onReveal,
}: {
  snapshot: AppSnapshot
  summary: TaskSummary
  detail: TaskDetail | null
  onReveal: (messageId: string) => void
}) {
  const catalog = snapshot.catalog
  const harness = sessionHarness(catalog, summary)
  const provider = findProvider(catalog, summary.providerId)
  const tools = detail?.messages.filter(message => message.role === 'tool') ?? []
  const plan = detail?.plan ?? []
  const progress = planProgress(plan)
  const usage = summary.usage
  const permission = detail?.summary.id === summary.id ? detail.permission : undefined
  const level = permission?.level ?? summary.level
  const facts = permission
    ? [
        permission.enforcer === 'LATCH' ? 'Latch 在执行有风险的工具调用前询问' : 'Latch 不限制该 Harness 的执行范围',
        ...(permission.verifiedDefinition === undefined ? [] : [permission.verifiedDefinition ? '已验证的预设' : '未验证的定义']),
        ...(permission.readback === undefined
          ? []
          : [
              permission.readback === 'mode'
                ? `权限模式可读回${permission.expectedMode ? `（${permission.expectedMode}）` : ''}`
                : '无法读回权限模式',
            ]),
        ...(permission.approvals === 'none' ? ['不请求审批'] : []),
        ...permission.notes,
      ]
    : []
  return (
    <div className="inspector">
      <section className="inspector-section" aria-labelledby="inspector-overview">
        <h3 id="inspector-overview">概览</h3>
        <dl>
          <Row label="状态">{statusLabels[summary.status]}</Row>
          <Row label="Harness">{harness?.name ?? snapshot.harness?.name ?? '默认'}</Row>
          <Row label="模型">
            {summary.model ? (
              <>
                {summary.model}
                {provider && <span className="inspector-sub">{provider.name}</span>}
              </>
            ) : harness?.models === 'agent' ? (
              '由 Agent 管理'
            ) : usesDemoModel(snapshot, summary.harnessId, summary.providerId) ? (
              '演示模型'
            ) : (
              '默认模型'
            )}
          </Row>
          <Row label="模式">{summary.mode === 'chat' ? '对话' : 'Agent'}</Row>
          {level && (
            <Row label="权限">
              <span className="inspector-permission">
                <Badge tone={level === 'L3' ? 'warn' : 'neutral'}>{LEVEL_LABELS[level]}</Badge>
                {(summary.permissionDrift || permission?.drift) && <Badge tone="err">权限模式已变化</Badge>}
                {facts.length > 0 && (
                  <ul className="inspector-facts">
                    {facts.map(fact => (
                      <li key={fact}>{fact}</li>
                    ))}
                  </ul>
                )}
              </span>
            </Row>
          )}
          {summary.cwd && (
            <Row label="项目">
              <span className="inspector-path">
                <span className="inspector-path-name">{basename(summary.cwd)}</span>
                <span className="inspector-path-full">{summary.cwd}</span>
              </span>
              <CopyButton text={summary.cwd} label="复制路径" />
            </Row>
          )}
          {usage && (
            <Row label="用量">
              <span title={usageTitle(usage)}>
                输入 {formatTokens(usage.inputTokens)} · 输出 {formatTokens(usage.outputTokens)}
              </span>
            </Row>
          )}
        </dl>
      </section>
      {plan.length > 0 && (
        <section className="inspector-section" aria-labelledby="inspector-plan">
          <h3 id="inspector-plan">
            计划{' '}
            <span className="inspector-count">
              {progress.done}/{progress.total}
            </span>
          </h3>
          <span className="progress" aria-hidden="true">
            <i style={{ width: `${Math.round(progress.ratio * 100)}%` }} />
          </span>
          <PlanList plan={plan} active={isActive(summary.status)} />
        </section>
      )}
      <section className="inspector-section" aria-labelledby="inspector-tools">
        <h3 id="inspector-tools">工具时间线 {tools.length > 0 && <span className="inspector-count">{tools.length}</span>}</h3>
        {detail === null ? (
          <p className="muted-line">正在读取…</p>
        ) : tools.length === 0 ? (
          <p className="muted-line">尚无工具调用</p>
        ) : (
          <ol className="timeline">
            {tools.map(tool => {
              const Icon = toolKindIcons[toolKind(tool)]
              return (
                <li key={tool.id} className={`timeline-item state-${tool.state ?? 'completed'}`}>
                  <button
                    type="button"
                    onClick={() => {
                      onReveal(tool.id)
                    }}>
                    <span className="timeline-icon" aria-hidden="true">
                      {tool.state === 'running' ? <Spinner size={14} /> : <Icon size={14} strokeWidth={ICON_STROKE} />}
                    </span>
                    <span className="timeline-title">{tool.tool?.title || tool.toolName || '工具调用'}</span>
                    <span className="timeline-state">{toolStates[tool.state ?? 'completed']}</span>
                  </button>
                </li>
              )
            })}
          </ol>
        )}
      </section>
    </div>
  )
}
