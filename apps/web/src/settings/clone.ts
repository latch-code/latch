// 克隆仓库's pure logic: what each fixed reason says and how far a clone is, for Settings › 项目.
import type { GitCloneState } from '@latch/protocol'

/** A clone's short words for a reason it did not start or did not finish; the fine print goes in the hover. */
export function cloneCopy(code: string): { label: string; detail?: string } {
  switch (code) {
    case 'clone-url-invalid':
      return { label: '地址无效', detail: '用 https:// 地址，或 ssh 形式（git@主机:路径）。不接受本地路径、选项或其他传输方式。' }
    case 'clone-url-credentials':
      return { label: '地址里带有凭据', detail: '去掉地址里的用户名、密码或令牌，用这台电脑上 Git 自己的登录（凭据助手或 SSH 密钥）。' }
    case 'clone-name-invalid':
      return { label: '从地址得不到文件夹名' }
    case 'clone-folder-exists':
      return { label: '这个位置已有同名文件夹', detail: '换一个位置再克隆。' }
    case 'clone-busy':
      return { label: '另一个仓库正在克隆' }
    case 'clone-auth':
      return { label: '远端不接受凭据', detail: '在终端里检查 Git 对这个主机的登录或 SSH 密钥。' }
    case 'clone-host-key':
      return { label: '远端主机密钥没有通过验证', detail: '在终端里连一次这个主机，核对并记下主机密钥。' }
    case 'clone-unreachable':
      return { label: '连不上远端' }
    case 'clone-not-found-remote':
      return { label: '远端没有这个仓库', detail: '检查地址；私有仓库也可能是没有权限。' }
    case 'clone-timeout':
      return { label: '克隆超时' }
    case 'clone-cancelled':
      return { label: '已取消' }
    case 'workspace-folders-refused':
      return { label: '这个位置不能作为项目文件夹' }
    case 'git-no-git':
      return { label: '这台电脑上找不到 Git' }
    case 'host-outdated':
      return { label: '需要更新 Latch 后才能克隆' }
    default:
      return { label: '克隆失败' }
  }
}

const PHASE_WORD: Record<NonNullable<GitCloneState['progress']>['phase'], string> = {
  connecting: '连接中',
  receiving: '接收中',
  resolving: '整理中',
  checkout: '检出中',
}

/** 「接收中 45%」: where a running clone is. */
export function cloneProgress(state: Pick<GitCloneState, 'progress'>): string {
  const progress = state.progress
  if (!progress) return '克隆中'
  return progress.percent !== undefined ? `${PHASE_WORD[progress.phase]} ${progress.percent}%` : PHASE_WORD[progress.phase]
}
