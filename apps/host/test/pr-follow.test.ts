import { expect, it } from 'vitest'
import type { GitPrComment, GitPrState } from '@latch/protocol'
import type { StoredPrFollow } from '../src/session-meta.ts'
import { advancePrFollow, observedPr, followPrompt } from '../src/pr-follow.ts'

const stamp = (n: number) => new Date(1_750_000_000_000 + n * 1_000).toISOString()
const comment = (n: number): GitPrComment => ({ kind: 'comment', body: `comment-${n}`, author: 'reviewer', at: stamp(n) })
const state: GitPrState = {
  pr: {
    number: 2,
    url: 'https://github.com/example/test/pull/2',
    head: 'work',
    base: 'main',
    title: 'Review',
    state: 'open',
    draft: false,
  },
  checks: [{ name: 'ci', state: 'fail', completedAt: stamp(1) }],
  discussion: [comment(1), comment(2)],
}
const grant = { ...observedPr(state), deviceId: 'dev', revision: 'abcdefgh', urlHash: 'a'.repeat(64), enabled: true }

it('preserves seen checks and reviews after missing pages, and forwards only genuinely new comments when they return', () => {
  const partial = { ...state, checks: [], discussion: [comment(2)], discussionCapped: true as const }
  expect(advancePrFollow(grant, partial, stamp(3))).toBeUndefined()
  const update = { ...partial, discussion: [comment(2), comment(3)] }
  const changed = advancePrFollow(grant, update, stamp(4))!
  expect(changed.notice).toMatchObject({ comments: 1, failures: 0 })
  expect(advancePrFollow(changed, state, stamp(5))).toBeUndefined()
  const restored = { ...state, discussion: [comment(1), comment(2), comment(4)] }
  expect(advancePrFollow(changed, restored, stamp(6))!.notice).toMatchObject({ comments: 1, failures: 0 })
  const prompt = followPrompt(restored, changed)
  expect(prompt).toContain('comment-4')
  expect(prompt).not.toContain('comment-1')
})

it('bounds the cursor and does not redispatch previously evicted, older comments', () => {
  let current: StoredPrFollow = grant
  for (const start of [3, 203, 403]) {
    const rows = Array.from({ length: 200 }, (_, offset) => comment(start + offset))
    current = advancePrFollow(current, { ...state, discussion: rows }, stamp(start))!
  }
  expect(current.discussion).toHaveLength(512)
  expect(advancePrFollow(current, state, stamp(604))).toBeUndefined()
  expect(advancePrFollow(current, { ...state, discussion: [comment(605)] }, stamp(606))?.notice).toMatchObject({ comments: 1 })
})
