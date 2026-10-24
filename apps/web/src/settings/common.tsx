import type { ReactNode } from 'react'
import { Loading as InlineLoading } from '@latch/ui'

export function SectionHeading({ title, description, action }: { title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <header className="settings-heading">
      <div>
        <h3>{title}</h3>
        {description && <p>{description}</p>}
      </div>
      {action}
    </header>
  )
}

/** Settings sections loading their data: the design system's inline loading line. */
export function Loading({ label = '正在读取…' }: { label?: string }) {
  return <InlineLoading label={label} />
}
