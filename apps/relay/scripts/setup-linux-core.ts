import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { isIP } from 'node:net'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { isRelayEndpoint } from '@latch/link-wire'
import { prepareRelaysDir, RELAY_NAME, RELAYS_DISPLAY, RelayFilesError } from '@latch/link-client/relay-files'
import { publicOrigin } from '../src/init-config.ts'
import type { LinuxArch } from './bundle-linux.ts'
import type { AcceptedRelayProfile, LinuxAcceptanceItem } from './accept-linux.ts'

const endpointField = z.string().refine(value => isRelayEndpoint(value) && new URL(value).href === value)
const exportedFileSchema = z.discriminatedUnion('version', [
  z
    .object({
      version: z.literal(1),
      profile: z
        .object({
          relayId: z.string().regex(/^[a-f0-9]{32}$/u),
          url: endpointField,
          spkiHash: z.string().regex(/^[a-f0-9]{64}$/u),
          registrationKey: z
            .string()
            .regex(/^lrt1\.[A-Za-z0-9_-]{43}$/u)
            .nullable()
            .optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      version: z.literal(2),
      profile: z
        .object({
          relayId: z.string().regex(/^[a-f0-9]{32}$/u),
          url: endpointField,
          kind: z.literal('edge'),
          relayKey: z.string().regex(/^[a-f0-9]{64}$/u),
          extraUrls: z.array(endpointField).min(1).max(3).optional(),
          shard: z.number().int().min(0).max(15).optional(),
          registrationKey: z
            .string()
            .regex(/^lrt1\.[A-Za-z0-9_-]{43}$/u)
            .nullable()
            .optional(),
        })
        .strict(),
    })
    .strict(),
])

export const SSH_TARGET = /^(?:[A-Za-z0-9._-]+@)?(?:[A-Za-z0-9.-]+|\[[a-fA-F0-9:]+\])$/u
export const PLAIN_SERVER_PATH = /^\/[A-Za-z0-9._/-]{1,200}$/u
const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$/u

export type LinuxDeployMode = 'self-ip' | 'acme' | 'behind-proxy' | 'custom-tls'

export interface LinuxSetupInput {
  server: string
  sshPort?: number
  domain?: string
  ip?: string
  name?: string
  port?: number
  publicPort?: number
  behindProxy?: boolean
  cert?: string
  key?: string
  acmeEmail?: string
  bundlePath?: string
  out?: string
  home?: string
  skipAccept?: boolean
  upgrade?: boolean
}

export interface LinuxSetupDeps {
  ssh(
    target: { server: string; sshPort?: number },
    remoteScript: string,
    stdin?: Buffer,
  ): Promise<{ code: number; stdout: string; stderr: string }>
  resolveServerIp?(target: { server: string; sshPort?: number }): Promise<string | undefined>
  buildBundle(arch: LinuxArch): Promise<{ tarball: Buffer; sha256: string }>
  readBundle(path: string): Promise<{ tarball: Buffer; sha256: string }>
  accept(profile: AcceptedRelayProfile): Promise<LinuxAcceptanceItem[]>
  progress(line: string): void
}

export class LinuxSetupError extends Error {}

export function extractSshHost(server: string): string {
  const at = server.indexOf('@')
  const raw = at >= 0 ? server.slice(at + 1) : server
  return raw.replace(/^\[|\]$/gu, '')
}

export function defaultLinuxRelayName(target: string): string {
  const clean = target.replace(/^\[|\]$/gu, '').toLowerCase()
  const base = isIP(clean) !== 0 ? `ip-${clean.replace(/[^a-f0-9]/gu, '-')}` : clean.replaceAll('.', '-')
  const stem = base
    .replace(/[^a-z0-9-]/gu, '')
    .replace(/-+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 40)
    .replace(/-+$/gu, '')
  return stem && RELAY_NAME.test(stem) ? stem : 'linux'
}

export function normalizeLinuxSetupInput(
  input: LinuxSetupInput,
  resolvedIp?: string,
): {
  server: string
  sshPort?: number
  target: string
  name: string
  mode: LinuxDeployMode
  listenPort: number
  publicPort: number
  origin: string
  cert?: string
  key?: string
  acmeEmail?: string
} {
  const server = input.server.trim()
  if (!server || server.startsWith('-') || !SSH_TARGET.test(server))
    throw new LinuxSetupError('无效的 SSH 服务器目标（应形如 user@example.com 或 root@203.0.113.10）')
  if (input.sshPort !== undefined && (!Number.isInteger(input.sshPort) || input.sshPort < 1 || input.sshPort > 65535))
    throw new LinuxSetupError('--ssh-port 必须是 1–65535 的端口')

  const rawDomain = input.domain?.trim().toLowerCase() || undefined
  const rawIp = input.ip?.trim().toLowerCase() || undefined
  if (rawDomain && rawIp && rawDomain.replace(/^\[|\]$/gu, '') !== rawIp.replace(/^\[|\]$/gu, ''))
    throw new LinuxSetupError('请只指定 --domain 或 --ip 之一')

  const sshHost = extractSshHost(server)
  const fallbackIp = isIP(sshHost) !== 0 ? sshHost.toLowerCase() : resolvedIp?.trim().toLowerCase()
  const chosen = rawIp ?? rawDomain ?? fallbackIp
  if (!chosen) {
    throw new LinuxSetupError('无法从 SSH 目标确定服务器公网地址；请传入 --ip <服务器公网IP> 或 --domain <域名>')
  }

  const strippedChosen = chosen.replace(/^\[|\]$/gu, '')
  const targetIsIp = isIP(strippedChosen) !== 0
  if (rawIp !== undefined && !targetIsIp) throw new LinuxSetupError('--ip 必须是有效的公网 IPv4 或 IPv6 地址')

  const target = targetIsIp ? (isIP(strippedChosen) === 6 ? `[${strippedChosen}]` : strippedChosen) : chosen
  const name = input.name ?? defaultLinuxRelayName(strippedChosen)
  if (!RELAY_NAME.test(name) || name.length > 40) throw new LinuxSetupError('名称只能用小写字母、数字与连字符，至多 40 个字符')

  const hasCert = input.cert !== undefined || input.key !== undefined
  if (input.behindProxy && (hasCert || targetIsIp))
    throw new LinuxSetupError('--behind-proxy 需要传入 --domain <域名>，且不能与 --ip 或 --cert / --key 同时使用')
  if (input.behindProxy && input.acmeEmail) throw new LinuxSetupError('--behind-proxy 由前置反向代理管理证书，不使用 --acme-email')
  if (hasCert && (!input.cert || !input.key || !PLAIN_SERVER_PATH.test(input.cert) || !PLAIN_SERVER_PATH.test(input.key)))
    throw new LinuxSetupError('--cert 与 --key 须为服务器上的安全绝对路径')
  if ((hasCert || targetIsIp) && input.acmeEmail) throw new LinuxSetupError('无域名 IP 模式或自有证书模式下不使用 --acme-email')
  if (input.acmeEmail !== undefined && !EMAIL.test(input.acmeEmail)) throw new LinuxSetupError('--acme-email 格式无效')
  if (!input.behindProxy && input.publicPort !== undefined) throw new LinuxSetupError('--public-port 只在 --behind-proxy 模式下使用')

  const mode: LinuxDeployMode = input.behindProxy ? 'behind-proxy' : hasCert ? 'custom-tls' : targetIsIp ? 'self-ip' : 'acme'
  const listenPort = input.port ?? (mode === 'behind-proxy' ? 18443 : mode === 'custom-tls' ? 8443 : 443)
  const publicPort = mode === 'behind-proxy' ? (input.publicPort ?? 443) : listenPort
  if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) throw new LinuxSetupError('--port 必须是 1–65535 的端口')

  let origin: string
  try {
    origin = publicOrigin(target, publicPort)
  } catch {
    throw new LinuxSetupError('无效的服务器地址或端口（域名须全小写、不含下划线或路径）')
  }
  if (mode === 'acme' && !target.includes('.')) throw new LinuxSetupError('自动申请公共 CA 证书需要可解析的公网域名，或改用 --ip <公网IP>')

  return {
    server,
    ...(input.sshPort ? { sshPort: input.sshPort } : {}),
    target,
    name,
    mode,
    listenPort,
    publicPort,
    origin,
    ...(input.cert ? { cert: input.cert } : {}),
    ...(input.key ? { key: input.key } : {}),
    ...(input.acmeEmail ? { acmeEmail: input.acmeEmail } : {}),
  }
}

export async function resolveLinuxOutput(
  name: string,
  explicitOut?: string,
  home?: string,
  allowExisting = false,
): Promise<{ out: string; shown: string; existed: boolean }> {
  try {
    if (explicitOut !== undefined && !isAbsolute(explicitOut)) throw new LinuxSetupError('--out 应为一个新文件的绝对路径')
    const relays = await prepareRelaysDir(home)
    const out = explicitOut ?? join(relays, `${name}.json`)
    const shown = explicitOut ?? `${RELAYS_DISPLAY}/${name}.json`
    const exists = await lstat(out).then(
      () => true,
      () => false,
    )
    if (exists && !allowExisting) {
      throw new LinuxSetupError(
        `${shown} 已存在，不覆盖。若要平滑升级远端程序请加 --upgrade；若要新建节点请先移走 ${shown} 或使用 --name <新名称>`,
      )
    }
    return { out, shown, existed: exists }
  } catch (error) {
    if (error instanceof RelayFilesError) throw new LinuxSetupError(error.message)
    throw error
  }
}

async function writeNewPrivateFile(path: string, content: string): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600).catch(() => {
    throw new LinuxSetupError(`无法创建私密配置文件 ${path}：文件已存在或目录不可写`)
  })
  try {
    await handle.writeFile(content)
  } finally {
    await handle.close()
  }
}

export function buildReverseProxySnippets(domain: string, publicPort: number, listenPort: number): { caddy: string; nginx: string } {
  const hostHeader = publicPort === 443 ? domain : `${domain}:${publicPort}`
  const caddy = `${hostHeader} {\n  handle /healthz {\n    reverse_proxy 127.0.0.1:${listenPort}\n  }\n  handle /v1/* {\n    reverse_proxy 127.0.0.1:${listenPort}\n  }\n}`
  const nginx = [
    `location /v1/ {`,
    `  proxy_pass http://127.0.0.1:${listenPort};`,
    `  proxy_http_version 1.1;`,
    `  proxy_set_header Upgrade $http_upgrade;`,
    `  proxy_set_header Connection "upgrade";`,
    `  proxy_set_header Host $host;`,
    `  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`,
    `  proxy_read_timeout 3600s;`,
    `}`,
    `location = /healthz {`,
    `  proxy_pass http://127.0.0.1:${listenPort}/healthz;`,
    `}`,
  ].join('\n')
  return { caddy, nginx }
}

const PROFILE_BEGIN = '---LATCH-RELAY-PROFILE-BEGIN---'
const PROFILE_END = '---LATCH-RELAY-PROFILE-END---'

/**
 * OpenSSH concatenates remote argv words with spaces before passing the string to the remote login shell.
 * Quoting `sh -c '...'` as a single remote command guarantees `set -eu` governs every line of `remoteScript`.
 */
export function buildSshRemoteCommand(remoteScript: string): string {
  return `sh -c '${remoteScript.replaceAll("'", "'\\''")}'`
}

function buildRemoteProbeScript(): string {
  return [
    'set -eu',
    'run_root() { if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo -n "$@"; fi; }',
    'os_name=$(uname -s)',
    'arch_name=$(uname -m)',
    'uid_num=$(id -u)',
    'has_sudo=0; if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then has_sudo=1; fi',
    'has_systemd=0; if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then has_systemd=1; fi',
    'port443_busy=0; if command -v ss >/dev/null 2>&1 && ss -tlnH "( sport = :443 )" 2>/dev/null | grep -q .; then port443_busy=1; fi',
    'existing_port=0',
    'existing_proxy=0',
    'if [ "$uid_num" -eq 0 ] || [ "$has_sudo" -eq 1 ]; then',
    '  if run_root test -f /srv/latch-relay/relay.json 2>/dev/null; then',
    '    cfg_json=$(run_root cat /srv/latch-relay/relay.json 2>/dev/null || true)',
    '    parsed_port=$(printf \'%s\\n\' "$cfg_json" | sed -n \'s/.*"port"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p\' | head -n 1)',
    '    if [ -n "$parsed_port" ]; then existing_port="$parsed_port"; fi',
    '    if printf \'%s\\n\' "$cfg_json" | grep -Eq \'"behindProxy"[[:space:]]*:[[:space:]]*true\'; then existing_proxy=1; fi',
    '  fi',
    'fi',
    'printf \'{"os":"%s","arch":"%s","uid":%s,"sudo":%s,"systemd":%s,"port443Busy":%s,"existingPort":%s,"existingBehindProxy":%s}\\n\' "$os_name" "$arch_name" "$uid_num" "$has_sudo" "$has_systemd" "$port443_busy" "$existing_port" "$existing_proxy"',
  ].join('\n')
}

function buildRemoteInstallScript(params: {
  expectedTarSha256: string
  target: string
  mode: LinuxDeployMode
  listenPort: number
  publicPort: number
  originUrl: string
  cert?: string
  key?: string
  acmeEmail?: string
}): string {
  const cleanIp = params.target.replace(/^\[|\]$/gu, '')
  const effectiveInitArgs =
    params.mode === 'behind-proxy'
      ? `--domain ${params.target} --behind-proxy --port ${params.listenPort} --public-port ${params.publicPort}`
      : params.mode === 'self-ip'
        ? `--ip ${cleanIp} --port ${params.listenPort} --gateway /opt/latch-relay/current/latch-relay-tls`
        : params.mode === 'custom-tls'
          ? `--domain ${params.target} --port ${params.listenPort} --cert /etc/latch-relay/tls/fullchain.pem --key /etc/latch-relay/tls/privkey.pem --gateway /opt/latch-relay/current/latch-relay-tls`
          : `--domain ${params.target} --port ${params.listenPort} --gateway /opt/latch-relay/current/latch-relay-tls${params.acmeEmail ? ` --acme-email ${params.acmeEmail}` : ''}`

  const ambientCaps = params.mode !== 'behind-proxy' && params.listenPort < 1024 ? 'CAP_NET_BIND_SERVICE' : ''
  const waitSeconds = params.mode === 'acme' ? 45 : 15
  const copyCustomTls =
    params.mode === 'custom-tls' && params.cert && params.key
      ? [
          'if [ -L /etc/latch-relay ] || [ -L /etc/latch-relay/tls ]; then echo "TLS_DIR_SYMLINK" >&2; exit 15; fi',
          'run_root install -d -m 0755 -o root -g root /etc/latch-relay',
          'run_root install -d -m 0750 -o root -g latch-relay /etc/latch-relay/tls',
          'if [ -L /etc/latch-relay/tls/fullchain.pem ] || [ -L /etc/latch-relay/tls/privkey.pem ]; then echo "TLS_FILE_SYMLINK" >&2; exit 15; fi',
          'tls_cert_tmp="/etc/latch-relay/tls/.fullchain.tmp.$$"',
          'tls_key_tmp="/etc/latch-relay/tls/.privkey.tmp.$$"',
          'run_root rm -f "$tls_cert_tmp" "$tls_key_tmp"',
          `run_root install -m 0640 -o root -g latch-relay ${params.cert} "$tls_cert_tmp"`,
          `run_root install -m 0640 -o root -g latch-relay ${params.key} "$tls_key_tmp"`,
          'run_root mv -f "$tls_cert_tmp" /etc/latch-relay/tls/fullchain.pem',
          'run_root mv -f "$tls_key_tmp" /etc/latch-relay/tls/privkey.pem',
        ].join('\n')
      : ''

  return [
    'set -eu',
    'umask 077',
    'run_root() { if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo -n "$@"; fi; }',
    'run_relay() {',
    '  if [ "$(id -u)" -eq 0 ]; then',
    '    if command -v runuser >/dev/null 2>&1; then runuser -u latch-relay -- "$@"; else su -s /bin/sh latch-relay -c "$*"; fi',
    '  else',
    '    sudo -n -u latch-relay -- "$@"',
    '  fi',
    '}',
    'tmp_tar=$(mktemp /tmp/latch-relay-bundle.XXXXXX.tar.gz)',
    'unit_backup=""',
    'prof_tmp=""',
    'cleanup() {',
    '  rm -f "$tmp_tar" "${unit_backup:-}"',
    '  if [ -n "${stage_dir:-}" ]; then run_root rm -rf "$stage_dir" 2>/dev/null || true; fi',
    '  if [ -n "${prof_tmp:-}" ]; then run_relay rm -f "$prof_tmp" 2>/dev/null || true; fi',
    '}',
    'trap cleanup EXIT',
    'cat > "$tmp_tar"',
    `actual_sha=$(sha256sum "$tmp_tar" | awk '{print $1}')`,
    `if [ "$actual_sha" != "${params.expectedTarSha256}" ]; then echo "BUNDLE_SHA_MISMATCH" >&2; exit 12; fi`,
    'if ! id -u latch-relay >/dev/null 2>&1; then',
    '  run_root useradd --system --home-dir /srv/latch-relay --no-create-home --shell /usr/sbin/nologin latch-relay',
    'fi',
    'run_root install -d -m 0755 /opt/latch-relay /opt/latch-relay/releases',
    'prev_target=""',
    'if [ -L /opt/latch-relay/current ]; then prev_target=$(readlink -f /opt/latch-relay/current || true); fi',
    'if [ -f /etc/systemd/system/latch-relay.service ]; then',
    '  unit_backup=$(mktemp /tmp/latch-relay.unit.bak.XXXXXX)',
    '  run_root cp -p /etc/systemd/system/latch-relay.service "$unit_backup"',
    'fi',
    'was_active=0',
    'if systemctl is-active --quiet latch-relay.service 2>/dev/null; then was_active=1; fi',
    'rollback_release() {',
    '  if [ -n "$prev_target" ] && [ -d "$prev_target" ]; then',
    '    run_root ln -sfn "$prev_target" /opt/latch-relay/current',
    '    if [ -n "$unit_backup" ] && [ -f "$unit_backup" ]; then',
    '      run_root install -m 0644 "$unit_backup" /etc/systemd/system/latch-relay.service',
    '      run_root systemctl daemon-reload 2>/dev/null || true',
    '    fi',
    '    if [ "$was_active" -eq 1 ]; then',
    '      run_root systemctl restart latch-relay.service 2>/dev/null || true',
    '    fi',
    '  fi',
    '}',
    'stage_dir="/opt/latch-relay/releases/.stage-$$"',
    'release_dir="/opt/latch-relay/releases/' + params.expectedTarSha256.slice(0, 16) + '"',
    'run_root rm -rf "$stage_dir"',
    'run_root install -d -m 0755 "$stage_dir"',
    'run_root tar -xzf "$tmp_tar" -C "$stage_dir"',
    'run_root chown -R root:root "$stage_dir"',
    'run_root chmod 0755 "$stage_dir/node" "$stage_dir/latch-relay-tls"',
    'run_root chmod 0644 "$stage_dir/latch-relay.mjs" "$stage_dir/build.json"',
    'if [ ! -d "$release_dir" ]; then run_root mv "$stage_dir" "$release_dir"; else run_root rm -rf "$stage_dir"; fi',
    'stage_dir=""',
    '"$release_dir/latch-relay-tls" version >/dev/null',
    'if [ -L /srv/latch-relay ]; then echo "DATA_DIR_SYMLINK" >&2; exit 13; fi',
    'run_root install -d -m 0700 -o latch-relay -g latch-relay /srv/latch-relay',
    copyCustomTls,
    'if [ -f /srv/latch-relay/relay.json ]; then',
    '  run_relay "$release_dir/node" --disable-sigusr1 "$release_dir/latch-relay.mjs" check --data-dir /srv/latch-relay >/dev/null',
    '  run_root ln -sfn "$release_dir" /opt/latch-relay/current',
    '  if ! run_relay /opt/latch-relay/current/node --disable-sigusr1 /opt/latch-relay/current/latch-relay.mjs check --data-dir /srv/latch-relay >/dev/null; then',
    '    rollback_release',
    '    echo "CANDIDATE_CHECK_FAILED" >&2',
    '    exit 14',
    '  fi',
    'else',
    '  run_root ln -sfn "$release_dir" /opt/latch-relay/current',
    `  run_relay /opt/latch-relay/current/node --disable-sigusr1 /opt/latch-relay/current/latch-relay.mjs init --data-dir /srv/latch-relay ${effectiveInitArgs} >/dev/null`,
    '  run_relay /opt/latch-relay/current/node --disable-sigusr1 /opt/latch-relay/current/latch-relay.mjs check --data-dir /srv/latch-relay >/dev/null',
    'fi',
    'unit_tmp=$(mktemp /tmp/latch-relay.service.XXXXXX)',
    'cat > "$unit_tmp" <<\'EOF\'',
    '[Unit]',
    'Description=Latch Blind Relay',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    'User=latch-relay',
    'Group=latch-relay',
    'WorkingDirectory=/opt/latch-relay/current',
    'ExecStart=/opt/latch-relay/current/node --disable-sigusr1 /opt/latch-relay/current/latch-relay.mjs start --data-dir /srv/latch-relay',
    'Restart=always',
    'RestartSec=2s',
    'TimeoutStopSec=75s',
    'NoNewPrivileges=yes',
    'PrivateTmp=yes',
    'ProtectSystem=strict',
    'ProtectHome=yes',
    'ReadWritePaths=/srv/latch-relay',
    'MemoryAccounting=yes',
    'MemoryMax=512M',
    'LimitNOFILE=65536',
    ...(ambientCaps ? [`AmbientCapabilities=${ambientCaps}`, `CapabilityBoundingSet=${ambientCaps}`] : ['CapabilityBoundingSet=']),
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    'EOF',
    'run_root install -m 0644 "$unit_tmp" /etc/systemd/system/latch-relay.service',
    'rm -f "$unit_tmp"',
    'run_root systemctl daemon-reload',
    'run_root systemctl enable latch-relay.service >/dev/null 2>&1 || true',
    'if ! run_root systemctl restart latch-relay.service; then',
    '  rollback_release',
    '  echo "SERVICE_NOT_READY" >&2',
    '  exit 14',
    'fi',
    'ready=0',
    `for _ in $(seq 1 ${waitSeconds}); do`,
    '  if run_relay /opt/latch-relay/current/node --disable-sigusr1 /opt/latch-relay/current/latch-relay.mjs health --data-dir /srv/latch-relay >/dev/null 2>&1; then',
    '    ready=1; break',
    '  fi',
    '  sleep 1',
    'done',
    'if [ "$ready" -ne 1 ]; then',
    '  rollback_release',
    '  echo "SERVICE_NOT_READY" >&2',
    '  exit 14',
    'fi',
    'prof_tmp="/srv/latch-relay/.export-$$.json"',
    'run_relay rm -f "$prof_tmp"',
    `run_relay /opt/latch-relay/current/node --disable-sigusr1 /opt/latch-relay/current/latch-relay.mjs profile --data-dir /srv/latch-relay --url ${params.originUrl.slice(0, -1)} --output "$prof_tmp" >/dev/null`,
    `printf '%s\\n' '${PROFILE_BEGIN}'`,
    'run_relay cat "$prof_tmp"',
    `printf '%s\\n' '${PROFILE_END}'`,
    'run_relay rm -f "$prof_tmp"',
    'prof_tmp=""',
  ]
    .filter(Boolean)
    .join('\n')
}

export async function runLinuxSetup(
  rawInput: LinuxSetupInput,
  deps: LinuxSetupDeps,
): Promise<{
  out: string
  shownOut: string
  profile: AcceptedRelayProfile
  keyHash: string
  mode: LinuxDeployMode
  acceptance: LinuxAcceptanceItem[]
  proxySnippets?: { caddy: string; nginx: string }
}> {
  const serverTrimmed = rawInput.server.trim()
  if (!serverTrimmed || serverTrimmed.startsWith('-') || !SSH_TARGET.test(serverTrimmed))
    throw new LinuxSetupError('无效的 SSH 服务器目标（应形如 user@example.com 或 root@203.0.113.10）')
  const sshTarget = { server: serverTrimmed, ...(rawInput.sshPort ? { sshPort: rawInput.sshPort } : {}) }
  const sshHost = extractSshHost(serverTrimmed)
  const needsIpLookup = !rawInput.domain?.trim() && !rawInput.ip?.trim() && isIP(sshHost) === 0
  const resolvedIp = needsIpLookup ? await deps.resolveServerIp?.(sshTarget) : undefined

  const normalized = normalizeLinuxSetupInput(rawInput, resolvedIp)
  const { out, shown, existed } = await resolveLinuxOutput(normalized.name, rawInput.out, rawInput.home, Boolean(rawInput.upgrade))

  deps.progress(`连接服务器 ${normalized.server} 检查系统环境`)
  const probe = await deps.ssh(sshTarget, buildRemoteProbeScript())
  if (probe.code !== 0)
    throw new LinuxSetupError(`无法通过 SSH 登录 ${normalized.server}（退出码 ${probe.code}）。请确认 SSH 免密密钥或连接可用。`)

  let hostInfo: {
    os: string
    arch: string
    uid: number
    sudo: number
    systemd: number
    port443Busy?: number
    existingPort?: number
    existingBehindProxy?: number
  }
  try {
    hostInfo = JSON.parse(probe.stdout.trim().split('\n').at(-1) ?? '') as typeof hostInfo
  } catch {
    throw new LinuxSetupError('无法解析远端服务器的环境探测结果')
  }
  if (hostInfo.os !== 'Linux') throw new LinuxSetupError(`目标服务器不是 Linux（检测到 ${hostInfo.os}）`)
  const arch: LinuxArch | undefined =
    hostInfo.arch === 'x86_64' || hostInfo.arch === 'amd64'
      ? 'amd64'
      : hostInfo.arch === 'aarch64' || hostInfo.arch === 'arm64'
        ? 'arm64'
        : undefined
  if (!arch) throw new LinuxSetupError(`暂不支持该 Linux 架构（${hostInfo.arch}），仅支持 x86_64/amd64 与 aarch64/arm64`)
  if (hostInfo.uid !== 0 && hostInfo.sudo !== 1)
    throw new LinuxSetupError('远端账号需要是 root 或具备免密 sudo 权限以安装 systemd 系统服务')
  if (hostInfo.systemd !== 1)
    throw new LinuxSetupError('远端服务器未运行 systemd；请使用仓库提供的 deploy/compose.standalone.yaml 以容器方式部署')

  const existingPort =
    typeof hostInfo.existingPort === 'number'
    && Number.isInteger(hostInfo.existingPort)
    && hostInfo.existingPort >= 1
    && hostInfo.existingPort <= 65535
      ? hostInfo.existingPort
      : 0
  if (existingPort > 0) {
    if (hostInfo.existingBehindProxy === 1 && normalized.mode !== 'behind-proxy') {
      normalized.mode = 'behind-proxy'
      normalized.listenPort = rawInput.port ?? existingPort
      normalized.publicPort = rawInput.publicPort ?? 443
      normalized.origin = publicOrigin(normalized.target, normalized.publicPort)
    } else if (rawInput.port === undefined) {
      normalized.listenPort = existingPort
      if (normalized.mode !== 'behind-proxy') {
        normalized.publicPort = existingPort
        normalized.origin = publicOrigin(normalized.target, existingPort)
      }
    }
  } else if (!rawInput.upgrade && normalized.mode === 'self-ip' && rawInput.port === undefined && hostInfo.port443Busy === 1) {
    // On a fresh bare-IP install without an explicit `--port`, prefer `:443` and fall back to `:8443` only when another service holds `:443`.
    normalized.listenPort = 8443
    normalized.publicPort = 8443
    normalized.origin = publicOrigin(normalized.target, 8443)
    deps.progress('检测到服务器 443 端口已被占用，自动切换至 8443 端口（请确保云安全组放行 TCP 8443）')
  }

  const bundle = rawInput.bundlePath ? await deps.readBundle(rawInput.bundlePath) : await deps.buildBundle(arch)

  deps.progress(
    normalized.mode === 'self-ip'
      ? `上传 Linux（${arch}）发布包并以无域名 IP 模式启动（${normalized.origin}，证书公钥强绑定且到期自动续签）`
      : normalized.mode === 'acme'
        ? `上传 Linux（${arch}）发布包、启动服务并自动申请 TLS 证书（${normalized.target}）`
        : normalized.mode === 'behind-proxy'
          ? `上传 Linux（${arch}）发布包并启动回环服务（127.0.0.1:${normalized.listenPort}）`
          : `上传 Linux（${arch}）发布包并使用指定证书启动服务`,
  )
  const install = await deps.ssh(
    sshTarget,
    buildRemoteInstallScript({
      expectedTarSha256: bundle.sha256,
      target: normalized.target,
      mode: normalized.mode,
      listenPort: normalized.listenPort,
      publicPort: normalized.publicPort,
      originUrl: normalized.origin,
      cert: normalized.cert,
      key: normalized.key,
      acmeEmail: normalized.acmeEmail,
    }),
    bundle.tarball,
  )
  if (install.code !== 0) {
    if (install.stderr.includes('SERVICE_NOT_READY')) {
      throw new LinuxSetupError(
        normalized.mode === 'acme'
          ? `服务已安装，但未能在 45 秒内完成自动证书签发与就绪检查。请确认域名 ${normalized.target} 已解析到这台服务器且公网 TCP ${normalized.listenPort} 端口已放行。`
          : '服务启动后未通过本机健康检查；请在服务器上运行 journalctl -u latch-relay 检查状态。',
      )
    }
    throw new LinuxSetupError(`远端安装未完成（SSH 退出码 ${install.code}）`)
  }

  const startIdx = install.stdout.indexOf(PROFILE_BEGIN)
  const endIdx = install.stdout.indexOf(PROFILE_END)
  if (startIdx < 0 || endIdx <= startIdx) throw new LinuxSetupError('未能从服务器导出有效的中继连接配置')
  const rawProfileJson = `${install.stdout.slice(startIdx + PROFILE_BEGIN.length, endIdx).trim()}\n`
  let exportedProfile: AcceptedRelayProfile
  try {
    exportedProfile = exportedFileSchema.parse(JSON.parse(rawProfileJson) as unknown).profile
  } catch {
    throw new LinuxSetupError('导出的中继连接配置校验失败')
  }

  if (!existed) {
    await writeNewPrivateFile(out, rawProfileJson)
    deps.progress(`已写入私密连接配置 ${shown}（0600，注册令牌只保存在本机文件中）`)
  } else {
    deps.progress(`已平滑升级远端服务并保留现有配置 ${shown}（节点身份与已配对设备不变）`)
  }
  const keyHash =
    'relayKey' in exportedProfile
      ? createHash('sha256').update(Buffer.from(exportedProfile.relayKey, 'hex')).digest('hex').slice(0, 8)
      : exportedProfile.spkiHash.slice(0, 8)
  deps.progress(`地址：${exportedProfile.url}`)
  deps.progress(`密钥短哈希：${keyHash}`)

  const proxySnippets =
    normalized.mode === 'behind-proxy'
      ? buildReverseProxySnippets(normalized.target, normalized.publicPort, normalized.listenPort)
      : undefined

  let acceptance: LinuxAcceptanceItem[] = []
  if (!rawInput.skipAccept) {
    deps.progress('从这台电脑运行端到端连接、验签与转发验收')
    acceptance = await deps.accept(exportedProfile)
    const failed = acceptance.some(item => item.result === 'fail')
    if (failed && normalized.mode === 'behind-proxy') {
      deps.progress('提示：反向代理尚未转发该域名时外网验收会失败；请将下方配置加入 Caddy 或 Nginx 并重载后再连接：')
      deps.progress(`\n# Caddyfile\n${proxySnippets!.caddy}\n\n# Nginx\n${proxySnippets!.nginx}\n`)
    }
    if (failed && normalized.mode === 'self-ip') {
      deps.progress(`提示：请确认云厂商安全组与服务器防火墙已放行 TCP ${normalized.listenPort} 端口。`)
    }
    if (failed) throw new LinuxSetupError('远端中继尚未通过公网验收；配置文件已保存，放行端口或重载反代后可直接在设置中核对并连接')
  } else if (proxySnippets) {
    deps.progress(
      `\n请将以下反向代理配置加入服务器的 Caddy 或 Nginx 并重载：\n\n# Caddyfile\n${proxySnippets.caddy}\n\n# Nginx\n${proxySnippets.nginx}\n`,
    )
  }

  return {
    out,
    shownOut: shown,
    profile: exportedProfile,
    keyHash,
    mode: normalized.mode,
    acceptance,
    ...(proxySnippets ? { proxySnippets } : {}),
  }
}

function formatGiB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`
}

export async function runLinuxRemoteStatus(input: { server: string; sshPort?: number }, ssh: LinuxSetupDeps['ssh']): Promise<string[]> {
  const server = input.server.trim()
  if (!server || server.startsWith('-') || !SSH_TARGET.test(server)) throw new LinuxSetupError('无效的 SSH 服务器目标')
  const script = [
    'set -eu',
    'run_relay() {',
    '  if [ "$(id -u)" -eq 0 ]; then',
    '    if command -v runuser >/dev/null 2>&1; then runuser -u latch-relay -- "$@"; else su -s /bin/sh latch-relay -c "$*"; fi',
    '  else',
    '    sudo -n -u latch-relay -- "$@"',
    '  fi',
    '}',
    'svc=$(systemctl is-active latch-relay.service 2>/dev/null || true)',
    'printf "SVC=%s\\n" "$svc"',
    'if [ -x /opt/latch-relay/current/node ] && [ -d /srv/latch-relay ]; then',
    '  run_relay /opt/latch-relay/current/node --disable-sigusr1 /opt/latch-relay/current/latch-relay.mjs status --data-dir /srv/latch-relay 2>/dev/null || true',
    'fi',
  ].join('\n')
  const res = await ssh({ server, ...(input.sshPort ? { sshPort: input.sshPort } : {}) }, script)
  if (res.code !== 0) throw new LinuxSetupError(`无法通过 SSH 查询 ${server} 状态（退出码 ${res.code}）`)
  const lines = res.stdout.trim().split('\n').filter(Boolean)
  const svcLine = lines.find(l => l.startsWith('SVC='))?.slice(4) || 'unknown'
  const jsonLine = lines.find(l => l.startsWith('{'))
  if (!jsonLine) return [`服务状态：${svcLine}`, '运行详情：未获取到（服务未启动或尚未安装）']
  const parsed = JSON.parse(jsonLine) as {
    ready?: boolean
    routes?: number
    connections?: number
    certificate?: { daysRemaining: number; renewalWarning: boolean }
    quota?: { monthlyUsed: number; monthlyBytes: number; admission: boolean }
  }
  const out = [
    `服务状态：${svcLine}（${parsed.ready ? '就绪' : '未就绪'}）`,
    `活跃路由 / 连接：${parsed.routes ?? 0} 条路由 · ${parsed.connections ?? 0} 条连接`,
  ]
  if (parsed.certificate) {
    out.push(`TLS 证书剩余有效期：${parsed.certificate.daysRemaining} 天${parsed.certificate.renewalWarning ? '（即将续期）' : ''}`)
  }
  if (parsed.quota) {
    out.push(
      `当月转发流量：${formatGiB(parsed.quota.monthlyUsed)} / ${formatGiB(parsed.quota.monthlyBytes)}（${parsed.quota.admission ? '正常放行' : '已触发配额保护'}）`,
    )
  }
  return out
}

export async function runLinuxUninstall(
  input: { server: string; sshPort?: number; purgeData?: boolean },
  ssh: LinuxSetupDeps['ssh'],
): Promise<string> {
  const server = input.server.trim()
  if (!server || server.startsWith('-') || !SSH_TARGET.test(server)) throw new LinuxSetupError('无效的 SSH 服务器目标')
  const script = [
    'set -eu',
    'run_root() { if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo -n "$@"; fi; }',
    'run_root systemctl stop latch-relay.service 2>/dev/null || true',
    'run_root systemctl disable latch-relay.service 2>/dev/null || true',
    'run_root rm -f /etc/systemd/system/latch-relay.service',
    'run_root systemctl daemon-reload 2>/dev/null || true',
    'run_root rm -rf /opt/latch-relay',
    ...(input.purgeData
      ? ['run_root rm -rf /srv/latch-relay /etc/latch-relay', 'if id -u latch-relay >/dev/null 2>&1; then run_root userdel latch-relay; fi']
      : []),
  ].join('\n')
  const res = await ssh({ server, ...(input.sshPort ? { sshPort: input.sshPort } : {}) }, script)
  if (res.code !== 0) throw new LinuxSetupError(`卸载远端服务失败（SSH 退出码 ${res.code}）`)
  return input.purgeData
    ? `已从 ${server} 卸载 latch-relay 服务并清除 /srv/latch-relay 数据目录。`
    : `已从 ${server} 卸载 latch-relay 程序与系统服务（保留 /srv/latch-relay 密钥与数据，如需彻底删除请加 --purge-data）。`
}
