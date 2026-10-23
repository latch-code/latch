import type { ReactNode } from 'react'
import { Spinner } from '../icons.tsx'

export function SectionHeading({ title, description, action }: { title: string; description?: ReactNode; action?: ReactNode }) {
  return <header className="settings-heading">
    <div><h3>{title}</h3>{description && <p>{description}</p>}</div>
    {action}
  </header>
}

export function Avatar({ name }: { name: string }) {
  return <span className="avatar" aria-hidden="true">{[...name.trim()][0]?.toUpperCase() ?? '?'}</span>
}

export function Loading({ label = '正在读取…' }: { label?: string }) {
  return <p className="loading-line" role="status"><Spinner size={16} />{label}</p>
}
