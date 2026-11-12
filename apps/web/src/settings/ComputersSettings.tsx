import { useEffect, useState } from 'react'
import { Laptop } from 'lucide-react'
import { Button, Hint, InlineNotice, StatusWord, type StatusTone } from '@latch/ui'
import { ConfirmDialog } from '../components/overlays.tsx'
import { shellComputers, type ComputersView, type ComputerView } from '../core/shell.ts'
import { IconTile, Loading, NoteLine, ObjectRow, SettingsGroup } from './common.tsx'

const time = (iso: string | undefined): string => {
  const at = iso ? new Date(iso) : undefined
  return at && Number.isFinite(at.getTime()) ? at.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : ''
}

/** A computer's state in words and tone: amber where it waits for the person, red where the connection is not safe. */
export function computerState(computer: Pick<ComputerView, 'state' | 'reason' | 'lastSeenAt'>): { text: string; tone: StatusTone } {
  switch (computer.state) {
    case 'online':
      return { text: '在线', tone: 'neutral' }
    case 'connecting':
      return { text: '正在连接', tone: 'running' }
    case 'offline': {
      const seen = time(computer.lastSeenAt)
      return { text: seen ? `离线 · 上次在线 ${seen}` : '离线', tone: 'neutral' }
    }
    case 'stopping':
      return {
        text: computer.reason === 'update' ? '正在更新' : computer.reason === 'restart' ? '正在重启' : '已停止',
        tone: 'neutral',
      }
    case 'sleeping':
      return { text: '已休眠', tone: 'neutral' }
    case 'revoked':
      return { text: '已被移除', tone: 'warn' }
    case 'wrong-host':
      return { text: '不是这台电脑', tone: 'failed' }
    case 'cert-error':
      return { text: '证书不受信任', tone: 'failed' }
    case 'cert-changed':
      return { text: '证书变了', tone: 'warn' }
    case 'outdated':
      return { text: '版本较旧', tone: 'warn' }
  }
}

/** The address of a computer as a person reads it: host and port. */
function host(origin: string): string {
  try {
    return new URL(origin).host
  } catch {
    return origin
  }
}

/** What a state asks of the person, behind ⓘ. */
const STATE_DETAIL: Partial<Record<ComputerView['state'], string>> = {
  revoked: '那台电脑已移除这台设备。移除后可以重新添加。',
  'wrong-host': '这个地址上的不是添加时的那台电脑，Latch 不再向它发送这台设备的凭据。',
  'cert-error': '那台电脑的 HTTPS 证书不受这台 Mac 信任，或与地址不符。',
  'cert-changed':
    '那台电脑的 HTTPS 证书和添加时不同，例如续期后。Latch 不再发送这台设备的凭据；点「信任新证书」时，那台电脑要用它自己的身份密钥证明它在用这张证书，证明通过才信任。',
  outdated: '在那台电脑上更新 Latch 后再连接。',
}

/**
 * 设置 › 电脑 in the desktop app: this Mac and the other computers it reaches, their states, and adding (from a link that
 * another computer's 「复制链接」 put on the clipboard, or a code file) and removing them. Another computer's page lists
 * and opens them only.
 */
export function ComputersSettings() {
  const api = shellComputers()
  const [view, setView] = useState<ComputersView | undefined>()
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [removing, setRemoving] = useState<ComputerView | null>(null)
  useEffect(() => {
    if (!api) return undefined
    let active = true
    void api
      .list()
      .then(next => {
        if (active && next) setView(next)
        else if (active) setError('无法读取电脑列表。')
      })
      .catch(() => {
        if (active) setError('无法读取电脑列表。')
      })
    const stop = api.subscribe(next => {
      if (active) setView(next)
    })
    return () => {
      active = false
      stop()
    }
  }, [api])
  if (!api) return null
  if (!view) return error ? <InlineNotice tone="error">{error}</InlineNotice> : <Loading />
  const add = async (source: 'clipboard' | 'file') => {
    if (!api.add) return
    setError('')
    setNotice('')
    const result = await api.add(source)
    if (!result.ok && result.error !== 'canceled' && result.error !== 'add-cancelled')
      setError(result.message || '无法添加这台电脑，请重试。')
  }
  const adding = view.adding ?? null
  const remote = view.computers.filter(computer => !computer.local)
  return (
    <>
      <SettingsGroup
        meta={
          api.add ? (
            <span className="computers-actions">
              <Button size="sm" variant="primary" disabled={adding !== null} onClick={() => void add('clipboard')}>
                添加电脑
              </Button>
              <Button size="sm" variant="secondary" disabled={adding !== null} onClick={() => void add('file')}>
                选择文件…
              </Button>
            </span>
          ) : undefined
        }
        note={
          api.add ? (
            <div className="settings-note">
              <Hint label="从另一台电脑添加">
                在那台电脑的 Latch 里打开 设置 › 设备，点「复制链接」，再回到这里点「添加电脑」；或选择 pnpm latch device invite --code-file
                写出的文件。确认在那台电脑上完成。
              </Hint>
            </div>
          ) : undefined
        }>
        {view.computers.map(computer => {
          const state = computerState(computer)
          const parts = computer.local
            ? ['随 App 一起更新']
            : [computer.origin ? host(computer.origin) : undefined, computer.version].filter((part): part is string => Boolean(part))
          return (
            <ObjectRow
              key={computer.hostId}
              data={{ 'data-computer': computer.hostId }}
              leading={<IconTile icon={Laptop} />}
              title={computer.local ? '这台 Mac' : computer.name}
              description={
                <>
                  <StatusWord tone={state.tone}>{state.text}</StatusWord>
                  {parts.length > 0 && <span> · {parts.join(' · ')}</span>}
                </>
              }
              dim={!computer.local && computer.state !== 'online' && computer.state !== 'connecting'}
              label={computer.local ? '这台 Mac' : computer.name}
              trailing={
                <span className="computers-actions">
                  {(!computer.local || location.hostname !== 'app') && (
                    <Button size="sm" variant="ghost" onClick={() => void api.open(computer.hostId)}>
                      打开
                    </Button>
                  )}
                  {computer.state === 'cert-changed' && api.trustCertificate && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setError('')
                        void api.trustCertificate!(computer.hostId).then(result => {
                          if (!result.ok) setError(result.message || '无法信任新证书，请重试。')
                        })
                      }}>
                      信任新证书
                    </Button>
                  )}
                  {!computer.local && api.remove && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setNotice('')
                        setRemoving(computer)
                      }}>
                      移除
                    </Button>
                  )}
                </span>
              }
            />
          )
        })}
        {adding && (
          <div className="settings-row" data-adding="">
            <span className="settings-row-text">
              <span className="settings-row-title">{host(adding.origin)}</span>
              <span className="settings-row-description">
                {adding.stage === 'checking' ? (
                  <StatusWord tone="running">正在连接</StatusWord>
                ) : (
                  <>
                    <StatusWord tone="waiting">在那台电脑上确认</StatusWord>
                    {adding.fingerprint && <span className="computers-code"> · 校验码 {adding.fingerprint}</span>}
                  </>
                )}
              </span>
            </span>
            <span className="settings-row-end">
              <Button size="sm" variant="ghost" onClick={() => void api.cancelAdd?.()}>
                取消
              </Button>
            </span>
          </div>
        )}
      </SettingsGroup>
      {remote.flatMap(computer => {
        const detail = STATE_DETAIL[computer.state]
        return detail
          ? [<NoteLine key={computer.hostId} brief={{ label: `${computer.name}：${computerState(computer).text}`, detail }} />]
          : []
      })}
      {remote.length === 0 && !adding && api.add && <p className="settings-caption">还没有添加其他电脑。</p>}
      {view.problem === 'credentials' && (
        <InlineNotice tone="error">无法打开其他电脑的设备凭据，电脑列表暂时只读。请检查后重新打开 Latch。</InlineNotice>
      )}
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      {notice && <InlineNotice>{notice}</InlineNotice>}
      {removing && api.remove && (
        <ConfirmDialog
          title={`移除 ${removing.name}？`}
          danger
          confirmLabel="移除"
          message="这台 Mac 上保存的它的连接与页面数据会被删除。"
          onClose={() => {
            setRemoving(null)
          }}
          onConfirm={async () => {
            const result = await api.remove!(removing.hostId)
            if (!result.ok) throw new Error(result.message || '无法移除这台电脑，请重试。')
            if (!result.revokedThere) setNotice(`在 ${removing.name} 的 设置 › 设备 里移除这台设备。`)
          }}
        />
      )}
    </>
  )
}
