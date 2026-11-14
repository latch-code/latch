import type { SessionSkill } from './sessions.ts'
import { scalarUtf8Length } from './task-delta.ts'

export const MAX_SESSION_SKILLS_BYTES = 65_536

const SCOPES: ReadonlySet<string> = new Set(['project', 'user', 'system', 'admin', 'temporary'])
const FIELDS: ReadonlySet<string> = new Set(['name', 'description', 'invocation', 'scope'])

/** A bounded public catalogue. A private or unknown field makes it unusable, never something to forward. */
export function readSessionSkills(value: unknown): SessionSkill[] | undefined {
  if (!Array.isArray(value) || value.length > 200) return undefined
  const result: SessionSkill[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !FIELDS.has(key))) return undefined
    const { name, description, invocation, scope } = item as Record<string, unknown>
    if (
      typeof name !== 'string'
      || !name.length
      || name.length > 100
      || scalarUtf8Length(name) === undefined
      || /[\s\u0000-\u001f\u007f]/u.test(name)
      || (description !== undefined && (typeof description !== 'string' || description.length > 1000))
      || (typeof description === 'string' && scalarUtf8Length(description) === undefined)
      || typeof invocation !== 'string'
      || (invocation !== `$${name}` && invocation !== `/skill:${name}`)
      || seen.has(invocation)
      || (scope !== undefined && (typeof scope !== 'string' || !SCOPES.has(scope)))
    )
      return undefined
    seen.add(invocation)
    result.push({
      name,
      ...(description === undefined ? {} : { description: description as string }),
      invocation,
      ...(scope === undefined ? {} : { scope: scope as SessionSkill['scope'] }),
    })
  }
  const bytes = scalarUtf8Length(JSON.stringify({ skills: result, skillsTruncated: true }))
  return bytes !== undefined && bytes <= MAX_SESSION_SKILLS_BYTES ? result : undefined
}

/** Names take the budget first. Optional descriptions never hide a later callable name. */
export function boundSessionSkills(list: readonly SessionSkill[]): { skills: SessionSkill[]; skillsTruncated?: true } {
  const skills: SessionSkill[] = []
  const originals: SessionSkill[] = []
  let bytes = scalarUtf8Length(JSON.stringify({ skills: [], skillsTruncated: true }))!
  let truncated = false
  for (const skill of list) {
    const { name, invocation, scope } = skill
    const base: SessionSkill = { name, invocation, ...(scope ? { scope } : {}) }
    const size = (scalarUtf8Length(JSON.stringify(base)) ?? MAX_SESSION_SKILLS_BYTES) + (skills.length ? 1 : 0)
    if (skills.length === 200 || bytes + size > MAX_SESSION_SKILLS_BYTES) {
      truncated = true
      continue
    }
    skills.push(base)
    originals.push(skill)
    bytes += size
  }
  for (const [index, original] of originals.entries()) {
    if (original.description === undefined) continue
    const size = scalarUtf8Length(JSON.stringify({ description: original.description }))
    if (size === undefined || bytes + size - 1 > MAX_SESSION_SKILLS_BYTES) continue
    skills[index]!.description = original.description
    bytes += size - 1
  }
  return { skills, ...(truncated ? { skillsTruncated: true } : {}) }
}
