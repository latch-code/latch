import { argumentView } from '../format.ts'
import { VisibleText } from './VisibleText.tsx'

/**
 * A tool call's arguments. `covered`: argument values another view already shows in full, such as a diff's path and
 * new file text. When every value is covered it says so, or, with `quiet`, shows nothing.
 */
export function ArgumentList({ text, covered = [], quiet = false }: { text?: string; covered?: string[]; quiet?: boolean }) {
  const view = argumentView(text)
  if (view.kind === 'empty') return <p className="muted-line">无参数</p>
  if (view.kind === 'text')
    return (
      <pre className="tool-pre">
        <VisibleText text={view.text} />
      </pre>
    )
  const entries = view.entries.filter(([, value]) => !covered.includes(value))
  if (entries.length === 0) return quiet ? null : <p className="muted-line">内容见变更</p>
  return (
    <dl className="argument-list">
      {entries.map(([key, value]) => (
        <div key={key}>
          <dt>
            <VisibleText text={key} />
          </dt>
          <dd>
            <pre>
              <VisibleText text={value} />
            </pre>
          </dd>
        </div>
      ))}
    </dl>
  )
}
