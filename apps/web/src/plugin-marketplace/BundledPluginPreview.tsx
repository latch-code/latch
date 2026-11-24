import { checklistSample, contextSample, featuredCover, historySample } from '../../../../examples/marketplace/feature-covers.ts'
import { defineCopy } from '../core/i18n.ts'
import { PluginFallbackCover } from './PluginArtwork.tsx'

const COPY = defineCopy(
  {
    next: '下一步',
    tests: '测试通过',
    compatibility: '兼容性已核对',
    version: '版本号',
    changelog: '更新记录',
    passed: '通过',
    pending: '待核对',
    request: (n: number) => `第 ${n} 次请求`,
    toolSchemas: '工具定义',
  },
  {
    next: 'Next step',
    tests: 'Tests passed',
    compatibility: 'Compatibility checked',
    version: 'Version',
    changelog: 'Changelog',
    passed: 'Passed',
    pending: 'Needs review',
    request: (n: number) => `Request ${n}`,
    toolSchemas: 'Tool definitions',
  },
)

/** The four featured covers use the same visual examples as the public catalogue. */
export function BundledPluginPreview({ id }: { id: string }) {
  const cover = featuredCover(id)
  if (!cover) return <PluginFallbackCover id={id} />

  return (
    <div className="plugin-market-preview market-feature" data-preview={cover} aria-hidden="true">
      <div className="market-feature-content">
        {cover === 'document' && (
          <div className="market-handoff">
            <div className="market-handoff-note" data-note="done">
              <span className="market-feature-check" />
              <span className="market-handoff-rule" />
              <span className="market-feature-check" />
              <span className="market-handoff-rule" />
            </div>
            <span className="market-handoff-arrow" />
            <div className="market-handoff-note" data-note="next">
              <strong>{COPY.next}</strong>
              <span className="market-handoff-rule" />
            </div>
          </div>
        )}
        {cover === 'checklist' && (
          <div className="market-checklist">
            <div className="market-checklist-score">
              <strong>{checklistSample.complete}</strong>
              <span> / {checklistSample.total}</span>
            </div>
            <div className="market-checklist-body">
              <div className="market-checklist-progress">
                {Array.from({ length: checklistSample.total }, (_, index) => (
                  <span key={index} data-complete={index < checklistSample.complete ? '' : undefined} />
                ))}
              </div>
              <span className="market-checklist-item">{COPY.tests}</span>
              <span className="market-checklist-item">{COPY.compatibility}</span>
            </div>
          </div>
        )}
        {cover === 'history' && (
          <ol className="market-release-track">
            {historySample.map(({ key, state }) => (
              <li key={key} data-state={state}>
                <span>{COPY[key]}</span>
                <strong>{COPY[state]}</strong>
              </li>
            ))}
          </ol>
        )}
        {cover === 'context' && (
          <>
            <div className="market-context-sequence">
              <ol className="market-context-nodes">
                {Array.from({ length: contextSample.request }, (_, index) => (
                  <li key={index} data-selected={index === contextSample.request - 1 ? '' : undefined} />
                ))}
              </ol>
              <strong>{COPY.request(contextSample.request)}</strong>
            </div>
            <div className="market-context-band">
              {contextSample.shares.map(percent => (
                <span key={percent} style={{ flexGrow: percent }} />
              ))}
            </div>
            <span className="market-context-label">
              {COPY.toolSchemas} <strong>{contextSample.shares[0]}%</strong>
            </span>
          </>
        )}
      </div>
    </div>
  )
}
