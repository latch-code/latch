import { z } from 'zod'

export const PUSH_ACTIONS = { 'native.push.changed': z.strictObject({ enabled: z.boolean() }) } as const
