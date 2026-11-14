import type { TestDevice } from '@latch/testkit'

/** Public fake-Agent input for the opt-in native GUI run, matching the browser Slash fixture. */
export const iosSlashEnvironment = {
  FAKE_ACP_COMMANDS: JSON.stringify(
    Array.from({ length: 200 }, (_, index) => ({
      name: `command-${String(index).padStart(3, '0')}`,
      description: index === 196 ? '检查方向字符 \u202E 提示' : `检查步骤 ${index}`,
      ...(index === 197 ? { input: { hint: '文件或目录' } } : {}),
    })),
  ),
  FAKE_ACP_CONFIG: 'options',
  FAKE_ACP_MODES: 'build,plan',
} as const

/** Called only with the temporary Host fixture's owner; the App still reads templates through its body window. */
export async function prepareIosSlash(owner: TestDevice): Promise<void> {
  for (const template of [
    { id: 'native-review', name: '代码审查', content: '检查 $ARGUMENTS 的正确性', scope: { kind: 'all' } },
    { id: 'native-trip', name: '重庆行程', content: '先列出行程计划，不执行任何命令。', scope: { kind: 'all' } },
  ])
    await owner.json(`prompts/${template.id}`, { method: 'PUT', body: template })
}
