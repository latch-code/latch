import { expect, it } from 'vitest'
import { relayOrigin, relaySetupCommands } from '../src/settings/relayCommands.ts'

it('builds one Workers command from the name and location, and none from a name a path could not hold', () => {
  expect(relaySetupCommands('edge', { latch: 'pnpm latch', name: 'home' }).deploy).toEqual([
    'pnpm latch relay setup cloudflare --name home',
  ])
  expect(relaySetupCommands('edge', { name: 'home', location: 'apac-ne' }).deploy).toEqual([
    'latch relay setup cloudflare --name home --location apac-ne',
  ])
  for (const name of ['', 'Home', 'a b', 'x;rm', '-a', 'a'.repeat(41)]) expect(relaySetupCommands('edge', { name }).deploy).toEqual([])
  expect(relaySetupCommands('edge', { name: 'home', location: 'tokyo; rm' as never }).deploy).toEqual([
    'latch relay setup cloudflare --name home',
  ])
})

it('turns the Linux server form into one Mac setup command across bare-IP, auto-TLS, reverse-proxy and custom-TLS modes', () => {
  // Zero-domain bare IP: leaving `domain` blank uses the server IP directly!
  expect(
    relaySetupCommands('self', {
      latch: 'pnpm latch',
      server: 'root@203.0.113.10',
      domain: '',
    }).deploy,
  ).toEqual(['pnpm latch relay setup linux --server root@203.0.113.10'])

  // SSH alias + explicit public IP in `domain` passes `--ip`:
  expect(
    relaySetupCommands('self', {
      latch: 'pnpm latch',
      server: 'my-vps',
      domain: '203.0.113.10',
    }).deploy,
  ).toEqual(['pnpm latch relay setup linux --server my-vps --ip 203.0.113.10'])

  expect(
    relaySetupCommands('self', {
      latch: 'pnpm latch',
      server: 'me@relay.example.com',
      domain: 'relay.example.com',
    }),
  ).toEqual({
    login: [],
    deploy: ['pnpm latch relay setup linux --server me@relay.example.com --domain relay.example.com'],
    fetch: [],
  })

  expect(
    relaySetupCommands('self', {
      server: 'me@relay.example.com',
      domain: 'relay.example.com',
      tlsMode: 'proxy',
    }).deploy,
  ).toEqual(['latch relay setup linux --server me@relay.example.com --domain relay.example.com --behind-proxy'])

  const customForm = {
    tlsMode: 'custom' as const,
    server: 'me@relay.example.com',
    domain: 'relay.example.com',
    port: '8443',
    cert: '/etc/ssl/chain.pem',
    key: '/etc/ssl/key.pem',
  }
  expect(relaySetupCommands('self', customForm).deploy).toEqual([
    'latch relay setup linux --server me@relay.example.com --domain relay.example.com --cert /etc/ssl/chain.pem --key /etc/ssl/key.pem',
  ])

  for (const bad of [
    { domain: 'Relay.example.com' },
    { domain: 'a_b.example.com' },
    { port: '0' },
    { cert: 'chain.pem' },
    { key: '/etc/ssl/$(id)' },
    { server: '-oProxyCommand=id' },
    { server: 'me@host; id' },
  ])
    expect(relaySetupCommands('self', { ...customForm, ...bad }).deploy).toEqual([])
  expect(relayOrigin('relay.example.com', '443')).toBe('https://relay.example.com')
})
