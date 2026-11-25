/**
 * What the Host refused when it could not read an agent's permission mode back. `config`: a mode change, where nothing
 * was being sent. `send`: a message; `prompt` is one sent again from the transcript, which never sat in the input.
 */
export type RefusedInput = { from: 'config' } | { from: 'send'; prompt?: string; teamRequest?: true | undefined }

/** What 重试 sends: the input as it is now, else the prompt that was refused. With neither there is nothing to retry. */
export function retryOfRefused(
  refused: RefusedInput | undefined,
  input: { draft: string; attachments: number },
): { kind: 'draft' } | { kind: 'prompt'; prompt: string; teamRequest?: true } | undefined {
  if (input.draft.trim() || input.attachments > 0) return { kind: 'draft' }
  return refused?.from === 'send' && refused.prompt
    ? { kind: 'prompt', prompt: refused.prompt, ...(refused.teamRequest ? { teamRequest: true } : {}) }
    : undefined
}
