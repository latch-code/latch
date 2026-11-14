import type { ReactNode } from 'react'
import { MODEL_FAILURE_NAMES, SERVICE_HEALTH_NAMES, type ProviderSummary, type ServiceHealth } from '@latch/protocol'
import { StatusDot, Tooltip } from '@latch/ui'
import { dateTime, relativeTime } from '../format.ts'

/**
 * How a model service fares, as the Host's real requests showed it: a word, a colour and the fine print. Amber is for
 * what passes by itself (it rests until a time, or answers slowly); red is for what failed and still does.
 */
export interface HealthWords {
  state: string
  tone: 'warn' | 'err'
  /** The latest failure by class, when it happened, and when the Host asks the service first again. */
  detail: string
}

export function healthWords(health: ServiceHealth | undefined, now = new Date()): HealthWords | undefined {
  if (!health) return undefined
  // A state that ended by itself is no state any more, though the catalog was read before it did.
  if (health.until && Date.parse(health.until) <= now.getTime()) return undefined
  const ago = health.at ? relativeTime(health.at, now) : ''
  const facts = [
    health.last ? `最近一次：${MODEL_FAILURE_NAMES[health.last]}` : '',
    ago ? (ago === '刚刚' ? ago : `${ago}前`) : '',
    (health.state === 'quota' || health.state === 'rate') && health.until ? `${dateTime(health.until)} 前先用其他服务` : '',
  ].filter(Boolean)
  return {
    state: SERVICE_HEALTH_NAMES[health.state],
    tone: health.state === 'failing' || health.state === 'key-invalid' ? 'err' : 'warn',
    detail: facts.join(' · '),
  }
}

/** What a model menu says of a service: only what stops it now. A slow or briefly limited service is a matter for its settings page. */
export function menuHealth(provider: Pick<ProviderSummary, 'health'> | undefined, now = new Date()): HealthWords | undefined {
  const state = provider?.health?.state
  return state === 'failing' || state === 'quota' || state === 'key-invalid' ? healthWords(provider!.health, now) : undefined
}

/** The dot beside a service's name in a menu; the word is in the name beside it, the rest on hover. */
export function HealthDot({ words }: { words: HealthWords }): ReactNode {
  // A plain title: inside a menu the heading takes no focus, and the word stands in the name beside the dot.
  return (
    <span className="service-health-dot" title={words.detail ? `${words.state} · ${words.detail}` : words.state}>
      <StatusDot tone={words.tone} />
    </span>
  )
}

/** A service's name in a menu heading, with its state when something stops it. */
export const nameWithHealth = (name: string, words: HealthWords | undefined): string => (words ? `${name} · ${words.state}` : name)

/** The line under a service's name in settings: dot, word, and the latest failure behind the tooltip. */
export function HealthLine({ health }: { health: ServiceHealth | undefined }): ReactNode {
  const words = healthWords(health)
  if (!words) return null
  return (
    <Tooltip content={words.detail || words.state}>
      <span className="service-health" data-tone={words.tone} tabIndex={0}>
        <StatusDot tone={words.tone} />
        {words.state}
      </span>
    </Tooltip>
  )
}
