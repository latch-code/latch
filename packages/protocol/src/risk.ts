import type { ApprovalRiskReason } from './types.ts'

/**
 * Why the Host classed a built-in request as high risk, in the words its approval card (after 「高风险 · 」) and the
 * local confirmation both use, so the person checks one sentence for one fact.
 */
export const RISK_REASON_TEXT: Readonly<Record<ApprovalRiskReason, string>> = {
  'code-root': 'Latch 程序目录内',
  'protected-path': '受保护的路径',
  'outside-workspace': '在会话文件夹之外',
  'unresolved-path': '不是会话文件夹内的相对路径',
  'unlisted-tool': '未登记的工具',
  'unparsable-arguments': '参数无法解析',
}
