import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { CircleSlash, Fingerprint, Laptop, ShieldAlert, Smartphone } from 'lucide-react'
import { isLocalListener, type AppSnapshot, type HarnessInfo, type PermissionLevel, type WorkspaceInfo } from '@latch/protocol'
import { harnessName } from '../composerChoice.ts'
import { errorMessage, inlineError } from '../core/api.ts'
import { InlineConfirm } from '../components/InlineConfirm.tsx'
import {
  applyPatch,
  CEILING_COPY,
  changePolicy,
  isEgressTarget,
  LEVEL_EFFECTS,
  LEVEL_TITLES,
  localLadder,
  localLadderPatch,
  localNote,
  normalizeEgressTarget,
  readPolicy,
  remoteLadderPatch,
  remoteListPatch,
  remoteNote,
  toggledList,
  widens,
  type PolicyPatch,
  type PolicyView,
  type RemoteList,
  type StandardLevel,
} from '../core/ceilings.ts'
import { DEV_MODE_TEXT, harnessLevel, hostView, type DeviceAccess } from '../core/permissions.ts'
import { shownAddress } from '../core/providerSetup.ts'
import { AUDIT_NOT_RECORDED_TEXT, PAIRING_COPY, PROVIDER_COPY } from '../core/securityCopy.ts'
import { basename } from '../format.ts'
import { CopyButton } from '../components/ui.tsx'
import {
  Badge,
  Button,
  Checkbox,
  DevMark,
  Dialog,
  Icon,
  InlineNotice,
  MenuFooterNote,
  PermissionMenu,
  StatusPill,
  SwitchRow,
  TextField,
  type PermissionLevel as MenuLevel,
} from '@latch/ui'
import { FoldRows, IconTile, Loading, MiddleEllipsis, NavRow, SectionHeading, SettingsGroup, SettingsRow } from './common.tsx'
import { SettingsPages } from './navigation.tsx'

const LEVELS: PermissionLevel[] = ['L0', 'L1', 'L2', 'L3']
const isStandard = (level: PermissionLevel): level is StandardLevel => level !== 'L3'

/** A ceiling's value as plain text: 完全访问 leads with the amber shield, as the picker does once it is chosen. */
function LevelText({ level }: { level: PermissionLevel }) {
  return (
    <span className="ceiling-value">
      {level === 'L3' && <Icon icon={ShieldAlert} size={14} className="ceiling-risk" />}
      {LEVEL_TITLES[level]}
    </span>
  )
}

/** This computer: its name, whether this device is on it, local confirmation when it is missing, and phone access. */
function ThisComputer({ snapshot, access }: { snapshot: AppSnapshot; access: DeviceAccess }) {
  const host = hostView(snapshot)
  const listener = access.device?.listener
  // Only host.sock is this computer (isLocalListener); a browser on loopback is remote and never named 本机.
  const here = listener !== undefined && isLocalListener(listener)
  const origin = host?.tls?.origin
  return (
    <SettingsGroup title="这台电脑">
      <SettingsRow
        leading={<IconTile icon={Laptop} />}
        record
        title={
          <span className="settings-row-name">
            {snapshot.hostName || '本机'}
            {here && <Badge>本机</Badge>}
            {host?.devMode && <DevMark description={DEV_MODE_TEXT} />}
          </span>
        }
        description="运行 Latch 的电脑"
      />
      {host?.presence.status === 'unavailable' && (
        <SettingsRow
          leading={<IconTile icon={Fingerprint} />}
          title="本机确认"
          description={host.presence.message || '确认组件不可用，需要本机确认的操作都不能进行'}
          trailing={<StatusPill tone="warn">不可用</StatusPill>}
        />
      )}
      <SettingsRow
        leading={<IconTile icon={Smartphone} />}
        title="手机接入"
        description={origin ? <code className="settings-mono">{origin}</code> : PAIRING_COPY.computerRow}
        trailing={origin ? <CopyButton text={origin} label="复制手机接入地址" /> : <span className="settings-row-value">未配置</span>}
      />
    </SettingsGroup>
  )
}

/** The ceilings as the snapshot states them, for devices without 管理此 Host. */
function ReadOnlyCeilings({ snapshot }: { snapshot: AppSnapshot }) {
  const summary = hostView(snapshot)?.policy
  if (!summary) return null
  const stored = { maxLevel: isStandard(summary.localMaxLevel) ? summary.localMaxLevel : 'L2', allowL3: summary.allowL3 } as const
  const remote = isStandard(summary.remoteMaxLevel) ? summary.remoteMaxLevel : 'L2'
  return (
    <SettingsGroup title="权限上限" meta={snapshot.hostName} caption={CEILING_COPY.readOnly} captionIcon="lock">
      <SettingsRow title={CEILING_COPY.localTitle} description={localNote(stored)} trailing={<LevelText level={localLadder(stored)} />} />
      <SettingsRow title={CEILING_COPY.remoteTitle} description={remoteNote(remote)} trailing={<LevelText level={remote} />} />
    </SettingsGroup>
  )
}

/** A harness or project offered to other devices, or one the list still names after it was removed. */
interface ListEntry {
  id: string
  title: string
  description?: string
  /** A path, drawn in mono with the middle left out when it does not fit. */
  path?: string
  /** Named by the list but no longer on the Host; it can only be removed. */
  stale?: boolean
}

function harnessEntries(harnesses: HarnessInfo[], listed: string[] | null): ListEntry[] {
  const known = harnesses.map(harness => ({
    id: harness.id,
    title: harnessName(harness),
    description:
      harnessLevel(harness) === 'L3'
        ? '完全访问：其他设备只能查看、拒绝和停止它的会话'
        : harness.source === 'builtin'
          ? '逐项询问'
          : undefined,
  }))
  return [...known, ...staleEntries(known, listed, '已移除的 Agent')]
}

function workspaceEntries(workspaces: WorkspaceInfo[], listed: string[] | null): ListEntry[] {
  const known = workspaces.map(workspace => ({
    id: workspace.id,
    title: workspace.id === 'default' ? '启动目录' : workspace.name || basename(workspace.path),
    path: workspace.path,
  }))
  return [...known, ...staleEntries(known, listed, '已移除的项目')]
}

function staleEntries(known: ListEntry[], listed: string[] | null, title: string): ListEntry[] {
  return (listed ?? []).filter(id => !known.some(entry => entry.id === id)).map(id => ({ id, title, description: id, stale: true }))
}

/** How a remote list reads on its row: 全部, 无, the one name, or a count. */
function listSummary(listed: string[] | null, entries: ListEntry[], unit: string): string {
  if (listed === null) return '全部'
  if (listed.length === 0) return '无'
  if (listed.length === 1) return entries.find(entry => entry.id === listed[0])?.title ?? `1 个${unit}`
  return `${listed.length} 个${unit}`
}

/** Why an entry cannot be checked: the 12px circle-slash and the reason in text-2, at full strength. */
function Reason({ children }: { children: ReactNode }) {
  return (
    <span className="settings-row-reason">
      <Icon icon={CircleSlash} size={12} />
      {children}
    </span>
  )
}

/** 其他设备可用的 Agent / 项目: everything (null, including what is added later) or exactly the checked entries. */
function RemoteListPage({
  field,
  listed,
  entries,
  raiseBlock,
  pending,
  onApply,
  confirmation,
}: {
  field: RemoteList
  listed: string[] | null
  entries: ListEntry[]
  /** Why this device cannot widen the list: turning 全部 on, or adding an entry. */
  raiseBlock: { all?: string; add?: string }
  /** The local confirmation of a widening, under the list. */
  confirmation?: ReactNode
  pending: string | null
  onApply: (patch: PolicyPatch, key: string) => void
}) {
  const agents = field === 'harnesses'
  const title = agents ? CEILING_COPY.harnessesTitle : CEILING_COPY.workspacesTitle
  const allLabel = agents ? '全部 Agent' : '全部项目'
  const unit = agents ? ' Agent' : '项目'
  return (
    <>
      <SectionHeading title={title} description={agents ? CEILING_COPY.harnessesNote : CEILING_COPY.workspacesNote} />
      <SettingsGroup caption={agents ? CEILING_COPY.listCaption : CEILING_COPY.listCaptionProjects} captionIcon="lock">
        <SwitchRow
          className="settings-row"
          title={allLabel}
          description={pending === `${field}:all` ? '等待验证…' : '包括以后添加的'}
          checked={listed === null}
          locked={listed !== null ? raiseBlock.all : undefined}
          onCheckedChange={all => {
            const current = entries.filter(entry => !entry.stale).map(entry => entry.id)
            onApply(remoteListPatch(field, all ? null : current), `${field}:all`)
          }}
        />
      </SettingsGroup>
      {listed !== null && (
        <div className="settings-enter">
          <SettingsGroup title={agents ? '允许的 Agent' : '允许的项目'} meta={`${listed.length} 个${unit}`}>
            {entries.map(entry => {
              const checked = listed.includes(entry.id)
              const blocked = !checked && (raiseBlock.add !== undefined || entry.stale === true)
              const waiting = pending === `${field}:${entry.id}`
              return (
                <label key={entry.id} className="settings-row" data-leading="" data-check="" data-dim={blocked ? '' : undefined}>
                  <span className="settings-row-lead">
                    <Checkbox
                      checked={checked}
                      disabled={blocked || waiting}
                      aria-label={entry.title}
                      onChange={event => {
                        onApply(remoteListPatch(field, toggledList(listed, entry.id, event.target.checked)), `${field}:${entry.id}`)
                      }}
                    />
                  </span>
                  <span className="settings-row-text">
                    <span className="settings-row-title">{entry.title}</span>
                    {waiting ? (
                      <span className="settings-row-description">等待验证…</span>
                    ) : blocked && !entry.stale ? (
                      <Reason>{raiseBlock.add}</Reason>
                    ) : entry.path ? (
                      <MiddleEllipsis text={entry.path} className="settings-row-description settings-mono" />
                    ) : (
                      entry.description && <span className="settings-row-description">{entry.description}</span>
                    )}
                  </span>
                </label>
              )
            })}
          </SettingsGroup>
        </div>
      )}
      {confirmation}
    </>
  )
}

/** Adds one exact host:port to the Host's egress allow list; it widens the policy, so it takes a local confirmation. */
function EgressDialog({ open, onClose, onAdd }: { open: boolean; onClose: () => void; onAdd: (target: string) => Promise<boolean> }) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [invalid, setInvalid] = useState(false)
  const target = normalizeEgressTarget(value)
  const close = () => {
    setValue('')
    setInvalid(false)
    onClose()
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!isEgressTarget(target)) {
      setInvalid(true)
      return
    }
    setBusy(true)
    const added = await onAdd(target)
    setBusy(false)
    if (added) close()
  }
  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!busy) close()
      }}
      size="form"
      title="加入出站白名单"
      subtitle="Host 将可以访问这个本机或私网地址"
      note="需要在这台电脑上验证身份"
      footer={
        <>
          <Button size="md" disabled={busy} onClick={close}>
            取消
          </Button>
          <Button size="md" variant="primary" type="submit" form="egress-form" loading={busy} disabled={!target}>
            加入
          </Button>
        </>
      }>
      <form
        id="egress-form"
        onSubmit={event => {
          void submit(event)
        }}>
        <TextField
          label="地址"
          value={value}
          placeholder="例如 127.0.0.1:11434"
          spellCheck={false}
          autoComplete="off"
          hint="精确的 host:port，必须写端口；只在信任这个服务时加入"
          error={invalid ? '格式应为 host:port，例如 127.0.0.1:11434 或 [::1]:8080' : undefined}
          onChange={event => {
            setValue(event.target.value)
            setInvalid(false)
          }}
        />
      </form>
      <InlineConfirm active={busy} />
    </Dialog>
  )
}

const EGRESS_POLICY = 'Host 默认不访问本机、私网与云服务器元数据地址。这里列出的 host:port 例外，元数据地址始终拒绝。'

/**
 * Settings › 电脑: this Host's computer and its permission ceilings. Lowering applies at once from any admin device;
 * raising goes through the local confirmation in the desktop app, and other devices see why before they try.
 */
export function ComputerSettings({ snapshot, access, onChanged }: { snapshot: AppSnapshot; access: DeviceAccess; onChanged: () => void }) {
  const host = hostView(snapshot)
  const [policy, setPolicy] = useState<PolicyView | null>(null)
  const [loadError, setLoadError] = useState('')
  const [error, setError] = useState('')
  const [auditFailed, setAuditFailed] = useState(false)
  const [pending, setPending] = useState<string | null>(null)
  const [page, setPage] = useState<'main' | RemoteList>('main')
  const [adding, setAdding] = useState(false)

  const load = useCallback(async () => {
    try {
      setPolicy(await readPolicy())
      setLoadError('')
    } catch (cause) {
      setLoadError(errorMessage(cause))
    }
  }, [])
  useEffect(() => {
    if (!access.admin) return undefined
    let live = true
    readPolicy().then(
      next => {
        if (live) setPolicy(next)
      },
      (cause: unknown) => {
        if (live) setLoadError(errorMessage(cause))
      },
    )
    return () => {
      live = false
    }
  }, [access.admin])

  /** Why this device cannot widen anything (raise, turn on, add), or undefined in the desktop app with presence. */
  const blocked = (desktopOnly: string) =>
    !access.local ? desktopOnly : host?.presence.status === 'unavailable' ? CEILING_COPY.presenceMissing : undefined
  const raiseBlock = blocked(CEILING_COPY.raiseOnDesktop)

  /**
   * Sends one change. A lowering shows at once and is put back if the Host refuses it; a raise keeps the old value
   * until the confirmation is approved, and a cancelled confirmation leaves everything as it was.
   */
  const apply = async (patch: PolicyPatch, key: string): Promise<boolean> => {
    if (policy === null) return false
    const raise = widens(policy, patch)
    setError('')
    if (raise) setPending(key)
    else setPolicy(applyPatch(policy, patch))
    try {
      const result = await changePolicy(patch)
      setPolicy(result.policy)
      setAuditFailed(result.auditFailed)
      onChanged()
      return true
    } catch (cause) {
      const text = inlineError(cause)
      if (text) setError(text)
      void load()
      return false
    } finally {
      if (raise) setPending(current => (current === key ? null : current))
    }
  }
  /** Picker changes: a raise hands its promise back, so the picker shows 「等待验证…」 in place until it settles. */
  const choose = (patch: PolicyPatch, key: string): void | Promise<void> => {
    if (policy !== null && widens(policy, patch)) return apply(patch, key).then(() => {})
    void apply(patch, key)
  }

  const heading = (
    <SectionHeading title="电脑" description="Latch 在这台电脑上运行。会话、密钥和权限上限都留在这里，其他设备只是连接到它。" />
  )
  if (!access.admin)
    return (
      <>
        {heading}
        <ThisComputer snapshot={snapshot} access={access} />
        <ReadOnlyCeilings snapshot={snapshot} />
      </>
    )
  if (policy === null)
    return (
      <>
        {heading}
        <ThisComputer snapshot={snapshot} access={access} />
        {loadError ? (
          <InlineNotice
            tone="error"
            action={
              <Button
                size="xs"
                onClick={() => {
                  void load()
                }}>
                重试
              </Button>
            }>
            {loadError}
          </InlineNotice>
        ) : (
          <Loading />
        )}
      </>
    )

  const harnesses = harnessEntries(snapshot.catalog?.harnesses ?? [], policy.remote.harnesses)
  const workspaces = workspaceEntries(snapshot.catalog?.workspaces ?? [], policy.remote.workspaces)
  const notices: ReactNode = (
    <>
      {auditFailed && <InlineNotice tone="error">{AUDIT_NOT_RECORDED_TEXT}</InlineNotice>}
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
    </>
  )

  const local = localLadder(policy.local)
  const unless = (patch: PolicyPatch) => (widens(policy, patch) ? raiseBlock : undefined)
  const localLevels: Array<MenuLevel<PermissionLevel>> = LEVELS.map(level => ({
    value: level,
    title: LEVEL_TITLES[level],
    description: LEVEL_EFFECTS[level],
    risk: level === 'L3',
    disabledReason: unless(localLadderPatch(policy.local, level)),
  }))
  const remoteLevels: Array<MenuLevel<PermissionLevel>> = LEVELS.map(level => ({
    value: level,
    title: LEVEL_TITLES[level],
    description: LEVEL_EFFECTS[level],
    risk: level === 'L3',
    disabledReason: isStandard(level) ? unless(remoteLadderPatch(level)) : CEILING_COPY.remoteFullAccess,
  }))
  const footer = <MenuFooterNote>{CEILING_COPY.raiseHere}</MenuFooterNote>
  const remoteStartBlocked = !policy.remote.allowRemoteStart ? blocked(CEILING_COPY.turnOnOnDesktop) : undefined
  const addBlocked = blocked(CEILING_COPY.addOnDesktop)
  const back = () => {
    setPage('main')
  }

  const main = (
    <>
      {heading}
      {notices}
      <ThisComputer snapshot={snapshot} access={access} />
      <SettingsGroup title="权限上限" meta={snapshot.hostName} caption={CEILING_COPY.caption} captionIcon="lock">
        <SettingsRow
          title={CEILING_COPY.localTitle}
          description={localNote(policy.local)}
          trailing={
            <PermissionMenu
              label={CEILING_COPY.localTitle}
              value={local}
              levels={localLevels}
              defaultValue="L3"
              bleed="end"
              header={{ title: CEILING_COPY.localScope }}
              footer={footer}
              pending={pending === 'local'}
              onValueChange={level => choose(localLadderPatch(policy.local, level), 'local')}
            />
          }
        />
        <SettingsRow
          title={CEILING_COPY.remoteTitle}
          description={remoteNote(policy.remote.maxLevel)}
          trailing={
            <PermissionMenu
              label={CEILING_COPY.remoteTitle}
              value={policy.remote.maxLevel}
              levels={remoteLevels}
              defaultValue="L1"
              bleed="end"
              header={{ title: CEILING_COPY.remoteScope }}
              footer={footer}
              pending={pending === 'remote'}
              onValueChange={level => {
                if (isStandard(level)) return choose(remoteLadderPatch(level), 'remote')
              }}
            />
          }
        />
        <SwitchRow
          className="settings-row"
          title={CEILING_COPY.remoteStartTitle}
          description={pending === 'start' ? '等待验证…' : CEILING_COPY.remoteStartNote}
          checked={policy.remote.allowRemoteStart}
          locked={remoteStartBlocked}
          disabled={pending === 'start'}
          onCheckedChange={on => {
            void apply({ remote: { allowRemoteStart: on } }, 'start')
          }}
        />
        <NavRow
          title={CEILING_COPY.harnessesTitle}
          value={listSummary(policy.remote.harnesses, harnesses, ' Agent')}
          onClick={() => {
            setPage('harnesses')
          }}
        />
        <NavRow
          title={CEILING_COPY.workspacesTitle}
          value={listSummary(policy.remote.workspaces, workspaces, '项目')}
          onClick={() => {
            setPage('workspaces')
          }}
        />
      </SettingsGroup>
      {/* A raise of a ceiling is confirmed here, right under the card it changes. */}
      <InlineConfirm active={page === 'main' && !adding && (pending === 'local' || pending === 'remote' || pending === 'start')} />
      <SettingsGroup
        title="出站白名单"
        meta={
          addBlocked === undefined ? (
            <Button
              variant="link"
              size="xs"
              onClick={() => {
                setAdding(true)
              }}>
              添加…
            </Button>
          ) : undefined
        }
        caption={addBlocked === undefined ? EGRESS_POLICY : `${EGRESS_POLICY}${addBlocked}。`}
        captionIcon={addBlocked === undefined ? 'info' : 'lock'}>
        {policy.hostEgressAllow.length === 0 && (
          <SettingsRow title="没有例外" description="Host 只访问公网地址（启动参数放行的地址除外）" />
        )}
        <FoldRows items={policy.hostEgressAllow} keyOf={entry => entry}>
          {entry => (
            <SettingsRow
              title={<code className="settings-mono">{entry}</code>}
              description="Host 可以访问这个地址"
              trailing={
                <Button
                  variant="ghost"
                  aria-label={`移除 ${entry}`}
                  onClick={() => {
                    void apply({ hostEgressAllow: { remove: [entry] } }, `egress:${entry}`)
                  }}>
                  移除
                </Button>
              }
            />
          )}
        </FoldRows>
      </SettingsGroup>
      {policy.confirmedAddresses !== undefined && (
        <SettingsGroup title={PROVIDER_COPY.confirmedAddressesTitle} caption={PROVIDER_COPY.confirmedAddressesCaption}>
          {policy.confirmedAddresses.length === 0 && (
            <SettingsRow title={PROVIDER_COPY.confirmedAddressesEmpty} description={PROVIDER_COPY.confirmedAddressesEmptyNote} />
          )}
          <FoldRows items={policy.confirmedAddresses} keyOf={address => address}>
            {address => (
              <SettingsRow
                title={<code className="settings-mono">{shownAddress(address)}</code>}
                description={PROVIDER_COPY.confirmedAddressRow}
                trailing={
                  <Button
                    variant="ghost"
                    aria-label={`移除 ${shownAddress(address)}`}
                    onClick={() => {
                      void apply({ confirmedAddresses: { remove: [address] } }, `address:${address}`)
                    }}>
                    移除
                  </Button>
                }
              />
            )}
          </FoldRows>
        </SettingsGroup>
      )}
      <EgressDialog
        open={adding}
        onClose={() => {
          setAdding(false)
        }}
        onAdd={target => apply({ hostEgressAllow: { add: [target] } }, `egress:${target}`)}
      />
    </>
  )

  return (
    <SettingsPages
      main={main}
      levels={
        page === 'main'
          ? []
          : [
              {
                key: page,
                title: page === 'harnesses' ? CEILING_COPY.harnessesTitle : CEILING_COPY.workspacesTitle,
                onBack: back,
                content: (
                  <>
                    {notices}
                    <RemoteListPage
                      field={page}
                      listed={policy.remote[page]}
                      entries={page === 'harnesses' ? harnesses : workspaces}
                      raiseBlock={{ all: blocked(CEILING_COPY.turnOnOnDesktop), add: addBlocked }}
                      pending={pending}
                      onApply={(patch, key) => {
                        void apply(patch, key)
                      }}
                      confirmation={<InlineConfirm active={pending !== null} />}
                    />
                  </>
                ),
              },
            ]
      }
    />
  )
}
