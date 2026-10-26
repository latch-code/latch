import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, writeFile, copyFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { relayGoEnvironment } from '../scripts/go-environment.ts'
const execute = promisify(execFile)
it.skipIf(!['linux', 'darwin'].includes(process.platform))(
  'sets and reads back the actual TCP keepalive probes on a local accepted socket',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-relay-keepalive-'))
    try {
      const source = await readFile(fileURLToPath(new URL('../gateway/main.go', import.meta.url)), 'utf8')
      if (!source.includes('func main() {')) throw new Error('Gateway entry not found')
      await writeFile(join(root, 'production.go'), source.replace('func main() {', 'func gatewayProcessMain() {'))
      await copyFile(fileURLToPath(new URL('../gateway/supervisor.go', import.meta.url)), join(root, 'supervisor.go'))
      const idle = process.platform === 'darwin' ? 'TCP_KEEPALIVE' : 'TCP_KEEPIDLE'
      await writeFile(
        join(root, 'fixture.go'),
        `package main
import("net";"os";"encoding/json";"syscall")
func main(){listener,err:=net.ListenTCP("tcp4",&net.TCPAddr{IP:net.ParseIP("127.0.0.1")});if err!=nil{panic("Fixture bind")};defer listener.Close();client,err:=net.DialTCP("tcp4",nil,listener.Addr().(*net.TCPAddr));if err!=nil{panic("Fixture dial")};defer client.Close();server,err:=listener.AcceptTCP();if err!=nil{panic("Fixture accept")};defer server.Close();if configureRelayTCP(server)!=nil{panic("Keepalive configuration")};raw,err:=server.SyscallConn();if err!=nil{panic("Fixture descriptor")};values:=map[string]int{};err=raw.Control(func(fd uintptr){for key,option:=range map[string]int{"idle":syscall.${idle},"interval":syscall.TCP_KEEPINTVL,"count":syscall.TCP_KEEPCNT}{value,e:=syscall.GetsockoptInt(int(fd),syscall.IPPROTO_TCP,option);if e!=nil{panic("Fixture TCP option")};values[key]=value};enabled,e:=syscall.GetsockoptInt(int(fd),syscall.SOL_SOCKET,syscall.SO_KEEPALIVE);if e!=nil{panic("Fixture enabled option")};values["enabled"]=enabled});if err!=nil{panic("Fixture descriptor access")};a,b:=net.Pipe();defer a.Close();defer b.Close();if configureRelayTCP(a)!=nil{values["nonTcpRejected"]=1};_=json.NewEncoder(os.Stdout).Encode(values)}
`,
      )
      const binary = join(root, 'keepalive-probe')
      await execute(
        process.env.LATCH_RELAY_GO ?? 'go',
        ['build', '-trimpath', '-o', binary, join(root, 'production.go'), join(root, 'supervisor.go'), join(root, 'fixture.go')],
        { env: relayGoEnvironment(), timeout: 60000 },
      )
      const observed: unknown = JSON.parse((await execute(binary, [], { env: {}, timeout: 3000 })).stdout)
      expect(observed).toEqual({ idle: 60, interval: 15, count: 4, enabled: expect.any(Number), nonTcpRejected: 1 })
      // BSD returns the SO_KEEPALIVE bit (8); Linux returns 1. Both must be nonzero.
      expect(observed).not.toMatchObject({ enabled: 0 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  65000,
)
