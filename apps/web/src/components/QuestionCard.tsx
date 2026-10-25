import { useId, useState } from 'react'
import type { AgentQuestion, QuestionAnswer, QuestionReceipt, QuestionResult, QuestionSubmission } from '@latch/protocol'
import { Button, Checkbox, InlineNotice, Radio, TextAreaField, WaitingPill } from '@latch/ui'
import { api, inlineError } from '../core/api.ts'
import { VisibleText } from './VisibleText.tsx'

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

/** Drafts and an uncertain submission stay on this device; changing sessions never cancels an accepted write. */
export function QuestionCard({ question, sessionId, actions }: { question: AgentQuestion; sessionId: string; actions: QuestionActions }) {
  const storageKey = `latch.questions.${location.origin}.${actions.deviceId}.${sessionId}.${question.id}`
  const group = useId()
  const [draft, setDraft] = useState(() => readDraft(storageKey, question)),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const current = question.questions[draft.step]!,
    answer = draft.answers[draft.step]!,
    otherSelected = draft.other.includes(current.id)
  const complete = (index: number) => {
    const value = draft.answers[index]!
    return (
      (value.optionIds.length > 0 || draft.other.includes(value.questionId))
      && (!draft.other.includes(value.questionId) || !!value.other?.trim())
    )
  }
  const locked = busy || !!draft.pending || question.state === 'answering' || !actions.canAnswer
  const save = (value: Draft) => {
    setDraft(value)
    try {
      localStorage.setItem(storageKey, JSON.stringify(value))
      setError('')
    } catch {
      setError('本设备无法保存回答草稿，请允许站点存储后重试。')
    }
  }
  const update = (values: string[], other: boolean) =>
    save({
      ...draft,
      answers: draft.answers.map((value, index) =>
        index === draft.step ? { ...value, optionIds: values, ...(other ? {} : { other: undefined }) } : value,
      ),
      other: [...draft.other.filter(id => id !== current.id), ...(other ? [current.id] : [])],
    })
  const send = async () => {
    if (busy || !actions.canAnswer) return
    const submission = draft.pending ?? {
      requestId: crypto.randomUUID(),
      answers: draft.answers.map(value => ({
        questionId: value.questionId,
        optionIds: value.optionIds,
        ...(draft.other.includes(value.questionId) ? { other: value.other?.trim() ?? '' } : {}),
      })),
    }
    const pending = { ...draft, pending: submission }
    try {
      localStorage.setItem(storageKey, JSON.stringify(pending))
    } catch {
      setError('本设备无法保存这次提交，请允许站点存储后重试。')
      return
    }
    setDraft(pending)
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
    } catch (error) {
      setError(`${inlineError(error)} · 草稿已保留，重试会沿用这次回答。`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="question-card" aria-label="Agent 提问" data-message-id={`tool:${question.toolCallId}`}>
      <div className="question-heading">
        <WaitingPill>等你回答</WaitingPill>
        <span>
          第 {draft.step + 1} 题，共 {question.questions.length} 题
        </span>
      </div>
      <p className="question-prompt">
        <VisibleText text={question.prompt} />
      </p>
      <fieldset disabled={locked}>
        <legend>
          <VisibleText text={current.label} />
          {current.multiple && <span className="question-hint">可多选</span>}
        </legend>
        <div className="question-options">
          {current.options.map(option => {
            const checked = answer.optionIds.includes(option.id)
            const props = {
              label: <VisibleText text={option.label} />,
              description: option.description && <VisibleText text={option.description} />,
              checked,
              onChange: () =>
                update(
                  current.multiple
                    ? checked
                      ? answer.optionIds.filter(id => id !== option.id)
                      : [...answer.optionIds, option.id]
                    : [option.id],
                  current.multiple && otherSelected,
                ),
            }
            return current.multiple ? <Checkbox key={option.id} {...props} /> : <Radio key={option.id} name={group} {...props} />
          })}
          {current.multiple ? (
            <Checkbox label="其他…" checked={otherSelected} onChange={() => update(answer.optionIds, !otherSelected)} />
          ) : (
            <Radio name={group} label="其他…" checked={otherSelected} onChange={() => update([], true)} />
          )}
          {otherSelected && (
            <TextAreaField
              label="补充你的答案"
              value={answer.other ?? ''}
              maxLength={2000}
              rows={2}
              onChange={event =>
                save({
                  ...draft,
                  answers: draft.answers.map((value, index) => (index === draft.step ? { ...value, other: event.target.value } : value)),
                })
              }
            />
          )}
        </div>
      </fieldset>
      {!actions.canAnswer && <InlineNotice>{actions.disabledReason ?? '此设备没有回答权限。'}</InlineNotice>}
      {question.state === 'answering' && !draft.pending && <InlineNotice>已接收另一份回答，正在继续执行。</InlineNotice>}
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      <div className="question-actions">
        <span>草稿仅保存在本设备</span>
        <div>
          {draft.step > 0 && (
            <Button disabled={busy} onClick={() => save({ ...draft, step: draft.step - 1 })}>
              上一题
            </Button>
          )}
          {draft.step < question.questions.length - 1 && !draft.pending ? (
            <Button disabled={!complete(draft.step) || busy} onClick={() => save({ ...draft, step: draft.step + 1 })}>
              下一题
            </Button>
          ) : (
            <Button
              variant="primary"
              loading={busy}
              disabled={
                !actions.canAnswer
                || (question.state === 'answering' && !draft.pending)
                || !draft.answers.every((_, index) => complete(index))
              }
              onClick={() => {
                void send()
              }}>
              {draft.pending ? '重试这次回答' : '提交回答'}
            </Button>
          )}
        </div>
      </div>
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
