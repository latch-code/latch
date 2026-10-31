import type { ReactNode } from 'react'

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="gallery-section" aria-label={title}>
      <h2>{title}</h2>
      <div className="gallery-card">{children}</div>
    </section>
  )
}

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="gallery-row">
      <span className="gallery-label">{label}</span>
      <div className="gallery-items">{children}</div>
    </div>
  )
}

/** One sample with its caption; `force` holds a pseudo-class for the capture. */
export function Cell({ caption, force, at, children }: { caption?: string; force?: string; at?: string; children: ReactNode }) {
  return (
    <figure className="gallery-cell">
      <div className="gallery-sample" data-force={force} data-force-at={at}>
        {children}
      </div>
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  )
}
