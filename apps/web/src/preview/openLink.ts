/** A frame's bounded URL event can consume a real click's activation, never create one. */
export function openDocumentLink(href: string): void {
  if (!navigator.userActivation.isActive || href.length > 4096) return
  try {
    const url = new URL(href)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return
    window.open(url.href, '_blank', 'noopener,noreferrer')
  } catch {
    /* An invalid or blocked document link leaves the current file open. */
  }
}
