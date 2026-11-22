import type { DataScope, DeviceScope } from '@latch/protocol'
import { listText } from '../core/i18n.ts'
import { CONNECTION_DETAILS_COPY as COPY, GRANTED_TEXT } from '../core/securityCopy.ts'
import { VisibleText } from './VisibleText.tsx'

/**
 * Shut by default, on the connecting device and in the Mac's panel. Everything is what the Host said (the page's own form
 * has only what it will ask for, and the Host refuses anything else), and a line with nothing to say is left out.
 */
export function ConnectionDetails({
  name,
  code,
  codeNote,
  reason,
  scopes,
  dataScope,
}: {
  name?: string
  code?: string
  codeNote?: string
  reason?: string
  scopes?: readonly DeviceScope[]
  dataScope?: DataScope
}) {
  return (
    <details className="connection-details">
      <summary>{COPY.title}</summary>
      <dl className="connection-details-list">
        {name && (
          <div className="connection-details-row">
            <dt>{COPY.name}</dt>
            <dd>
              <VisibleText text={name} />
            </dd>
          </div>
        )}
        {code && (
          <div className="connection-details-row">
            <dt>{COPY.code}</dt>
            <dd>
              <code className="connection-code" aria-label={`${COPY.code} ${code}`}>
                {/* Groups are separate boxes so they wrap whole; the spaces keep the copied and read text exact. */}
                {code
                  .split(' ')
                  .flatMap((group, index) => (index === 0 ? [<span key={index}>{group}</span>] : [' ', <span key={index}>{group}</span>]))}
              </code>
              {codeNote && <span className="connection-details-note">{codeNote}</span>}
            </dd>
          </div>
        )}
        {reason && (
          <div className="connection-details-row">
            <dt>{COPY.sheet}</dt>
            <dd>
              <q>
                <VisibleText text={reason} />
              </q>
            </dd>
          </div>
        )}
        {scopes && (
          <div className="connection-details-row">
            <dt>{COPY.granted}</dt>
            <dd>
              {listText(
                // A scope without words still shows, by its name: what a device may do is never left out.
                scopes.map(scope => GRANTED_TEXT[scope] ?? scope),
                'unit',
              )}
            </dd>
          </div>
        )}
        {dataScope && (
          <div className="connection-details-row">
            <dt>{COPY.data}</dt>
            <dd>{COPY.dataText[dataScope]}</dd>
          </div>
        )}
      </dl>
    </details>
  )
}
