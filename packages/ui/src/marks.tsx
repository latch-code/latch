import type { ComponentProps } from 'react'
import { cx } from './internal.ts'
import { Badge } from './pill.tsx'
import { Tooltip } from './tooltip.tsx'

/**
 * The development-build mark: a neutral small badge 「开发版」 after the computer's name (the sidebar footer from 1024px,
 * the bottom of the rail on tablets, the settings title on phones). `description` is its tooltip on hover and its
 * accessible name, the whole sentence of what it means. Never red: it is a fact about the build, not an alarm.
 */
export function DevMark({
  description,
  className,
  ...props
}: Omit<ComponentProps<'span'>, 'children' | 'title'> & { description: string }) {
  return (
    // The name already says the sentence, so the tooltip does not describe the mark a second time.
    <Tooltip content={description} describe={false}>
      <span {...props} className={cx('ui-badge', className)} data-tone="neutral" role="note" aria-label={description}>
        开发版
      </span>
    </Tooltip>
  )
}

/** The demo mark: an amber small badge 「演示模型」 (「演示」 where space is short) wherever the demo model answers. */
export function DemoMark({ compact = false, className }: { compact?: boolean; className?: string }) {
  return (
    <Badge tone="warn" className={className}>
      {compact ? '演示' : '演示模型'}
    </Badge>
  )
}
