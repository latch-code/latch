import { draftConfig, projectFor, thinkingLevels } from '../composerChoice.ts'
import { FORK_CONTINUATION_PROMPT, forkSource } from '../forkChoice.ts'
import { askSideQuestion, sideQuestionRefusal } from '../conversation/SideQuestion.tsx'
import { openControlWhenShown } from '../composer/ComposerControl.tsx'
import { LATCH_ACTIONS, type LatchActionName } from '../composer/latchActions.ts'
import type { SlashAction } from '../composer/slash-options.ts'
import type { SessionSelectionIntent } from './useSessionController.ts'
import type { ShellState } from './useShellLayout.tsx'
import { topicOwner } from '../agents/chat.ts'
import { defineCopy } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    check: '先核对未确认的提交',
    sending: '正在发送',
    readOnly: '这台设备只能查看',
    locked: '当前暂不能更改选项',
    afterTurn: '这一轮结束后可用',
    unsupported: '这个 Harness 尚不支持',
    cannotFork: '这个会话尚不能分叉',
    noReasoning: '这个模型没有思考档位',
    changesDenied: '这台设备看不到项目改动',
  },
  {
    check: 'Check the unconfirmed submission first',
    sending: 'Sending',
    readOnly: 'This device can only view',
    locked: 'Options can’t be changed right now',
    afterTurn: 'Available after this turn',
    unsupported: 'This Harness doesn’t support this yet',
    cannotFork: 'This session can’t be forked yet',
    noReasoning: 'This model has no reasoning levels',
    changesDenied: 'This device can’t view project changes',
  },
)

/** Call with the input's shell projection: Home's draft is not the session still mounted behind it. */
export function composerActions(
  shell: ShellState,
  origin: 'slash' | 'palette' = 'slash',
): Array<SlashAction & { name: LatchActionName; label: string }> {
  const { selectedId, current, summary, catalog, submission, access } = shell
  const session = selectedId !== null && current?.summary.id === selectedId && !summary?.personal
  const harness = selectedId === null ? shell.chosenHarness : shell.harnessInfo
  const config = selectedId === null ? draftConfig(harness, shell.choice.config)?.config : current?.config
  const thinking =
    harness?.capabilities.models.owner === 'latch'
      ? !!catalog && thinkingLevels(catalog, shell.effectiveModel ?? shell.choice.model).length > 0
      : (config?.find(option => option.category === 'thought_level')?.options.length ?? 0) > 0
  const blocked = submission.pending
    ? COPY.check
    : submission.sending
      ? COPY.sending
      : !access.scopes.has('run')
        ? COPY.readOnly
        : undefined
  const locked = blocked ?? (shell.newChoicesLocked ? COPY.locked : undefined)
  const focus = () => requestAnimationFrame(() => shell.composerRef.current?.focus())
  const intent = (draft: string): SessionSelectionIntent => ({
    ...(origin === 'slash' ? { consumeDraft: { inputId: shell.inputId, text: submission.draft } } : {}),
    draft,
  })
  const consume = () => {
    if (origin === 'slash') shell.setSubmissionDraft('')
  }
  const invoke: Record<LatchActionName, (argument?: string) => void> = {
    clear: () => {
      shell.armClear(true)
    },
    btw: argument => {
      if (!argument || !current) {
        shell.setSubmissionDraft('/btw ')
        focus()
      } else void askSideQuestion(current, argument, projectFor(catalog, current.summary), shell.active)
    },
    fork: argument => {
      const last = current?.messages.at(-1)
      if (!current || !last) return
      const first = argument || (origin === 'palette' ? submission.draft : '') || FORK_CONTINUATION_PROMPT
      shell.startNewDraft(intent(first), () => {
        submission.setFork({
          taskId: current.summary.id,
          upToMessageId: last.id,
          title: current.summary.title,
          choice: {
            harnessId: current.summary.harnessId,
            workspaceId: projectFor(catalog, current.summary),
            mode: current.summary.mode ?? 'agent',
          },
          source: forkSource(current, harness),
        })
      })
    },
    new: argument =>
      shell.startNewDraft(origin === 'slash' || argument ? intent(argument || '') : undefined, () => {
        if (session && summary) submission.updateChoice({ harnessId: summary.harnessId })
      }),
    model: argument => {
      openControlWhenShown('model', 10, false, argument || undefined)
    },
    think: () => {
      openControlWhenShown('thinking', 10, false)
    },
    permissions: () => {
      openControlWhenShown('permission', 10, false)
    },
    changes: () => {
      shell.setRoute({ entry: 'sessions' })
      shell.openChangesTab()
    },
  }
  const reason: Partial<Record<LatchActionName, string | undefined>> = {
    clear: blocked ?? (shell.active ? COPY.afterTurn : !shell.clearable ? COPY.unsupported : undefined),
    btw: blocked ?? sideQuestionRefusal(catalog, harness),
    fork:
      blocked
      ?? (shell.active ? COPY.afterTurn : catalog?.features?.fork !== true || !current?.messages.length ? COPY.cannotFork : undefined),
    new: blocked,
    model: locked,
    think: locked ?? (!thinking ? COPY.noReasoning : undefined),
    permissions: locked,
    changes: !shell.canViewChanges ? COPY.changesDenied : undefined,
  }
  return LATCH_ACTIONS.flatMap(action => {
    if (action.name === 'new' && topicOwner(summary)) return []
    if (['clear', 'btw', 'fork'].includes(action.name) && !session) return []
    if (action.name === 'changes' && (!session || !projectFor(catalog, summary))) return []
    return [
      {
        ...action,
        description: action.label,
        run: argument => {
          if (action.name !== 'new' && action.name !== 'fork') consume()
          invoke[action.name](argument)
        },
        ...(reason[action.name] ? { unavailable: reason[action.name] } : {}),
      },
    ]
  })
}
