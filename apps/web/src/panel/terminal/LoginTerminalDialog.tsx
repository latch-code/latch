import { useEffect, useState } from 'react'
import type { TerminalSummary } from '@latch/protocol'
import { Button, ConfirmDialog, Dialog, Hint, Icon, InlineNotice, ShieldGlyph, Spinner } from '@latch/ui'
import { errorMessage, MessageError } from '../../core/api.ts'
import { VisibleText } from '../../components/VisibleText.tsx'
import { endedText } from './model.ts'
import { loginRuns, useDetachedLogin, type LoginRun } from './loginRuns.ts'
import { TerminalScreen } from './TerminalPanel.tsx'

/**
 * A Harness's login command outside any session (设置, a new session's draft): one Latch terminal in a dialog, in the home
 * folder, bound to no project. It ends with the command: on code 0 the dialog closes and the row that started it says
 * what the Harness answers; otherwise the output stays to be read. Only this Mac gets here.
 */
export function LoginTerminalDialog() {
  const run = useDetachedLogin()
  return run ? <DetachedLogin key={run.terminal.id} run={run} /> : null
}

function DetachedLogin({ run }: { run: LoginRun }) {
  const [summary, setSummary] = useState<TerminalSummary>(run.terminal)
  const [confirming, setConfirming] = useState(false)
  const [failure, setFailure] = useState<string>()
  const [inputFailure, setInputFailure] = useState<string>()
  const [connection, setConnection] = useState<'live' | 'reconnecting'>('live')
  const name = summary.login?.name ?? ''
  const ended = endedText(summary)

  const close = async () => {
    if (run.state === 'running') {
      setConfirming(true)
      return
    }
    try {
      await loginRuns.close(run)
    } catch (cause) {
      setFailure(errorMessage(cause))
    }
  }

  // The command left with code 0: nothing is left to read here, and the row says the rest.
  const done = run.state === 'ended'
  useEffect(() => {
    if (done) void loginRuns.close(run).catch(() => undefined)
  }, [done, run])

  return (
    <>
      <Dialog
        open
        size="wide"
        className="login-terminal-dialog"
        title={<VisibleText text={name} />}
        closeLabel="关闭终端"
        onClose={() => void close()}
        note={
          <Hint lead={<Icon icon={ShieldGlyph} size={12} />} label="你的账户，不是沙箱">
            终端是这台 Mac 上以你的账户运行的登录 shell，和「终端」App 相同。Latch 的审批、路径检查与出站策略都不适用于其中的命令。
          </Hint>
        }
        footer={
          ended ? (
            <>
              <span className="terminal-ended" role="status">
                {ended}
              </span>
              <Button onClick={() => void close()}>关闭</Button>
            </>
          ) : (
            <span className="terminal-running" role="status">
              <Spinner size={12} />
              {connection === 'reconnecting' ? '正在重新连接…' : '登录中'}
            </span>
          )
        }>
        {(failure ?? inputFailure) && (
          <InlineNotice
            tone="error"
            className="terminal-notice"
            onClose={() => {
              setFailure(undefined)
              setInputFailure(undefined)
            }}>
            {failure ?? inputFailure}
          </InlineNotice>
        )}
        <div className="login-terminal-screen terminal-screens" role="group" aria-label={`${name} 登录终端`}>
          <TerminalScreen
            target={{ sessionId: run.sessionId }}
            tab={{ id: summary.id, number: 1, summary }}
            visible
            onSummary={next => {
              setSummary(next)
              loginRuns.report(next)
            }}
            onClosed={() => loginRuns.gone(run.terminal.id)}
            onSelection={() => undefined}
            onConnection={setConnection}
            onInputFailed={setInputFailure}
          />
        </div>
      </Dialog>
      {confirming && (
        <ConfirmDialog
          title={`关闭 ${name} 的登录？`}
          message="登录命令还在运行，关闭会结束它。"
          confirmLabel="关闭终端"
          danger
          onConfirm={async () => {
            try {
              await loginRuns.close(run, true)
            } catch (cause) {
              throw new MessageError(errorMessage(cause))
            }
          }}
          onClose={() => setConfirming(false)}
        />
      )}
    </>
  )
}
