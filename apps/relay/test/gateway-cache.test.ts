import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, writeFile, copyFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { relayGoEnvironment } from '../scripts/go-environment.ts'
const execute = promisify(execFile)
it('keeps rejected /48 source rotation allocation-free and admits another /48 after bounded inactive-cache churn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'latch-relay-cache-'))
  try {
    // Compile the actual Go module with only its process entry renamed; assertions stay in Vitest.
    const source = await readFile(fileURLToPath(new URL('../gateway/main.go', import.meta.url)), 'utf8')
    if (!source.includes('func main() {')) throw new Error('Gateway entry not found')
    await writeFile(join(root, 'production.go'), source.replace('func main() {', 'func gatewayProcessMain() {'))
    await copyFile(fileURLToPath(new URL('../gateway/supervisor.go', import.meta.url)), join(root, 'supervisor.go'))
    await writeFile(
      join(root, 'fixture.go'),
      `package main
import("net";"time";"io";"os";"encoding/json";"container/list";"fmt";"net/netip")
type peer struct{ip string};func(p *peer)Read(b []byte)(int,error){return 0,io.EOF};func(p *peer)Write(b []byte)(int,error){return len(b),nil};func(p *peer)Close()error{return nil};func(p *peer)LocalAddr()net.Addr{return &net.TCPAddr{IP:net.ParseIP("::1"),Port:443}};func(p *peer)RemoteAddr()net.Addr{return &net.TCPAddr{IP:net.ParseIP(p.ip),Port:1}};func(p *peer)SetDeadline(time.Time)error{return nil};func(p *peer)SetReadDeadline(time.Time)error{return nil};func(p *peer)SetWriteDeadline(time.Time)error{return nil}
func makeGateway(now time.Time)*gateway{return &gateway{cfg:config{MaxConnections:8,MaxHandshakes:8,HandshakesPerSecond:1000,HandshakeBurst:8,PrefixFraction:0.5},connections:make(map[net.Conn]struct{}),groups:make(map[netip.Prefix]*bucket),idle:list.New(),global:bucket{tokens:8,at:now}}}
func main(){now:=time.Now();g:=makeGateway(now);accepted:=0;peak:=0;for i:=0;i<200;i++{p:=&peer{ip:fmt.Sprintf("2001:db8:1:%x::1",i)};groups,ok:=g.admit(p,now.Add(time.Duration(i)*time.Second));if ok{accepted++;g.handshakeFinished(groups);g.release(p,groups)};peak=max(peak,len(g.groups))};_,outsider:=g.admit(&peer{ip:"2001:db8:2::1"},now.Add(201*time.Second));f:=makeGateway(now);for i:=0;i<4;i++{_,_=f.admit(&peer{ip:fmt.Sprintf("2001:db8:1:%x::1",i)},now)};before:=len(f.groups);rejected:=0;for i:=4;i<1004;i++{if _,ok:=f.admit(&peer{ip:fmt.Sprintf("2001:db8:1:%x::1",i)},now);!ok{rejected++}};_,independent:=f.admit(&peer{ip:"2001:db8:2::1"},now);_=json.NewEncoder(os.Stdout).Encode(map[string]any{"accepted":accepted,"peak":peak,"outsider":outsider,"rejected":rejected,"growth":len(f.groups)-before,"independent":independent})}
`,
    )
    const binary = join(root, 'cache-probe')
    await execute(
      process.env.LATCH_RELAY_GO ?? 'go',
      ['build', '-trimpath', '-o', binary, join(root, 'production.go'), join(root, 'supervisor.go'), join(root, 'fixture.go')],
      { env: relayGoEnvironment(), timeout: 60000 },
    )
    const observed = JSON.parse((await execute(binary, [], { env: {}, timeout: 3000 })).stdout)
    expect(observed).toMatchObject({ accepted: 200, outsider: true, rejected: 1000, independent: true })
    expect(observed.peak).toBeLessThanOrEqual(32)
    // Only the independent /48's /48, /56 and /64 are new; rejected attempts created none.
    expect(observed.growth).toBe(3)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 65000)
