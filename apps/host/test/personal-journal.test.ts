import { mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, test, vi } from 'vitest'
import { z } from 'zod'
import { PersonalJournal } from '../src/personal-journal.ts'
const roots: string[] = [],
  journals: Array<PersonalJournal<unknown>> = []
afterEach(async () => {
  for (const journal of journals.splice(0)) await journal.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const schema = z.strictObject({ version: z.literal(1), records: z.array(z.strictObject({ id: z.uuid(), value: z.string() })).max(20) })
const initial: z.infer<typeof schema> = { version: 1, records: [] }
async function root() {
  const dir = await mkdtemp(join(tmpdir(), 'latch-personal-journal-'))
  roots.push(dir)
  return dir
}

test('recovers only the exact durable intent after rename without calling the mutation a second time', async () => {
  const dir = await root()
  let fail = true
  const journal = await PersonalJournal.open(dir, 'activity.json', schema, initial, {
    atomicFs: {
      open,
      async rename(from, to) {
        await rename(from, to)
        if (fail) throw new Error('fsync fault')
      },
    },
  })
  journals.push(journal as PersonalJournal<unknown>)
  const id = randomUUID(),
    mutate = vi.fn((draft: typeof initial) => {
      draft.records.push({ id, value: 'private input' })
      return { value: id }
    })
  await expect(journal.change('original', 'hash', mutate)).rejects.toMatchObject({ code: 'personal-write-unknown' })
  expect(() => journal.read()).toThrow('修改结果尚未确认')
  await expect(journal.change('original', 'different', mutate)).rejects.toMatchObject({ status: 409 })
  await expect(journal.change('other', 'hash', mutate)).rejects.toMatchObject({ status: 503 })
  fail = false
  await journal.recover()
  expect(mutate).toHaveBeenCalledOnce()
  expect(journal.read().records).toEqual([{ id, value: 'private input' }])
  const reopened = await PersonalJournal.open(dir, 'activity.json', schema, initial)
  journals.push(reopened as PersonalJournal<unknown>)
  expect(reopened.read().records[0]?.id).toBe(id)
})

test('serializes updates and rechecks authorization after an awaited transaction', async () => {
  const dir = await root(),
    journal = await PersonalJournal.open(dir, 'activity.json', schema, initial)
  journals.push(journal as PersonalJournal<unknown>)
  await Promise.all(
    ['one', 'two'].map(value =>
      journal.change(value, value, draft => {
        draft.records.push({ id: randomUUID(), value })
        return { value: true }
      }),
    ),
  )
  expect(journal.read().records).toHaveLength(2)
  let allowed = true
  await expect(
    journal.change(
      'revoke',
      'hash',
      async draft => {
        draft.records.push({ id: randomUUID(), value: 'must not persist' })
        await Promise.resolve()
        allowed = false
        return { value: true }
      },
      () => {
        if (!allowed) throw Object.assign(new Error('revoked'), { status: 403 })
      },
    ),
  ).rejects.toMatchObject({ status: 403 })
  expect(journal.read().records).toHaveLength(2)
  const text = await readFile(join(dir, 'personal/activity.json'), 'utf8')
  expect(text).not.toContain('must not persist')
})

test('retains malformed private files and bounds initial and saved state', async () => {
  const dir = await root(),
    journal = await PersonalJournal.open(dir, 'activity.json', schema, initial, { maximumBytes: 1024 })
  journals.push(journal as PersonalJournal<unknown>)
  await expect(
    journal.change('large', 'hash', draft => {
      draft.records.push({ id: randomUUID(), value: 'x'.repeat(2048) })
      return { value: true }
    }),
  ).rejects.toMatchObject({ code: 'personal-storage-limit' })
  expect(journal.read().records).toHaveLength(0)
  const path = join(dir, 'personal/activity.json'),
    bad = JSON.stringify({ ...initial, secret: 'unknown field' })
  await writeFile(path, bad, { mode: 0o600 })
  await expect(PersonalJournal.open(dir, 'activity.json', schema, initial)).rejects.toMatchObject({ code: 'personal-journal-invalid' })
  expect(await readFile(path, 'utf8')).toBe(bad)
  await expect(PersonalJournal.open(dir, 'other.json', schema, initial, { maximumBytes: Infinity })).rejects.toMatchObject({
    code: 'personal-journal-budget',
  })
})
