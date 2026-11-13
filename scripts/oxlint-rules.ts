/**
 * Latch's own lint rules, loaded by oxlint as a JS plugin (.oxlintrc.json `jsPlugins`).
 *
 * `latch/page-error-text`: in apps/web/src a plain `Error` carries only an ASCII string literal (an internal code or a
 * developer's note). Text for the person goes in `MessageError` (apps/web/src/core/api.ts), which `errorMessage` shows
 * as it is; a plain `Error` there reads as 「页面出错了」.
 */
interface Node {
  type: string
  name?: string
  value?: unknown
  callee?: Node
  arguments?: Node[]
}
interface Context {
  report(problem: { node: Node; message: string }): void
}

function check(context: Context, node: Node) {
  if (node.callee?.type !== 'Identifier' || node.callee.name !== 'Error') return
  const first = node.arguments?.[0]
  if (first === undefined) return
  if (first.type === 'Literal' && typeof first.value === 'string' && /^[\x20-\x7e]*$/u.test(first.value)) return
  context.report({
    node,
    message: '给人看的错误文字用 MessageError（apps/web/src/core/api.ts）；Error 只带 ASCII 字面量的内部代码。',
  })
}

export default {
  meta: { name: 'latch' },
  rules: {
    'page-error-text': {
      create: (context: Context) => ({
        NewExpression: (node: Node) => check(context, node),
        CallExpression: (node: Node) => check(context, node),
      }),
    },
  },
}
