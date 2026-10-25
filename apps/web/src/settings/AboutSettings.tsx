import type { AppSnapshot } from '@latch/protocol'
import { BrandMark } from '../components/ui.tsx'
import { SectionHeading, SettingsGroup, SettingsRow } from './common.tsx'

export function AboutSettings({ snapshot }: { snapshot: AppSnapshot }) {
  return (
    <>
      <SectionHeading title="关于" />
      <SettingsGroup>
        <SettingsRow
          leading={<BrandMark size={32} />}
          record
          title="Latch"
          description={`跨设备的 Agent 工作台${snapshot.version ? ` · 版本 ${snapshot.version}` : ''}`}
        />
        <SettingsRow title="执行端" trailing={<span className="settings-row-value">{snapshot.hostName || '本机'}</span>} />
        <SettingsRow title="许可证" trailing={<span className="settings-row-value">Apache License 2.0</span>} />
      </SettingsGroup>
      <SettingsGroup title="数据与插件">
        <SettingsRow title="数据" description="会话、设置和密钥保存在执行端的本机运行目录；密钥不会发送到浏览器。" />
        <SettingsRow title="插件" description="插件和 Agent 是在执行端运行的可信本机代码。应用内的审批与路径检查不等于系统沙箱。" />
      </SettingsGroup>
    </>
  )
}
