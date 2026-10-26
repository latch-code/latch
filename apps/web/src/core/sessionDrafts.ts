interface Draft {
  text: string
  private: boolean
}
const MAX_DRAFTS = 20
const MAX_CHARACTERS = 256_000

/** Unsent text stays in this workspace's memory, isolated by globally unique session ID. */
export class SessionDrafts {
  private readonly drafts = new Map<string, Draft>()
  private characters = 0
  save(id: string, text: string, personal: boolean): boolean {
    if (text.length > MAX_CHARACTERS) return false
    this.remove(id)
    if (!text) return true
    while (this.drafts.size >= MAX_DRAFTS || this.characters + text.length > MAX_CHARACTERS) {
      const oldest = this.drafts.keys().next().value
      if (oldest === undefined) break
      this.remove(oldest)
    }
    this.drafts.set(id, { text, private: personal })
    this.characters += text.length
    return true
  }
  read(id: string, allowPrivate: boolean): string {
    const draft = this.drafts.get(id)
    if (!draft) return ''
    if (draft.private && !allowPrivate) {
      this.remove(id)
      return ''
    }
    this.drafts.delete(id)
    this.drafts.set(id, draft)
    return draft.text
  }
  remove(id: string): void {
    const previous = this.drafts.get(id)
    if (previous) this.characters -= previous.text.length
    this.drafts.delete(id)
  }
  clearPrivate(): void {
    for (const [id, draft] of this.drafts) if (draft.private) this.remove(id)
  }
  clear(): void {
    this.drafts.clear()
    this.characters = 0
  }
}
