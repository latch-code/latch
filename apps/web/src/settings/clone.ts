// 克隆仓库's pure logic: what each fixed reason says and how far a clone is, for Settings › 项目.
import type { GitCloneState } from '@latch/protocol'
import { defineCopy } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    invalidAddress: '地址无效',
    addressFormat: '用 https:// 地址，或 ssh 形式（git@主机:路径）。不接受本地路径、选项或其他传输方式。',
    embeddedCredentials: '地址里带有凭据',
    removeCredentials: '去掉地址里的用户名、密码或令牌，用这台电脑上 Git 自己的登录（凭据管理工具或 SSH 密钥）。',
    missingFolderName: '从地址得不到文件夹名',
    folderExists: '这个位置已有同名文件夹',
    differentLocation: '换一个位置再克隆。',
    alreadyCloning: '另一个仓库正在克隆',
    authenticationFailed: '远端不接受凭据',
    checkCredentials: '在终端里检查 Git 对这个主机的登录或 SSH 密钥。',
    hostKeyRejected: '远端主机密钥没有通过验证',
    checkHostKey: '在终端里连一次这个主机，核对并记下主机密钥。',
    remoteUnreachable: '连不上远端',
    remoteMissing: '远端没有这个仓库',
    checkAddress: '检查地址；私有仓库也可能是没有权限。',
    timedOut: '克隆超时',
    cancelled: '已取消',
    invalidFolder: '这个位置不能作为项目文件夹',
    missingGit: '这台电脑上找不到 Git',
    updateRequired: '需要更新 Latch 后才能克隆',
    failed: '克隆失败',
    connecting: '连接中',
    receiving: '接收中',
    resolving: '整理中',
    checkout: '检出中',
    cloning: '克隆中',
  },
  {
    invalidAddress: 'Invalid address',
    addressFormat: 'Use an https:// address or the SSH form git@host:path. Local paths, options and other transports are unavailable.',
    embeddedCredentials: 'The address contains credentials',
    removeCredentials:
      'Remove any username, password or token from the address and use Git’s credential helper or SSH key on this computer.',
    missingFolderName: 'No folder name could be derived from the address',
    folderExists: 'A folder with this name already exists here',
    differentLocation: 'Choose a different location and clone again.',
    alreadyCloning: 'Another repository is being cloned',
    authenticationFailed: 'The remote rejected the credentials',
    checkCredentials: 'Check Git’s login or SSH key for this host in your terminal.',
    hostKeyRejected: 'The remote host key could not be verified',
    checkHostKey: 'Connect to this host from your terminal to verify and store its key.',
    remoteUnreachable: 'Couldn’t reach the remote',
    remoteMissing: 'The repository is unavailable on the remote',
    checkAddress: 'Check the address and your access if the repository is private.',
    timedOut: 'Clone timed out',
    cancelled: 'Cancelled',
    invalidFolder: 'This location cannot be a project folder',
    missingGit: 'Git was not found on this computer',
    updateRequired: 'Update Latch before cloning',
    failed: 'Clone failed',
    connecting: 'Connecting',
    receiving: 'Receiving',
    resolving: 'Resolving',
    checkout: 'Checking out',
    cloning: 'Cloning',
  },
)

/** A clone's short words for a reason it did not start or did not finish; the fine print goes in the hover. */
export function cloneCopy(code: string): { label: string; detail?: string } {
  switch (code) {
    case 'clone-url-invalid':
      return { label: COPY.invalidAddress, detail: COPY.addressFormat }
    case 'clone-url-credentials':
      return { label: COPY.embeddedCredentials, detail: COPY.removeCredentials }
    case 'clone-name-invalid':
      return { label: COPY.missingFolderName }
    case 'clone-folder-exists':
      return { label: COPY.folderExists, detail: COPY.differentLocation }
    case 'clone-busy':
      return { label: COPY.alreadyCloning }
    case 'clone-auth':
      return { label: COPY.authenticationFailed, detail: COPY.checkCredentials }
    case 'clone-host-key':
      return { label: COPY.hostKeyRejected, detail: COPY.checkHostKey }
    case 'clone-unreachable':
      return { label: COPY.remoteUnreachable }
    case 'clone-not-found-remote':
      return { label: COPY.remoteMissing, detail: COPY.checkAddress }
    case 'clone-timeout':
      return { label: COPY.timedOut }
    case 'clone-cancelled':
      return { label: COPY.cancelled }
    case 'workspace-folders-refused':
      return { label: COPY.invalidFolder }
    case 'git-no-git':
      return { label: COPY.missingGit }
    case 'host-outdated':
      return { label: COPY.updateRequired }
    default:
      return { label: COPY.failed }
  }
}

/** 「接收中 45%」: where a running clone is. */
export function cloneProgress(state: Pick<GitCloneState, 'progress'>): string {
  const progress = state.progress
  if (!progress) return COPY.cloning
  const label = COPY[progress.phase]
  return progress.percent !== undefined ? `${label} ${progress.percent}%` : label
}
