import { expect, it } from 'vitest'
import type { QuestionResult } from '@latch/protocol'
import { cursorAsk, elicitationAsk } from '../src/questions.ts'

const result = (answers: QuestionResult['answers']): QuestionResult => ({ kind: 'latch.question-result', requestId: 'r', answers })

it('maps an answer back by option position, so equal labels cannot misroute it', () => {
  const ask = elicitationAsk({
    mode: 'form',
    message: 'Which?',
    requestedSchema: { properties: { pick: { type: 'string', enum: ['x', 'y'], enumNames: ['Same', 'Same'] } } },
  })!
  expect(ask.questions[0]!.options.map(option => option.label)).toEqual(['Same', 'Same'])
  expect(ask.reply(result([{ questionId: 'q0', label: 'Which?', optionIds: ['o1'], choices: ['Same'] }]))).toEqual({
    action: 'accept',
    content: { pick: 'y' },
  })
  const cursor = cursorAsk({
    toolCallId: 't',
    questions: [
      {
        id: 'q',
        prompt: 'P',
        options: [
          { id: 'a', label: 'Same' },
          { id: 'b', label: 'Same' },
        ],
      },
    ],
  })!.ask!
  expect(cursor.reply(result([{ questionId: 'q0', label: 'P', optionIds: ['o1'], choices: ['Same'] }]))).toEqual({
    outcome: { outcome: 'answered', answers: [{ questionId: 'q', selectedOptionIds: ['b'] }] },
  })
})

it('refuses at once what is longer than a card holds, never cutting it', () => {
  const schema = (title: string) => ({ properties: { a: { type: 'string', title } } })
  expect(elicitationAsk({ mode: 'form', message: 'm'.repeat(2001), requestedSchema: schema('a') })).toBeUndefined()
  expect(elicitationAsk({ mode: 'form', message: 'ok', requestedSchema: schema('t'.repeat(1001)) })).toBeUndefined()
  expect(
    elicitationAsk({ mode: 'form', message: 'ok', requestedSchema: { properties: { a: { type: 'string', enum: ['o'.repeat(501)] } } } }),
  ).toBeUndefined()
  // A consent question is the message itself.
  expect(elicitationAsk({ mode: 'form', message: 'm'.repeat(1001), requestedSchema: { properties: {} } })).toBeUndefined()
  expect(cursorAsk({ toolCallId: 't', questions: [{ id: 'q', prompt: 'p'.repeat(2001), options: [] }] })).toMatchObject({ tooLong: true })
  expect(elicitationAsk({ mode: 'url', message: 'x', url: 'https://example.invalid' })).toBeUndefined()
})
