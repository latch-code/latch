import type { AutomationSummary, HelperAbility, TaskMode } from '@latch/protocol'

/**
 * What an Agent offers before anyone writes to it: three things to ask, each derived from what it can do here. Fixed text, no model call; a click fills the input and sends nothing.
 */
export interface OpeningAction {
  id: string
  label: string
  /** What goes into the input. */
  text: string
}

export interface OpeningInput {
  general: boolean
  description: string | undefined
  /** The abilities its Harness really has here (`helperCandidates`): files, commands, memory, schedule… */
  abilities: readonly HelperAbility[]
  mode: TaskMode
  /** Its own schedules, in the Host's order. */
  schedules: ReadonlyArray<Pick<AutomationSummary, 'name' | 'lastRun' | 'enabled'>>
  /** Whether a schedule can be saved for it to run on its own. */
  canAutomate: boolean
  /** The name of its default project, when it has one; else it works in its own folder. */
  project: string | undefined
}

const clip = (text: string, limit: number) => {
  const points = [...text.replace(/\s+/gu, ' ').trim()]
  return points.length > limit ? `${points.slice(0, limit - 1).join('')}…` : points.join('')
}

/**
 * Three things to ask, most specific first: its schedules (what the last run did), its folder or project, what it is for
 * (its description, for the person to finish), then what its Harness can do (run a command) and 「记住…」, which works on
 * every Harness. Only what it can really do: a Harness Latch has no card for gets no folder or command.
 */
export function openingActions(input: OpeningInput): OpeningAction[] {
  const actions: OpeningAction[] = []
  const can = (ability: HelperAbility) => input.abilities.includes(ability)
  const latest = input.schedules.toSorted((a, b) => (b.lastRun?.at ?? '').localeCompare(a.lastRun?.at ?? ''))[0]
  if (latest) {
    const name = clip(latest.name, 16)
    actions.push(
      latest.lastRun
        ? { id: 'schedule-last', label: `「${name}」上次怎么样`, text: `「${latest.name}」上次运行得怎么样？结果在哪？` }
        : { id: 'schedule-next', label: `「${name}」要做什么`, text: `「${latest.name}」每次会做什么？` },
    )
  } else if (can('schedule') && input.canAutomate)
    actions.push({ id: 'schedule-new', label: '每天帮我做一件事', text: '每个工作日早上 9 点，帮我' })
  if (input.mode !== 'chat' && can('files'))
    actions.push(
      input.project
        ? { id: 'folder', label: `看看「${clip(input.project, 12)}」`, text: `看看「${input.project}」里有什么，挑要紧的说。` }
        : { id: 'folder', label: '看看你的文件夹', text: '你的文件夹里现在有什么？列给我看。' },
    )
  // What it is for, in its own words: the person finishes the sentence.
  const duty = input.general ? undefined : input.description?.replace(/\s+/gu, ' ').trim()
  if (duty) actions.push({ id: 'duty', label: '交给你一件事', text: `${duty.replace(/[。.！!？?]+$/u, '')}：` })
  if (input.mode !== 'chat' && can('commands')) actions.push({ id: 'command', label: '帮我跑个命令', text: '帮我跑一下 ' })
  actions.push({ id: 'remember', label: '记住一件事', text: '记住：' })
  if (actions.length < 3) actions.push({ id: 'ask', label: '你能帮我做什么', text: '你能帮我做什么？举三个例子。' })
  if (actions.length < 3) actions.push({ id: 'intro', label: '你在这台电脑上能做什么', text: '你在这台电脑上能用哪些文件和工具？' })
  return actions.slice(0, 3)
}

/** Fills the input: the action's text where it is empty, after what is there otherwise, never in its place. */
export function fillDraft(draft: string, text: string): string {
  if (!draft.trim()) return text
  if (draft.includes(text)) return draft
  return `${draft.replace(/\s+$/u, '')}\n${text}`
}
