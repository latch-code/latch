import { CheckGlyph, FolderGlyph, Icon } from '@latch/ui'
import { FileTypeIcon } from './FileTypeIcon.tsx'

/** A decorative file-type mark in prose; the path or the author's link text supplies the name. */
export function ReplyFileIcon({ path, folder, copied }: { path: string; folder?: boolean; copied?: boolean }) {
  if (folder || path.trim().endsWith('/')) return <Icon icon={copied ? CheckGlyph : FolderGlyph} size={16} className="reply-folder-icon" />
  return copied ? <Icon icon={CheckGlyph} size={14} /> : <FileTypeIcon path={path} />
}
