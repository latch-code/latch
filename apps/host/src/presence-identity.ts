import { sha256Hex } from '@latch/core/node-kit'

declare const __LATCH_PRESENCE_TEAM__: string | null

export interface PresenceIdentity {
  teamId: string
  requirement: string
  launcherRequirement: string
  hash: string
}

/** The certificate class is part of the requirement: a development or ad-hoc signature is not a release. */
export function presenceIdentity(teamId: string): PresenceIdentity {
  if (!/^[A-Z0-9]{10}$/u.test(teamId)) throw new Error('发布构建需要有效的 Apple Team ID')
  const requirement = (identifier: string) =>
    `anchor apple generic and identifier "${identifier}" and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${teamId}"`
  const helper = requirement('dev.latch.presence')
  return { teamId, requirement: helper, launcherRequirement: requirement('dev.latch.presence-launch'), hash: sha256Hex(helper) }
}

/** Compiled into the Host and CLI; policy.json stores only its digest, never the authority to trust. */
export function releasePresenceIdentity(): PresenceIdentity | undefined {
  const team = typeof __LATCH_PRESENCE_TEAM__ === 'undefined' ? null : __LATCH_PRESENCE_TEAM__
  return team === null ? undefined : presenceIdentity(team)
}
