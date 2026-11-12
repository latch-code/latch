import type { ApprovalRiskReason } from './types.ts'

/**
 * Why the Host classed a built-in request as high risk, as one plain clause after the object it names (「写入 ~/.zshrc ·
 * 在项目文件夹之外」), in the words the approval drawer and the confirmation details both use.
 */
export const RISK_REASON_TEXT: Readonly<Record<ApprovalRiskReason, string>> = {
  'code-root': 'Latch 自己的代码',
  'protected-path': '受保护的文件',
  'outside-workspace': '在项目文件夹之外',
  'unresolved-path': '不是项目里的相对路径',
  'unlisted-tool': 'Latch 不认识的工具',
  'unparsable-arguments': '参数无法解析',
  'sensitive-field': '密码等敏感输入框',
  'mcp-tool': '远程 MCP 服务器的工具',
}
