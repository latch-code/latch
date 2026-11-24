import type { AutomationSummary, HelperAbility, TaskMode } from '@latch/protocol'
import { defineCopy } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    scheduleLast: (name: string) => `「${name}」上次怎么样`,
    scheduleNext: (name: string) => `「${name}」要做什么`,
    scheduleNew: '安排工作日晨报',
    newSchedulePrompt: '每个工作日早上 9 点，为我整理一份晨报。我希望关注：',
    scheduleLastPrompt: (name: string) => `「${name}」上次运行得怎么样？结果在哪？`,
    scheduleNextPrompt: (name: string) => `「${name}」每次会做什么？`,
    projectPrompt: (name: string) => `帮我梳理「${name}」里的材料，列出最重要的三点，并注明来自哪个文件。`,
    dutyPrompt: (duty: string) => `${duty}。这次的材料或问题是：`,
    rememberPrompt: '记住：',
    summarize: '把材料整理成摘要',
    summarizePrompt: '帮我把下面的材料整理成一页摘要，先写结论，再列三条要点：',
    steps: '拆解下一步',
    stepsPrompt: '帮我把这件事拆成三个可以开始的步骤：',
    project: (name: string) => `梳理「${name}」的材料`,
    remember: '记住一件事',
  },
  {
    scheduleLast: (name: string) => `How did “${name}” go?`,
    scheduleNext: (name: string) => `What will “${name}” do?`,
    scheduleNew: 'Set up a weekday briefing',
    newSchedulePrompt: 'Prepare a briefing for me at 9 am every weekday. Focus on: ',
    scheduleLastPrompt: (name: string) => `How did “${name}” go last time? Where are the results?`,
    scheduleNextPrompt: (name: string) => `What will “${name}” do each time it runs?`,
    projectPrompt: (name: string) => `Summarize the materials in “${name}” in three key points and name the source file for each one.`,
    dutyPrompt: (duty: string) => `${duty}. Here is what I need this time: `,
    rememberPrompt: 'Remember: ',
    summarize: 'Summarize my notes',
    summarizePrompt: 'Turn the material below into a one-page summary. Start with the conclusion and list three key points: ',
    steps: 'Plan my next steps',
    stepsPrompt: 'Break this task down into three steps I can start today: ',
    project: (name: string) => `Summarize “${name}”`,
    remember: 'Remember something',
  },
)

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

/** Drafts the person can finish with their own material. Context-specific work comes before general examples. */
export function openingActions(input: OpeningInput): OpeningAction[] {
  const actions: OpeningAction[] = []
  const can = (ability: HelperAbility) => input.abilities.includes(ability)
  const latest = input.schedules.toSorted((a, b) => (b.lastRun?.at ?? '').localeCompare(a.lastRun?.at ?? ''))[0]
  if (latest) {
    const name = clip(latest.name, 16)
    actions.push(
      latest.lastRun
        ? { id: 'schedule-last', label: COPY.scheduleLast(name), text: COPY.scheduleLastPrompt(latest.name) }
        : { id: 'schedule-next', label: COPY.scheduleNext(name), text: COPY.scheduleNextPrompt(latest.name) },
    )
  }
  const duty = input.general
    ? undefined
    : input.description
        ?.replace(/\s+/gu, ' ')
        .trim()
        .replace(/[。.！!？?]+$/u, '')
  if (duty) actions.push({ id: 'duty', label: clip(duty, 24), text: COPY.dutyPrompt(duty) })
  else actions.push({ id: 'summarize', label: COPY.summarize, text: COPY.summarizePrompt })
  if (input.mode !== 'chat' && can('files') && input.project)
    actions.push({ id: 'folder', label: COPY.project(clip(input.project, 12)), text: COPY.projectPrompt(input.project) })
  if (!latest && can('schedule') && input.canAutomate)
    actions.push({ id: 'schedule-new', label: COPY.scheduleNew, text: COPY.newSchedulePrompt })
  actions.push({ id: 'remember', label: COPY.remember, text: COPY.rememberPrompt })
  actions.push({ id: 'steps', label: COPY.steps, text: COPY.stepsPrompt })
  return actions.slice(0, 3)
}

/** Fills the input: the action's text where it is empty, after what is there otherwise, never in its place. */
export function fillDraft(draft: string, text: string): string {
  if (!draft.trim()) return text
  if (draft.includes(text)) return draft
  return `${draft.replace(/\s+$/u, '')}\n${text}`
}
