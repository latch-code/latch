/** A read-only panel for any Harness, loaded with --plugin. No files, processes or network calls. */
export default {
  id: 'session-overview',
  name: '会话概览',
  version: '1.0.0',
  description: '把当前会话的执行信息放在同一块面板里。',
  activate(ctx) {
    ctx.registerUiPanel({
      id: 'overview',
      title: '执行概览',
      description: '来自当前会话的实际状态。',
      render({ session, signal }) {
        signal.throwIfAborted()
        const states = {
          idle: '已完成',
          running: '运行中',
          'waiting-approval': '等你处理',
          cancelled: '已取消',
          failed: '失败',
          interrupted: '已中断',
        }
        return {
          blocks: [
            {
              type: 'facts',
              items: [
                { label: '会话', value: session.title },
                { label: '状态', value: states[session.status] ?? session.status },
                { label: '方式', value: session.mode === 'chat' ? '只对话' : 'Agent' },
                { label: '工作目录', value: session.cwd ?? '未指定' },
              ],
            },
          ],
        }
      },
    })
  },
}
