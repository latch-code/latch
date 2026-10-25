import type { PromptTemplate, SessionCommand } from '@latch/protocol'
import { escapeSecurityText } from '@latch/protocol'
export function slashMatches(draft: string, commands: readonly SessionCommand[]): SessionCommand[] {
  if (!/^\/[^\s]*$/u.test(draft)) return []
  const query = draft.slice(1).toLocaleLowerCase()
  return commands.filter(command => command.name.toLocaleLowerCase().includes(query)).slice(0, 20)
}
export function SlashCommands({
  draft,
  commands,
  templates = [],
  onDraft,
}: {
  draft: string
  commands: readonly SessionCommand[]
  templates?: readonly PromptTemplate[]
  onDraft: (text: string) => void
}) {
  const matches = slashMatches(draft, commands)
  const offered = /^\/[^\s]*$/u.test(draft)
    ? templates.filter(template => template.name.toLocaleLowerCase().includes(draft.slice(1).toLocaleLowerCase())).slice(0, 20)
    : []
  if (!matches.length && !offered.length) return null
  return (
    <section className="slash-commands" aria-label="命令与提示模板">
      <p>选择后可编辑，再发送</p>
      {offered.map(template => (
        <button type="button" key={`template:${template.id}`} onClick={() => onDraft(draft.replace(/^\/[^\s]*/u, () => template.content))}>
          <strong>{escapeSecurityText(template.name)}</strong>
          <span>提示模板</span>
        </button>
      ))}
      {matches.map(command => (
        <button type="button" key={command.name} onClick={() => onDraft(`/${command.name} `)}>
          <strong>/{escapeSecurityText(command.name)}</strong>
          <span>{escapeSecurityText(command.description ?? command.inputHint ?? '')}</span>
        </button>
      ))}
    </section>
  )
}
