import type { AppSnapshot } from '../../shared/types.ts'
import { BrandMark } from '../components/ui.tsx'
import { SectionHeading } from './common.tsx'

export function AboutSettings({ snapshot }: { snapshot: AppSnapshot }) {
  return <>
    <SectionHeading title="关于" />
    <div className="about-card">
      <BrandMark size={48} />
      <div><strong>Latch</strong><span>跨设备的 Agent 工作台{snapshot.version ? ` · 版本 ${snapshot.version}` : ''}</span></div>
    </div>
    <dl className="about-list">
      <div><dt>执行端</dt><dd>{snapshot.hostName || '本机'}</dd></div>
      <div><dt>数据</dt><dd>会话、设置和密钥保存在执行端的本机运行目录；密钥不会发送到浏览器。</dd></div>
      <div><dt>插件</dt><dd>插件和 Agent 是在执行端运行的可信本机代码。应用内的审批与路径检查不等于系统沙箱。</dd></div>
      <div><dt>许可证</dt><dd>Apache License 2.0</dd></div>
    </dl>
  </>
}
