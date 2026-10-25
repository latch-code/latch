import type { HarnessPlugin, ToolDefinition } from '@latch/sdk'

interface QuestionsBackend {
  ask(args: unknown, context: { sessionId: string; callId: string; signal: AbortSignal }): Promise<{ text: string }>
  resultCommitted(context: { sessionId: string; callId: string; state: 'completed' | 'failed' | 'cancelled' }): Promise<void>
}

/** Only the Host-owned instance of this plugin is R0; a plugin's name alone never grants that classification. */
export function createQuestionsPlugin(backend: QuestionsBackend): HarnessPlugin {
  const tool: ToolDefinition = {
    name: 'ask_user',
    title: '向你提问',
    kind: 'other',
    description:
      'Ask the user one or more required choice questions before continuing. Each question supports single or multiple selections and a free-text Other answer. Waits until the user submits all answers; never use it to request secrets.',
    requiresApproval: false,
    waitsForUser: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['prompt', 'questions'],
      properties: {
        prompt: { type: 'string', maxLength: 2000 },
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: 10,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'label', 'options'],
            properties: {
              id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,80}$' },
              label: { type: 'string', maxLength: 1000 },
              multiple: { type: 'boolean', default: false },
              options: {
                type: 'array',
                minItems: 1,
                maxItems: 20,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['id', 'label'],
                  properties: {
                    id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,80}$' },
                    label: { type: 'string', maxLength: 500 },
                    description: { type: 'string', maxLength: 500 },
                  },
                },
              },
            },
          },
        },
      },
    },
    execute: (args, context) => backend.ask(args, context),
    resultCommitted: context => backend.resultCommitted(context),
  }
  return {
    id: 'user-questions',
    name: '向你提问',
    version: '0.1.0',
    description: '内置 Agent 的选择题与多题向导；回答仅交回当前会话。',
    activate(context) {
      context.registerTool(tool)
    },
  }
}
