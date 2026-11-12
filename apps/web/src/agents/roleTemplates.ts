/**
 * 职责模板: plain starting text for a new Agent's 职责 and 指令. Choosing one only fills those two fields (and the name
 * while it is empty); it grants no tool, permission or preset, and the person edits everything freely.
 */
export interface RoleTemplate {
  label: string
  description: string
  instructions: string
}

export const ROLE_TEMPLATES: readonly RoleTemplate[] = [
  {
    label: '代码审阅',
    description: '审阅改动，指出问题和风险',
    instructions: [
      '审阅我给你的改动或分支。',
      '先说结论，再按严重程度列出问题：正确性、安全、边界情况、可读性。',
      '每个问题写明文件与行号、原因和建议的改法。',
      '不确定的地方直接说不确定，不要猜。',
    ].join('\n'),
  },
  {
    label: '周报',
    description: '把这周做过的事写成一页周报',
    instructions: [
      '根据我给你的记录、提交或笔记，写一份周报。',
      '分为：本周完成、进行中、下周计划、需要协助。',
      '每条一句话，写清结果，不写过程。',
      '没有依据的内容不要编。',
    ].join('\n'),
  },
  {
    label: '发布检查',
    description: '发布前逐项检查，列出没通过的',
    instructions: [
      '发布前按清单逐项检查：版本号、更新说明、测试与构建结果、迁移、配置与回滚方案。',
      '每项写「通过」「没通过」或「无法确认」，并附依据。',
      '最后列出必须先处理的项。',
    ].join('\n'),
  },
  {
    label: '资料整理',
    description: '查资料，写成一页摘要',
    instructions: [
      '围绕我给的主题收集和整理资料。',
      '写成一页摘要：要点、不同观点、还没弄清的问题。',
      '每条要点注明来源；读不到原文时说明。',
    ].join('\n'),
  },
]
