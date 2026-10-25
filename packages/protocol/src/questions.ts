/** Questions are private session detail, never part of a session-list snapshot. */
export interface AgentQuestion {
  id: string
  toolCallId: string
  prompt: string
  state: 'pending' | 'answering'
  questions: Array<{
    id: string
    label: string
    multiple: boolean
    options: Array<{ id: string; label: string; description?: string }>
  }>
}

export interface QuestionAnswer {
  questionId: string
  optionIds: string[]
  other?: string
}

export interface QuestionSubmission {
  requestId: string
  answers: QuestionAnswer[]
}

export interface QuestionReceipt {
  answered: true
  questionId: string
  requestId: string
}

/** The builtin tool's committed result; the chosen labels remain readable after its pending card disappears. */
export interface QuestionResult {
  kind: 'latch.question-result'
  requestId: string
  answers: Array<{ questionId: string; label: string; choices: string[]; other?: string }>
}
