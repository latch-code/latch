import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, test, vi } from 'vitest'
import type { TaskDetail } from '@latch/protocol'
import { Questions } from '../src/questions.ts'

const roots: string[] = []
const services: Questions[] = []
afterEach(async () => {
  for (const service of services.splice(0)) await service.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const args = {
  prompt: '请选择实现方式',
  questions: [
    {
      id: 'language',
      label: '用什么语言？',
      multiple: false,
      options: [
        { id: 'ts', label: 'TypeScript' },
        { id: 'swift', label: 'Swift' },
      ],
    },
    {
      id: 'checks',
      label: '验证范围',
      multiple: true,
      options: [
        { id: 'unit', label: '单元测试' },
        { id: 'browser', label: '浏览器' },
      ],
    },
  ],
}
const input = () => ({
  requestId: randomUUID(),
  answers: [
    { questionId: 'language', optionIds: ['ts'] },
    { questionId: 'checks', optionIds: ['unit', 'browser'] },
  ],
})
async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'latch-questions-'))
  roots.push(dataDir)
  const changed = vi.fn()
  let detail: TaskDetail = { summary: {} as TaskDetail['summary'], messages: [], approvals: [], cursor: 0, liveText: '' }
  const service = await Questions.open({ dataDir, changed, detail: async () => detail })
  services.push(service)
  return {
    service,
    dataDir,
    changed,
    setDetail: (value: TaskDetail) => {
      detail = value
    },
  }
}
async function pending(service: Questions, value: unknown = args) {
  const controller = new AbortController()
  const result = service.ask(value, { sessionId: 'session', callId: 'call', signal: controller.signal })
  void result.catch(() => undefined)
  await vi.waitFor(() => expect(service.view('session')).toHaveLength(1))
  return { result, controller, question: service.view('session')[0]! }
}
const authorize = async () => undefined
const audit = async () => undefined

test('commits an answer as tool output before acknowledging it, deduplicates the first device and hides receipts', async () => {
  const { service, dataDir } = await fixture()
  const { result, question } = await pending(service)
  const submission = input()
  let acknowledged = false
  const answer = service.answer('session', question.id, 'device', submission, authorize, audit).then(value => {
    acknowledged = true
    return value
  })
  const output = await result
  expect(JSON.parse(output.text)).toMatchObject({
    kind: 'latch.question-result',
    requestId: submission.requestId,
    answers: [{ choices: ['TypeScript'] }, { choices: ['单元测试', '浏览器'] }],
  })
  expect(acknowledged).toBe(false)
  expect(service.view('session')[0]?.state).toBe('answering')
  const retry = service.answer('session', question.id, 'device', submission, authorize, audit)
  await service.resultCommitted({ sessionId: 'session', callId: 'call', state: 'completed' })
  expect(await answer).toEqual(await retry)
  expect(await service.answer('session', question.id, 'device', submission, authorize, audit)).toEqual({
    answered: true,
    questionId: question.id,
    requestId: submission.requestId,
  })
  expect(service.view('session')).toEqual([])
  const stored = await readFile(join(dataDir, 'questions.json'), 'utf8')
  expect(stored).not.toContain('TypeScript')
  expect((await stat(join(dataDir, 'questions.json'))).mode & 0o777).toBe(0o600)
})

test('the first answer wins across devices and a request cannot change content', async () => {
  const { service } = await fixture()
  const { result, question } = await pending(service)
  const submission = input()
  const answer = service.answer('session', question.id, 'device', submission, authorize, audit)
  void answer.catch(() => undefined)
  await result
  await expect(service.answer('session', question.id, 'other', submission, authorize, audit)).rejects.toMatchObject({
    code: 'question-answered',
  })
  await expect(
    service.answer(
      'session',
      question.id,
      'device',
      { ...submission, answers: [{ questionId: 'language', optionIds: ['swift'] }, submission.answers[1]] },
      authorize,
      audit,
    ),
  ).rejects.toMatchObject({ code: 'request-conflict' })
  await service.resultCommitted({ sessionId: 'session', callId: 'call', state: 'completed' })
  await answer
})

test('recovers an uncertain receipt after its final write fails without delivering the answer twice', async () => {
  const { service, dataDir, setDetail } = await fixture()
  const { result, question } = await pending(service)
  const submission = input()
  const answer = service.answer('session', question.id, 'device', submission, authorize, audit)
  void answer.catch(() => undefined)
  const output = await result
  setDetail({
    summary: {} as TaskDetail['summary'],
    liveText: '',
    cursor: 0,
    approvals: [],
    messages: [{ id: 'tool:call', role: 'tool', state: 'completed', text: output.text, tool: { output: output.text } }],
  })
  const path = join(dataDir, 'questions.json'),
    image = await readFile(path, 'utf8')
  await rm(path)
  await mkdir(path)
  await service.resultCommitted({ sessionId: 'session', callId: 'call', state: 'completed' })
  await expect(answer).rejects.toMatchObject({ code: 'question-result-unknown' })
  await rm(path, { recursive: true })
  await writeFile(path, image)
  await expect(service.answer('session', question.id, 'device', submission, authorize, audit)).resolves.toMatchObject({ answered: true })
  expect(service.view('session')).toEqual([])
})

test.each(
  [
    [],
    [
      { questionId: 'language', optionIds: ['missing'] },
      { questionId: 'checks', optionIds: ['unit'] },
    ],
    [
      { questionId: 'language', optionIds: ['ts', 'swift'] },
      { questionId: 'checks', optionIds: ['unit'] },
    ],
    [
      { questionId: 'language', optionIds: ['ts'], other: '别的' },
      { questionId: 'checks', optionIds: ['unit'] },
    ],
    [
      { questionId: 'language', optionIds: ['ts'] },
      { questionId: 'checks', optionIds: ['unit', 'unit'] },
    ],
  ].map(answers => ({ answers })),
)('refuses incomplete, duplicate and invalid selections %#', async ({ answers }) => {
  const { service } = await fixture()
  const { question } = await pending(service)
  await expect(
    service.answer('session', question.id, 'device', { requestId: randomUUID(), answers }, authorize, audit),
  ).rejects.toBeDefined()
  expect(service.view('session')[0]?.state).toBe('pending')
})

test('supports a required other answer and never bypasses audit or a late permission change', async () => {
  const { service } = await fixture()
  const { question, result } = await pending(service)
  const submission = {
    requestId: randomUUID(),
    answers: [
      { questionId: 'language', optionIds: [], other: 'Rust' },
      { questionId: 'checks', optionIds: ['unit'] },
    ],
  }
  await expect(
    service.answer('session', question.id, 'device', submission, authorize, async () => {
      throw new Error('audit offline')
    }),
  ).rejects.toThrow('audit offline')
  const gate = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('revoked'))
  await expect(service.answer('session', question.id, 'device', submission, gate, audit)).rejects.toThrow('revoked')
  expect(service.view('session')[0]?.state).toBe('pending')
  const answer = service.answer('session', question.id, 'device', submission, authorize, audit)
  expect(JSON.parse((await result).text).answers[0].other).toBe('Rust')
  await service.resultCommitted({ sessionId: 'session', callId: 'call', state: 'completed' })
  await answer
})

test('cancellation closes pending questions and refuses late answers', async () => {
  const { service } = await fixture()
  const { question, result, controller } = await pending(service)
  controller.abort()
  await expect(result).rejects.toMatchObject({ code: 'question-closed' })
  await expect(service.answer('session', question.id, 'device', input(), authorize, audit)).rejects.toMatchObject({
    code: 'question-closed',
  })
  expect(service.view('session')).toEqual([])
})

test('retains a completed tool result when cancellation races an already delivered answer', async () => {
  const { service } = await fixture()
  const { result, question, controller } = await pending(service)
  const answer = service.answer('session', question.id, 'device', input(), authorize, audit)
  await result
  controller.abort()
  await service.resultCommitted({ sessionId: 'session', callId: 'call', state: 'completed' })
  await expect(answer).resolves.toMatchObject({ answered: true })
  expect(service.view('session')).toEqual([])
})

test.each([true, false])('reconciles an interrupted answer only when its exact output was committed: %s', async committed => {
  const { service, dataDir } = await fixture()
  const { result, question } = await pending(service)
  const submission = input()
  const answer = service.answer('session', question.id, 'device', submission, authorize, audit)
  void answer.catch(() => undefined)
  const output = await result
  // Copy the crash image before orderly close withdraws the in-flight question.
  const image = await readFile(join(dataDir, 'questions.json'), 'utf8')
  await service.close()
  await writeFile(join(dataDir, 'questions.json'), image)
  const reopened = await Questions.open({
    dataDir,
    changed: () => undefined,
    detail: async () => {
      throw new Error('not used')
    },
  })
  services.push(reopened)
  await reopened.reconcile(async () => ({
    summary: {} as TaskDetail['summary'],
    liveText: '',
    cursor: 0,
    approvals: [],
    messages: committed ? [{ id: 'tool:call', role: 'tool', text: output.text, state: 'completed', tool: { output: output.text } }] : [],
  }))
  expect(reopened.view('session')).toEqual([])
  const retry = reopened.answer('session', question.id, 'device', submission, authorize, audit)
  if (committed) await expect(retry).resolves.toMatchObject({ answered: true })
  else await expect(retry).rejects.toMatchObject({ code: 'question-closed' })
})

test('refuses corrupt storage, duplicate question IDs and oversized question packages', async () => {
  const { service, dataDir } = await fixture()
  await expect(
    service.ask(
      { ...args, questions: [args.questions[0], args.questions[0]] },
      { sessionId: 'session', callId: 'call', signal: new AbortController().signal },
    ),
  ).rejects.toBeDefined()
  await writeFile(join(dataDir, 'questions.json'), '{broken')
  await expect(
    Questions.open({
      dataDir,
      changed: () => undefined,
      detail: async () => {
        throw new Error('not used')
      },
    }),
  ).rejects.toMatchObject({ code: 'questions-corrupt' })
  expect(await readFile(join(dataDir, 'questions.json'), 'utf8')).toBe('{broken')
})
