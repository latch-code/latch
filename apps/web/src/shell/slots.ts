import type { LucideIcon } from '@latch/ui'
import type { ReactNode } from 'react'

/** A 28px ghost toggle in the conversation header. A surface supplies one only once what it opens works. */
export interface HeaderToggle {
  label: string
  icon: LucideIcon
  shortcut?: string
  pressed: boolean
  /** A 6px ink dot: what it opens has something new. */
  dot?: boolean
  onToggle: () => void
}

/** What surfaces implement in the conversation header. */
export interface ConversationHeaderSlots {
  /** 「提交 ⌄」, when the project is a repository with something to commit. */
  gitAction?: ReactNode
  /** 终端 (⌘J). */
  terminal?: HeaderToggle
  /** 变更 (⌘D). */
  changes?: HeaderToggle
}
