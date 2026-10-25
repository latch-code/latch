import { MessageContent, type MessageContentProps } from '../MessageContent.tsx'
/** Static file Markdown keeps the same URL and nesting rules as assistant text. */
export function MarkdownPreview(props: Omit<MessageContentProps, 'streaming'>) {
  return <MessageContent {...props} streaming={false} />
}
