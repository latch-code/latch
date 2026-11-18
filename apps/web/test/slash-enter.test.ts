import { expect, it } from 'vitest'
import { needsInput } from '../src/composer/SlashCommands.tsx'

it('holds Enter back only for a command whose argument is required', () => {
  // No hint, or one the Harness marks optional: Enter runs the command and the input ends empty.
  for (const hint of [undefined, '', '筛选（可选）', 'filter (optional)', '[filter]', 'Optional: model name'])
    expect(needsInput(hint)).toBe(false)
  // A required argument keeps the command in the input, with its hint, for the person to finish.
  for (const hint of ['文件路径', '<path>', 'issue number', '[a] and b']) expect(needsInput(hint)).toBe(true)
})
