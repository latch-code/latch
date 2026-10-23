/** A trusted local plugin. Load with --plugin ./examples/text-statistics.mjs. */
export default {
  id: 'text-statistics',
  name: '文本统计',
  version: '1.0.0',
  description: '统计字符、行数和英文单词，不读写磁盘。',
  activate(context) {
    context.registerTool({
      name: 'text_statistics',
      description: 'Count characters, lines, and whitespace-separated words in supplied text.',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
      requiresApproval: false,
      async execute(args, { signal }) {
        signal.throwIfAborted()
        if (typeof args.text !== 'string' || args.text.length > 65536 || Object.keys(args).some(key => key !== 'text')) throw new Error('text must be a string of at most 65536 characters')
        return { text: JSON.stringify({ characters: [...args.text].length, lines: args.text.split('\n').length, words: args.text.trim() ? args.text.trim().split(/\s+/).length : 0 }) }
      },
    })
  },
}
