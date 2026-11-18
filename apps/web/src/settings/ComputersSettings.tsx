import { useEffect, useState } from 'react'

import { Button, Hint, InlineNotice, StatusWord, LaptopGlyph } from '@latch/ui'
import { ConfirmDialog } from '../components/overlays.tsx'
import { describeFailure } from '../core/securityCopy.ts'
import { computerState } from '../core/computers.ts'
import { shellComputers, type ComputersView, type ComputerView } from '../core/shell.ts'
import { IconTile, Loading, NoteLine, ObjectRow, SettingsGroup } from './common.tsx'
import { MessageError } from '../core/api.ts'
import { LATCH_COMMAND } from '../core/commands.ts'
import { defineCopy, useLocale } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    removed: '那台电脑已移除这台设备。移除后可以重新添加。',
    identityChanged: '这个地址上的不是添加时的那台电脑，Latch 不再向它发送这台设备的凭据。',
    invalidCert: '那台电脑的 HTTPS 证书不受这台 Mac 信任，或与地址不符。',
    renewedCert:
      '那台电脑的 HTTPS 证书和添加时不同，例如续期后。Latch 不再发送这台设备的凭据；点「信任新证书」时，那台电脑要用它自己的身份密钥证明它在用这张证书，证明通过才信任。',
    updateFirst: '在那台电脑上更新 Latch 后再连接。',
    readFailed: '无法读取电脑列表。',
    add: '添加电脑',
    chooseFile: '选择文件…',
    addFromOther: '从另一台电脑添加',
    updateWithApp: '随 App 一起更新',
    thisMac: '这台 Mac',
    open: '打开',
    trust: '信任新证书',
    remove: '移除',
    connecting: '正在连接',
    confirmThere: '在那台电脑上确认',
    verificationCode: '· 校验码',
    cancel: '取消',
    empty: '还没有添加其他电脑。',
    credentialsUnavailable: '无法打开其他电脑的设备凭据，电脑列表暂时只读。请检查后重新打开 Latch。',
    removeDetails: '这台 Mac 上保存的它的连接与页面数据会被删除。',
    addGuide: (command: string) =>
      `在那台电脑的 Latch 里打开 设置 › 设备，点「复制链接」，再回到这里点「添加电脑」；或选择 ${command} 写出的文件。确认在那台电脑上完成。`,
    state: (name: string, status: string) => `${name}：${status}`,
    removeTitle: (name: string) => `移除 ${name}？`,
    removeThere: (name: string) => `在 ${name} 的 设置 › 设备 里移除这台设备。`,
  },
  {
    removed: 'That computer removed this device. Remove the connection to add it again.',
    identityChanged: 'The computer at this address has a different identity. Latch has stopped sending this device’s credentials to it.',
    invalidCert: 'This Mac does not trust that computer’s HTTPS certificate, or the certificate does not match its address.',
    renewedCert:
      'That computer’s HTTPS certificate has changed, for example after renewal. Latch has stopped sending this device’s credentials. When you select Trust new certificate, the computer must use its identity key to prove it uses the new certificate before Latch will trust it.',
    updateFirst: 'Update Latch on that computer before reconnecting.',
    readFailed: 'Couldn’t load the computers list.',
    add: 'Add computer',
    chooseFile: 'Choose file…',
    addFromOther: 'Add from another computer',
    updateWithApp: 'Updates with the app',
    thisMac: 'This Mac',
    open: 'Open',
    trust: 'Trust new certificate',
    remove: 'Remove',
    connecting: 'Connecting',
    confirmThere: 'Confirm on that computer',
    verificationCode: '· Verification code',
    cancel: 'Cancel',
    empty: 'No other computers have been added.',
    credentialsUnavailable:
      'Latch couldn’t open the device credentials for other computers. The list is read-only for now. Check access to the credentials, then reopen Latch.',
    removeDetails: 'Its connection and page data will be removed from this Mac.',
    addGuide: (command: string) =>
      `On that computer, open Settings › Devices in Latch and select Copy link. Return here and select Add computer, or choose a file created by ${command}. Confirm on that computer.`,
    state: (name: string, status: string) => `${name} · ${status}`,
    removeTitle: (name: string) => `Remove ${name}?`,
    removeThere: (name: string) => `On ${name}, remove this device in Settings › Devices.`,
  },
)

/** The address of a computer as a person reads it: host and port. */
function host(origin: string): string {
  try {
    return new URL(origin).host
  } catch {
    return origin
  }
}

/** What a state asks of the person, behind ⓘ. */
const STATE_DETAIL: Partial<Record<ComputerView['state'], 'removed' | 'identityChanged' | 'invalidCert' | 'renewedCert' | 'updateFirst'>> =
  {
    revoked: 'removed',
    'wrong-host': 'identityChanged',
    'cert-error': 'invalidCert',
    'cert-changed': 'renewedCert',
    outdated: 'updateFirst',
  }

/**
 * 设置 › 电脑 in the desktop app: this Mac and the other computers it reaches, their states, and adding (from a link that
 * another computer's 「复制链接」 put on the clipboard, or a code file) and removing them. Another computer's page lists
 * and opens them only.
 */
export function ComputersSettings() {
  useLocale()
  const api = shellComputers()
  const [view, setView] = useState<ComputersView | undefined>()
  const [errorCode, setError] = useState('')
  const [removedComputer, setNotice] = useState('')
  const error = errorCode === 'list-failed' ? COPY.readFailed : errorCode ? describeFailure(0, errorCode) : ''
  const notice = removedComputer ? COPY.removeThere(removedComputer) : ''
  const [removing, setRemoving] = useState<ComputerView | null>(null)
  useEffect(() => {
    if (!api) return undefined
    let active = true
    void api
      .list()
      .then(next => {
        if (active && next) setView(next)
        else if (active) setError('list-failed')
      })
      .catch(() => {
        if (active) setError('list-failed')
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
    if (!result.ok && result.error !== 'canceled' && result.error !== 'add-cancelled') setError(result.error || 'add-failed')
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
                {COPY.add}
              </Button>
              <Button size="sm" variant="secondary" disabled={adding !== null} onClick={() => void add('file')}>
                {COPY.chooseFile}
              </Button>
            </span>
          ) : undefined
        }
        note={
          api.add ? (
            <div className="settings-note">
              <Hint label={COPY.addFromOther}>{COPY.addGuide(`${LATCH_COMMAND} device invite --code-file`)}</Hint>
            </div>
          ) : undefined
        }>
        {view.computers.map(computer => {
          const state = computerState(computer)
          const parts = computer.local
            ? [COPY.updateWithApp]
            : [computer.origin ? host(computer.origin) : undefined, computer.version].filter((part): part is string => Boolean(part))
          return (
            <ObjectRow
              key={computer.hostId}
              data={{ 'data-computer': computer.hostId }}
              leading={<IconTile icon={LaptopGlyph} />}
              title={computer.local ? COPY.thisMac : computer.name}
              description={
                <>
                  <StatusWord tone={state.tone}>{state.text}</StatusWord>
                  {parts.length > 0 && <span> · {parts.join(' · ')}</span>}
                </>
              }
              dim={!computer.local && computer.state !== 'online' && computer.state !== 'connecting'}
              label={computer.local ? COPY.thisMac : computer.name}
              trailing={
                <span className="computers-actions">
                  {(!computer.local || location.hostname !== 'app') && (
                    <Button size="sm" variant="ghost" onClick={() => void api.open(computer.hostId)}>
                      {COPY.open}
                    </Button>
                  )}
                  {computer.state === 'cert-changed' && api.trustCertificate && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setError('')
                        void api.trustCertificate!(computer.hostId).then(result => {
                          if (!result.ok) setError(result.error || 'certificate-refused')
                        })
                      }}>
                      {COPY.trust}
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
                      {COPY.remove}
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
                  <StatusWord tone="running">{COPY.connecting}</StatusWord>
                ) : (
                  <>
                    <StatusWord tone="waiting">{COPY.confirmThere}</StatusWord>
                    {adding.fingerprint && (
                      <span className="computers-code">
                        {' '}
                        {COPY.verificationCode} {adding.fingerprint}
                      </span>
                    )}
                  </>
                )}
              </span>
            </span>
            <span className="settings-row-end">
              <Button size="sm" variant="ghost" onClick={() => void api.cancelAdd?.()}>
                {COPY.cancel}
              </Button>
            </span>
          </div>
        )}
      </SettingsGroup>
      {remote.flatMap(computer => {
        const detail = STATE_DETAIL[computer.state]
        return detail
          ? [
              <NoteLine
                key={computer.hostId}
                brief={{ label: COPY.state(computer.name, computerState(computer).text), detail: COPY[detail] }}
              />,
            ]
          : []
      })}
      {remote.length === 0 && !adding && api.add && <p className="settings-caption">{COPY.empty}</p>}
      {view.problem === 'credentials' && <InlineNotice tone="error">{COPY.credentialsUnavailable}</InlineNotice>}
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      {notice && <InlineNotice>{notice}</InlineNotice>}
      {removing && api.remove && (
        <ConfirmDialog
          title={COPY.removeTitle(removing.name)}
          danger
          confirmLabel={COPY.remove}
          message={COPY.removeDetails}
          onClose={() => {
            setRemoving(null)
          }}
          onConfirm={async () => {
            const result = await api.remove!(removing.hostId)
            if (!result.ok) throw new MessageError(() => describeFailure(0, result.error))
            if (!result.revokedThere) setNotice(removing.name)
          }}
        />
      )}
    </>
  )
}
