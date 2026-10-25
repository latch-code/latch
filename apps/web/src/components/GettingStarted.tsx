import { useEffect, useRef, useState } from 'react'
import { Button } from '@latch/ui'
import { setPreference, usePreferences } from '../preferences.ts'
export function GettingStarted({
  sessionCount,
  ready,
  project,
  firstTask,
  remote,
}: {
  sessionCount: number
  ready: boolean
  project: string
  firstTask: () => void
  remote: boolean
}) {
  const preferences = usePreferences(),
    initial = useRef(sessionCount),
    [skipped, setSkipped] = useState<Set<number>>(new Set())
  useEffect(() => {
    if (sessionCount > initial.current) setPreference('onboarding', 'hidden')
  }, [sessionCount])
  if (preferences.onboarding === 'hidden' || (preferences.onboarding === 'auto' && sessionCount > 0)) return null
  const rows = [
    {
      title: '选择 Agent 与模型',
      detail: ready
        ? '已就绪，可在上方切换。'
        : remote
          ? '请在执行端电脑上安装 Agent 或配置模型服务。'
          : '在上方选择 Agent，或在设置中连接模型服务。',
    },
    {
      title: '选择项目',
      detail: project
        ? `当前项目：${project}`
        : remote
          ? '项目文件保存在执行端电脑；请从已登记项目中选择。'
          : '在输入框底部选择项目文件夹。',
    },
    { title: '写下第一个任务', detail: '描述你想完成的事情，发送后可在其他设备上继续。' },
  ]
  return (
    <section className="getting-started" aria-label="开始使用">
      {rows.map(
        (row, index) =>
          !skipped.has(index) && (
            <div key={row.title}>
              <span className="getting-started-step">{index + 1}</span>
              <div>
                <strong>{row.title}</strong>
                <p>{row.detail}</p>
              </div>
              {index === 2 && (
                <Button size="sm" variant="ghost" onClick={firstTask}>
                  开始输入
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setSkipped(previous => new Set([...previous, index]))
                  if (skipped.size === 2) setPreference('onboarding', 'hidden')
                }}>
                跳过
              </Button>
            </div>
          ),
      )}
    </section>
  )
}
