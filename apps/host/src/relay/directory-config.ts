import { z } from 'zod'
import { directoryMirror, type NativeDirectorySource } from '@latch/link-wire'
import { canonicalJson, sha256Hex } from '@latch/core/node-kit'

const digest = z.string().regex(/^[a-f0-9]{64}$/u)
export const directoryCheckpoint = z.strictObject({ generation: z.int().positive(), hash: digest })
export const directoryFloorSchema = z.strictObject({
  minimum: directoryCheckpoint,
  minimumOnline: directoryCheckpoint.optional(),
})
export const directoryConfigSchema = z.strictObject({
  anchors: z
    .array(digest)
    .min(1)
    .max(2)
    .refine(values => new Set(values).size === values.length),
  mirrors: z
    .array(
      z
        .string()
        .max(512)
        .refine(value => {
          try {
            directoryMirror(value)
            return new URL(value).href === value
          } catch {
            return false
          }
        }),
    )
    .min(1)
    .max(4)
    .refine(values => new Set(values).size === values.length),
})
export type DirectoryConfig = z.infer<typeof directoryConfigSchema>
export type DirectoryFloor = z.infer<typeof directoryFloorSchema>
export const directoryConfigHash = (source: DirectoryConfig | null | undefined): string => sha256Hex(canonicalJson(source ?? null))
export function directorySource(config: DirectoryConfig, floor?: DirectoryFloor): NativeDirectorySource {
  return {
    anchors: config.anchors.map(value => Buffer.from(value, 'hex')),
    mirrors: [...config.mirrors],
    ...(floor ? { minimum: { generation: floor.minimum.generation, hash: Buffer.from(floor.minimum.hash, 'hex') } } : {}),
    ...(floor?.minimumOnline
      ? { minimumOnline: { generation: floor.minimumOnline.generation, hash: Buffer.from(floor.minimumOnline.hash, 'hex') } }
      : {}),
  }
}
