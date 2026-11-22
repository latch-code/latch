import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { AgentQuestion, QuestionAnswer, QuestionReceipt, QuestionResult, QuestionSubmission } from '@latch/protocol'
import { Button, Drawer, Icon, InlineNotice, Kbd, MessageGlyph, Tooltip } from '@latch/ui'
import { api, ApiError, inlineError, MessageError } from '../core/api.ts'
import { escapeHiddenCharacters, VisibleText } from '../components/VisibleText.tsx'
import { cardTakesKeys, useArmed } from './useArmed.ts'
import { defineCopy, listText } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    cannotSaveDraft: '本设备无法保存回答草稿，请允许站点存储后重试。',
    cannotSaveAnswer: '本设备无法保存这次提交，请允许站点存储后重试。',
    badReceipt: '回答回执不匹配，请重试这次提交',
    answeredOtherDevice: '这个问题已在另一台设备回答',
    ended: '这个问题已经结束',
    retrySameAnswer: (value1: string) => `${value1} · 这次回答还在，重试会沿用它。`,
    question: 'Harness 提问',
    asks: ' 想问你',
    multiple: '可多选',
    other: '其他…',
    notAllowed: '此设备没有回答权限。',
    answeredElsewhere: '已在别处回答',
    previous: '上一题',
    retry: '重试这次回答',
    submit: '提交',
    next: '下一题',
    answeredPrefix: '已回答 ',
    answeredSuffix: ' 题',
  },
  {
    cannotSaveDraft: 'This device cannot save the answer draft. Allow site storage and try again.',
    cannotSaveAnswer: 'This device cannot save this answer. Allow site storage and try again.',
    badReceipt: 'The answer receipt did not match. Retry this answer.',
    answeredOtherDevice: 'Another device answered this question',
    ended: 'This question has ended',
    retrySameAnswer: (value1: string) => `${value1} · Your answer is kept for retry.`,
    question: 'Harness question',
    asks: ' asks',
    multiple: 'Choose any',
    other: 'Other…',
    notAllowed: 'This device cannot answer questions.',
    answeredElsewhere: 'Answered elsewhere',
    previous: 'Previous question',
    retry: 'Retry this answer',
    submit: 'Submit',
    next: 'Next question',
    answeredPrefix: 'Answered ',
    answeredSuffix: ' questions',
  },
)

export interface QuestionActions {
  deviceId: string
  canAnswer: boolean
  disabledReason?: string
  onChanged(): Promise<void>
  /** This answer was not needed: another device answered, or the question ended. Said once, not as an error. */
  onSettledElsewhere?(text: string): void
}
/** The Host's word that the question no longer waits for this answer. */
const SETTLED_ELSEWHERE = new Set(['question-answered', 'question-closed', 'question-not-found'])
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

interface SharedAnswer {
  draft: Draft
  busy: boolean
  error: (() => string) | null
}
interface AnswerStore {
  get(): SharedAnswer
  update(value: SharedAnswer): void
  subscribe(listener: () => void): () => void
}
const answersByQuestion = new Map<string, AnswerStore>()
function answerStore(key: string, question: AgentQuestion): AnswerStore {
  const previous = answersByQuestion.get(key)
  if (previous) return previous
  let value: SharedAnswer = { draft: readDraft(key, question), busy: false, error: null }
  const listeners = new Set<() => void>()
  // Home and the retained conversation share a write. Once neither renders it, only its durable draft remains.
  const release = () =>
    queueMicrotask(() => {
      if (!listeners.size && !value.busy && answersByQuestion.get(key) === store) answersByQuestion.delete(key)
    })
  const store: AnswerStore = {
    get: () => value,
    update: next => {
      value = next
      for (const listener of listeners) listener()
      release()
    },
    subscribe: listener => {
      listeners.add(listener)
      answersByQuestion.set(key, store)
      return () => {
        listeners.delete(listener)
        release()
      }
    },
  }
  answersByQuestion.set(key, store)
  return store
}
const noAnswer = { get: () => undefined, subscribe: () => () => {} }
function numberKeysAt(card: HTMLElement | null, target: EventTarget | null, pageKeys: boolean): boolean {
  return (
    cardTakesKeys(card, target)
    && (pageKeys || card?.contains(target instanceof Node ? target : null) === true)
    && !(
      target instanceof Element
      && target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], .ui-popover')
    )
  )
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
  const store = useMemo(() => (question && storageKey ? answerStore(storageKey, question) : undefined), [question?.id, storageKey])
  const shared = useSyncExternalStore(store?.subscribe ?? noAnswer.subscribe, store?.get ?? noAnswer.get, noAnswer.get)
  if (!question || !storageKey || !store || !shared) return undefined
  const { draft, busy, error } = shared
  const update = (changes: Partial<SharedAnswer>) => store.update({ ...store.get(), ...changes })
  const answers = (value: Draft, index: number) => {
    const answer = value.answers[index]!
    return (
      (answer.optionIds.length > 0 || value.other.includes(answer.questionId))
      && (!value.other.includes(answer.questionId) || !!answer.other?.trim())
    )
  }
  const locked = busy || !!draft.pending || question.state === 'answering' || !actions.canAnswer
  const save = (value: Draft) => {
    const latest = store.get()
    if (latest.busy || latest.draft.pending || latest.draft !== draft) return
    update({ draft: value })
    try {
      localStorage.setItem(storageKey, JSON.stringify(value))
      update({ error: null })
    } catch {
      update({ error: () => COPY.cannotSaveDraft })
    }
  }
  const send = async (value: Draft) => {
    const latest = store.get()
    if (latest.busy || !actions.canAnswer || latest.draft !== draft) return
    const submission = latest.draft.pending ?? {
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
      update({ error: () => COPY.cannotSaveAnswer })
      return
    }
    update({ draft: pending, busy: true, error: null })
    try {
      const receipt = await api<QuestionReceipt>(
        `tasks/${encodeURIComponent(sessionId)}/questions/${encodeURIComponent(question.id)}/answer`,
        { method: 'POST', body: submission },
      )
      if (!receipt.answered || receipt.requestId !== submission.requestId || receipt.questionId !== question.id)
        throw new MessageError(COPY.badReceipt)
      localStorage.removeItem(storageKey)
      await actions.onChanged()
    } catch (cause) {
      // Answered from another device, or the question is over: this answer is moot, and the session shows what happened.
      if (cause instanceof ApiError && SETTLED_ELSEWHERE.has(cause.code)) {
        localStorage.removeItem(storageKey)
        update({ draft: emptyDraft(question), error: null })
        actions.onSettledElsewhere?.(cause.code === 'question-answered' ? COPY.answeredOtherDevice : COPY.ended)
        await actions.onChanged().catch(() => {})
        return
      }
      update({ error: () => COPY.retrySameAnswer(inlineError(cause)) })
    } finally {
      update({ busy: false })
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
    error: error?.() ?? '',
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
  presentation,
  context,
  compact = false,
  firstKeys = false,
}: {
  presentation?: 'workbench' | 'conversation'
  context?: ReactNode
  compact?: boolean
  firstKeys?: boolean
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
  const card = useRef<HTMLElement>(null)
  const pageKeys = presentation !== 'workbench' || firstKeys
  const [numeric, setNumeric] = useState(false)
  useEffect(() => {
    const read = () => setNumeric(numberKeysAt(card.current, document.activeElement, pageKeys))
    read()
    const events = ['focusin', 'focusout', 'input', 'toggle'] as const
    for (const name of events) document.addEventListener(name, read, true)
    return () => {
      for (const name of events) document.removeEventListener(name, read, true)
    }
  }, [armed, pageKeys])
  useEffect(() => {
    if (locked || !armed) return undefined
    const keydown = (event: KeyboardEvent) => {
      if (!canAnswer || !numberKeysAt(card.current, event.target, pageKeys)) return
      if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented || event.repeat) return
      const option = /^[1-9]$/u.test(event.key) ? options[Number(event.key) - 1] : undefined
      if (!option) return
      event.preventDefault()
      state.choose(option.id)
    }
    document.addEventListener('keydown', keydown)
    return () => {
      document.removeEventListener('keydown', keydown)
    }
  }, [locked, armed, canAnswer, options, state, pageKeys])
  const last = draft.step === question.questions.length - 1
  return (
    <Drawer
      ref={card}
      className="question-card"
      data-question-id={question.id}
      // A question waits for the person: it keeps the product's own tokens under every customisation (tokens.css).
      data-lock=""
      data-presentation={presentation}
      data-compact={compact ? '' : undefined}
      data-arming={armed ? undefined : ''}
      label={COPY.question}>
      <div className="question-heading">
        <span className="question-kind" aria-hidden="true">
          <Icon icon={MessageGlyph} size={16} />
        </span>
        <span>
          {presentation ? (
            <VisibleText text={current.label} />
          ) : (
            <>
              {asker}
              {COPY.asks}
            </>
          )}
        </span>
        {question.questions.length > 1 && (
          <span className="question-count">
            {draft.step + 1}/{question.questions.length}
          </span>
        )}
      </div>
      {context}
      {question.prompt !== current.label && (
        <p className="question-prompt">
          <VisibleText text={question.prompt} />
        </p>
      )}
      <p className="question-label" hidden={!!presentation && !current.multiple}>
        <VisibleText text={current.label} />
        {current.multiple && <span className="question-hint">{COPY.multiple}</span>}
      </p>
      {canAnswer && (
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
                {index < 9 && armed && !locked && numeric && <Kbd>{index + 1}</Kbd>}
                <VisibleText text={option.label} />
              </button>
            </Tooltip>
          ))}
          <button type="button" className="question-option question-other" disabled={locked} onClick={onOther}>
            {COPY.other}
          </button>
        </div>
      )}
      {!canAnswer && <InlineNotice>{disabledReason ?? COPY.notAllowed}</InlineNotice>}
      {question.state === 'answering' && !draft.pending && <InlineNotice>{COPY.answeredElsewhere}</InlineNotice>}
      {state.error && <InlineNotice tone="error">{state.error}</InlineNotice>}
      {canAnswer && (current.multiple || draft.step > 0 || draft.pending) && (
        <div className="question-actions">
          {draft.step > 0 && !draft.pending && (
            <Button size="sm" variant="outline" disabled={state.busy} onClick={state.back}>
              {COPY.previous}
            </Button>
          )}
          {draft.pending ? (
            <Button size="sm" variant="primary" loading={state.busy} onClick={state.send}>
              {COPY.retry}
            </Button>
          ) : current.multiple ? (
            <Button size="sm" variant="primary" loading={state.busy} disabled={!state.complete || locked} onClick={state.next}>
              {last ? COPY.submit : COPY.next}
            </Button>
          ) : null}
        </div>
      )}
    </Drawer>
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
      <summary>
        {COPY.answeredPrefix}
        {result.answers.length}
        {COPY.answeredSuffix}
      </summary>
      <dl>
        {result.answers.map((answer, index) => (
          <div key={index}>
            <dt>
              <VisibleText text={answer.label} />
            </dt>
            <dd>
              <VisibleText text={listText([...answer.choices, ...(answer.other ? [answer.other] : [])], 'unit')} />
            </dd>
          </div>
        ))}
      </dl>
    </details>
  )
}
