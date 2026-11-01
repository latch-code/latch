import { useEffect, useState } from 'react'
import type { AgentQuestion, QuestionAnswer, QuestionReceipt, QuestionResult, QuestionSubmission } from '@latch/protocol'
import { Button, InlineNotice, Kbd, Tooltip } from '@latch/ui'
import { api, inlineError } from '../core/api.ts'
import { escapeHiddenCharacters, VisibleText } from '../components/VisibleText.tsx'
import { useArmed } from './useArmed.ts'

export interface QuestionActions {
  deviceId: string
  canAnswer: boolean
  disabledReason?: string
  onChanged(): Promise<void>
}
interface Draft {
  step: number
  answers: QuestionAnswer[]
  other: string[]
  pending?: QuestionSubmission
}
function emptyDraft(question: AgentQuestion): Draft {
  return { step: 0, answers: question.questions.map(item => ({ questionId: item.id, optionIds: [] })), other: [] }
}
function readDraft(key: string, question: AgentQuestion): Draft {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')
    if (stored && typeof stored === 'object') {
      const value = stored as Draft
      if (
        Number.isInteger(value.step)
        && value.step >= 0
        && value.step < question.questions.length
        && Array.isArray(value.answers)
        && value.answers.length === question.questions.length
        && value.answers.every(
          (answer, index) =>
            answer?.questionId === question.questions[index]?.id
            && Array.isArray(answer.optionIds)
            && answer.optionIds.every(id => typeof id === 'string')
            && (answer.other === undefined || typeof answer.other === 'string'),
        )
        && Array.isArray(value.other)
        && value.other.every(id => typeof id === 'string')
        && (value.pending === undefined || (typeof value.pending.requestId === 'string' && Array.isArray(value.pending.answers)))
      )
        return value
    }
  } catch {
    /* An unreadable draft is replaced only after the user makes another choice. */
  }
  return emptyDraft(question)
}

/** What the drawer needs and what the composer's text does while a question waits. */
export interface QuestionDrawerState {
  question: AgentQuestion
  draft: Draft
  busy: boolean
  error: string
  locked: boolean
  choose: (optionId: string) => void
  /** The composer's text as the answer to the current question. */
  answerOther: (text: string) => void
  back: () => void
  next: () => void
  send: () => void
  complete: boolean
}

/** Drafts and an uncertain submission stay on this device; changing sessions never cancels an accepted write. */
export function useQuestionDrawer(
  question: AgentQuestion | undefined,
  sessionId: string,
  actions: QuestionActions,
): QuestionDrawerState | undefined {
  const storageKey = question && `latch.questions.${location.origin}.${actions.deviceId}.${sessionId}.${question.id}`
  const [held, setHeld] = useState<{ key: string; draft: Draft } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (!question || !storageKey) return undefined
  const draft = held?.key === storageKey ? held.draft : readDraft(storageKey, question)
  const answers = (value: Draft, index: number) => {
    const answer = value.answers[index]!
    return (
      (answer.optionIds.length > 0 || value.other.includes(answer.questionId))
      && (!value.other.includes(answer.questionId) || !!answer.other?.trim())
    )
  }
  const locked = busy || !!draft.pending || question.state === 'answering' || !actions.canAnswer
  const save = (value: Draft) => {
    setHeld({ key: storageKey, draft: value })
    try {
      localStorage.setItem(storageKey, JSON.stringify(value))
      setError('')
    } catch {
      setError('本设备无法保存回答草稿，请允许站点存储后重试。')
    }
  }
  const send = async (value: Draft) => {
    if (busy || !actions.canAnswer) return
    const submission = value.pending ?? {
      requestId: crypto.randomUUID(),
      answers: value.answers.map(answer => ({
        questionId: answer.questionId,
        optionIds: answer.optionIds,
        ...(value.other.includes(answer.questionId) ? { other: answer.other?.trim() ?? '' } : {}),
      })),
    }
    const pending = { ...value, pending: submission }
    try {
      localStorage.setItem(storageKey, JSON.stringify(pending))
    } catch {
      setError('本设备无法保存这次提交，请允许站点存储后重试。')
      return
    }
    setHeld({ key: storageKey, draft: pending })
    setBusy(true)
    setError('')
    try {
      const receipt = await api<QuestionReceipt>(
        `tasks/${encodeURIComponent(sessionId)}/questions/${encodeURIComponent(question.id)}/answer`,
        { method: 'POST', body: submission },
      )
      if (!receipt.answered || receipt.requestId !== submission.requestId || receipt.questionId !== question.id)
        throw new Error('回答回执不匹配，请重试这次提交')
      localStorage.removeItem(storageKey)
      await actions.onChanged()
    } catch (cause) {
      setError(`${inlineError(cause)} · 这次回答还在，重试会沿用它。`)
    } finally {
      setBusy(false)
    }
  }
  /** One answer settled: the next question, or, after the last, the whole answer goes. */
  const advance = (value: Draft) => {
    if (value.step < question.questions.length - 1) save({ ...value, step: value.step + 1 })
    else if (value.answers.every((_, index) => answers(value, index))) void send(value)
    else save(value)
  }
  const current = question.questions[draft.step]!
  const answer = draft.answers[draft.step]!
  const withAnswer = (next: Partial<QuestionAnswer>, other: boolean): Draft => ({
    ...draft,
    answers: draft.answers.map((value, index) => (index === draft.step ? { ...value, ...next } : value)),
    other: [...draft.other.filter(id => id !== current.id), ...(other ? [current.id] : [])],
  })
  return {
    question,
    draft,
    busy,
    error,
    locked,
    complete: answers(draft, draft.step),
    choose: optionId => {
      if (locked) return
      if (current.multiple) {
        const checked = answer.optionIds.includes(optionId)
        save(
          withAnswer(
            { optionIds: checked ? answer.optionIds.filter(id => id !== optionId) : [...answer.optionIds, optionId] },
            draft.other.includes(current.id),
          ),
        )
      } else advance(withAnswer({ optionIds: [optionId], other: undefined }, false))
    },
    answerOther: text => {
      if (locked) return
      advance(withAnswer({ other: text.slice(0, 2000), optionIds: current.multiple ? answer.optionIds : [] }, true))
    },
    back: () => {
      if (draft.step > 0) save({ ...draft, step: draft.step - 1 })
    },
    next: () => {
      advance(draft)
    },
    send: () => {
      void send(draft)
    },
  }
}

/**
 * The agent's question, attached above the composer: who asks, 1/2, and the options as buttons with their number keys.
 * 其他… hands over to the composer, where what is written answers this question. A choice on a single-choice question
 * answers it at once, so options arm as an approval's buttons do; several choices wait for 提交.
 */
export function QuestionDrawer({
  state,
  asker,
  disabledReason,
  canAnswer,
  onOther,
}: {
  state: QuestionDrawerState
  asker: string
  disabledReason?: string | undefined
  canAnswer: boolean
  onOther: () => void
}) {
  const { question, draft, locked } = state
  const current = question.questions[draft.step]!
  const answer = draft.answers[draft.step]!
  const options = current.options
  const armed = useArmed(`${question.id}:${draft.step}`)
  useEffect(() => {
    if (locked || !armed) return undefined
    const keydown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented || event.repeat) return
      if (
        event.target instanceof Element
        && event.target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], .ui-popover')
      )
        return
      const option = /^[1-9]$/u.test(event.key) ? options[Number(event.key) - 1] : undefined
      if (!option) return
      event.preventDefault()
      state.choose(option.id)
    }
    document.addEventListener('keydown', keydown)
    return () => {
      document.removeEventListener('keydown', keydown)
    }
  }, [locked, armed, options, state])
  const last = draft.step === question.questions.length - 1
  return (
    <section className="composer-drawer question-card" data-arming={armed ? undefined : ''} aria-label="Agent 提问">
      <div className="question-heading">
        <span>{asker} 想问你</span>
        {question.questions.length > 1 && (
          <span className="question-count">
            {draft.step + 1}/{question.questions.length}
          </span>
        )}
      </div>
      {question.prompt !== current.label && (
        <p className="question-prompt">
          <VisibleText text={question.prompt} />
        </p>
      )}
      <p className="question-label">
        <VisibleText text={current.label} />
        {current.multiple && <span className="question-hint">可多选</span>}
      </p>
      <div className="question-options" role="group" aria-label={escapeHiddenCharacters(current.label)}>
        {options.map((option, index) => (
          <Tooltip key={option.id} content={option.description ? escapeHiddenCharacters(option.description) : undefined}>
            <button
              type="button"
              className="question-option"
              disabled={locked}
              aria-disabled={armed ? undefined : true}
              aria-pressed={answer.optionIds.includes(option.id)}
              onClick={() => {
                if (armed) state.choose(option.id)
              }}>
              {index < 9 && <Kbd>{index + 1}</Kbd>}
              <VisibleText text={option.label} />
            </button>
          </Tooltip>
        ))}
        <button type="button" className="question-option question-other" disabled={locked} onClick={onOther}>
          其他…
        </button>
      </div>
      {!canAnswer && <InlineNotice>{disabledReason ?? '此设备没有回答权限。'}</InlineNotice>}
      {question.state === 'answering' && !draft.pending && <InlineNotice>已接收另一份回答，正在继续执行。</InlineNotice>}
      {state.error && <InlineNotice tone="error">{state.error}</InlineNotice>}
      {(current.multiple || draft.step > 0 || draft.pending) && (
        <div className="question-actions">
          {draft.step > 0 && !draft.pending && (
            <Button size="sm" disabled={state.busy} onClick={state.back}>
              上一题
            </Button>
          )}
          {draft.pending ? (
            <Button size="sm" variant="primary" loading={state.busy} onClick={state.send}>
              重试这次回答
            </Button>
          ) : current.multiple ? (
            <Button size="sm" variant="primary" loading={state.busy} disabled={!state.complete || locked} onClick={state.next}>
              {last ? '提交' : '下一题'}
            </Button>
          ) : null}
        </div>
      )}
    </section>
  )
}

export function QuestionResultCard({ text }: { text: string }) {
  let result: QuestionResult
  try {
    const value: unknown = JSON.parse(text)
    if (
      !value
      || typeof value !== 'object'
      || !('kind' in value)
      || value.kind !== 'latch.question-result'
      || !('answers' in value)
      || !Array.isArray(value.answers)
      || !value.answers.every(
        answer =>
          answer
          && typeof answer === 'object'
          && typeof answer.label === 'string'
          && Array.isArray(answer.choices)
          && answer.choices.every((choice: unknown) => typeof choice === 'string')
          && (answer.other === undefined || typeof answer.other === 'string'),
      )
    )
      return null
    result = value as QuestionResult
  } catch {
    return null
  }
  return (
    <details className="question-result">
      <summary>已回答 {result.answers.length} 题</summary>
      <dl>
        {result.answers.map((answer, index) => (
          <div key={index}>
            <dt>
              <VisibleText text={answer.label} />
            </dt>
            <dd>
              <VisibleText text={[...answer.choices, ...(answer.other ? [answer.other] : [])].join('、')} />
            </dd>
          </div>
        ))}
      </dl>
    </details>
  )
}
