/** Build tools inherit paths and caches, never Host credentials or compiler/preload overrides. */
export function relayGoEnvironment(arch?: 'amd64' | 'arm64'): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { GOTOOLCHAIN: 'local', GOPROXY: 'off', GOSUMDB: 'off', GOWORK: 'off', CGO_ENABLED: '0' }
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'GOCACHE', 'GOPATH', 'GOMODCACHE'])
    if (process.env[key]) environment[key] = process.env[key]
  if (arch) {
    environment.GOOS = 'linux'
    environment.GOARCH = arch
  }
  return environment
}
